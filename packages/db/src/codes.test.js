/* One-time codes, against a real database.
 *
 * The sibling of passwords.test.js, and mostly about refusals for the same reason — this is the
 * second feature in GymYar where a bug hands somebody an account. It has one worry that file
 * does not: the secret is six digits long, so "how many times may somebody guess" and "how many
 * messages may one number be sent" are load-bearing, and both are tested here rather than left
 * to the rate limiter in front of them.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { setupDb, truncateUsers, teardownDb } from './test-helpers.js'
import {
  requestCode, claimCode, purgeDeadCodes, liveCodeFor, mintCode,
  CODE_TTL_MS, MAX_ATTEMPTS, RESEND_COOLDOWN_MS, DAILY_CAP, _resetKey
} from './codes.js'
import { createUser, findUserByPhone, publicUser } from './users.js'
import { db } from './index.js'

const PHONE = '+989123456789'
const OTHER = '+989121112233'

beforeAll(async () => {
  // The key is derived from this at first use — a code hashed with nothing would be a code
  // stored in the clear, and the module refuses rather than doing that.
  process.env.SESSION_SECRET ||= 'test-secret-not-for-production'
  _resetKey()
  await setupDb()
})
beforeEach(async () => { await truncateUsers() })
afterAll(async () => { await teardownDb() })

/* Time is a parameter everywhere in this module, so nothing here sleeps. */
const later = ms => Date.now() + ms

describe('minting a code', () => {
  it('hands back six digits and stores something that is not them', async () => {
    const { ok, code } = await requestCode({ address: PHONE })
    expect(ok).toBe(true)
    expect(code).toMatch(/^\d{6}$/)

    const [row] = await db()`select * from verification_codes where address = ${PHONE}`
    // The whole point: a dump of this table contains nothing anybody can type in.
    expect(row.code_hash).not.toBe(code)
    expect(row.code_hash).not.toContain(code)
    expect(row.address).toBe(PHONE)
    expect(row.channel).toBe('sms')
  })

  it('mints a different code most of the time', async () => {
    // A million-wide space, so a collision in five draws is possible and vanishingly unlikely;
    // what this is really checking is that the code is not a constant.
    const seen = new Set(Array.from({ length: 200 }, () => mintCode()))
    expect(seen.size).toBeGreaterThan(150)
    expect([...seen].every(c => /^\d{6}$/.test(c))).toBe(true)
  })

  it('leaves only the newest code working', async () => {
    const first = await requestCode({ address: PHONE })
    const second = await requestCode({ address: PHONE, now: later(RESEND_COOLDOWN_MS) })

    expect(await liveCodeFor(PHONE)).toBe(1)
    // The first one is sitting in a notification that no longer opens anything.
    expect(await claimCode({ address: PHONE, code: first.code })).toMatchObject({ ok: false })
    expect(await claimCode({ address: PHONE, code: second.code })).toMatchObject({ ok: true })
  })
})

describe('spending a code', () => {
  it('accepts the right one, once', async () => {
    const { code } = await requestCode({ address: PHONE, purpose: 'signup' })
    expect(await claimCode({ address: PHONE, code })).toMatchObject({ ok: true, purpose: 'signup' })
    // A double-tap, a retried request, a mail client prefetching — the second one gets nothing.
    expect(await claimCode({ address: PHONE, code })).toMatchObject({ ok: false, reason: 'none' })
  })

  it('keeps a leading zero, and spends such a code like any other', async () => {
    /* `000123` is one code in ten. It is six characters here and would be three if this were
     * ever treated as a number, which is the shape of bug that passes review and fails for a
     * tenth of the people who sign up. */
    const zeroed = Array.from({ length: 400 }, () => mintCode()).filter(c => c.startsWith('0'))
    expect(zeroed.length).toBeGreaterThan(0)
    expect(zeroed.every(c => c.length === 6)).toBe(true)

    // The hash is over strings on both sides, so a code is spent by what was texted.
    const { code } = await requestCode({ address: PHONE })
    expect(await claimCode({ address: PHONE, code: String(code) })).toMatchObject({ ok: true })
  })

  it('refuses a code minted for a different number', async () => {
    const { code } = await requestCode({ address: PHONE })
    await requestCode({ address: OTHER })
    // The number is inside the hash, so this cannot match even by coincidence of digits.
    expect(await claimCode({ address: OTHER, code })).toMatchObject({ ok: false, reason: 'wrong' })
  })

  it('refuses one that has expired', async () => {
    const { code } = await requestCode({ address: PHONE })
    expect(await claimCode({ address: PHONE, code, now: later(CODE_TTL_MS + 1) }))
      .toMatchObject({ ok: false, reason: 'expired' })
  })

  it('refuses when nothing was ever sent', async () => {
    expect(await claimCode({ address: PHONE, code: '123456' })).toMatchObject({ ok: false, reason: 'none' })
  })

  it('counts guesses down and then kills the code', async () => {
    const { code } = await requestCode({ address: PHONE })
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0')

    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const r = await claimCode({ address: PHONE, code: wrong })
      expect(r).toMatchObject({ ok: false, reason: 'wrong', attemptsLeft: MAX_ATTEMPTS - i })
    }
    // Dead, and the real code does not bring it back — which is the property that matters: the
    // number of guesses one code faces is a constant, not however many requests get through.
    expect(await claimCode({ address: PHONE, code })).toMatchObject({ ok: false })
    expect(await liveCodeFor(PHONE)).toBe(0)
  })

  it('lets exactly one of two simultaneous claims win', async () => {
    const { code } = await requestCode({ address: PHONE })
    const [a, b] = await Promise.all([
      claimCode({ address: PHONE, code }),
      claimCode({ address: PHONE, code })
    ])
    // A signup that let both through would be two accounts on one number.
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
  })
})

describe('how often a number may be texted', () => {
  it('refuses a resend inside the cooldown, and says how long', async () => {
    await requestCode({ address: PHONE })
    const again = await requestCode({ address: PHONE, now: later(10_000) })
    expect(again).toMatchObject({ ok: false, reason: 'cooldown' })
    expect(again.retryAfter).toBeGreaterThan(0)
    expect(again.retryAfter).toBeLessThanOrEqual(RESEND_COOLDOWN_MS / 1000)
  })

  it('allows one after the cooldown', async () => {
    await requestCode({ address: PHONE })
    expect(await requestCode({ address: PHONE, now: later(RESEND_COOLDOWN_MS) })).toMatchObject({ ok: true })
  })

  it('stops at the daily ceiling, however patient the caller is', async () => {
    let now = Date.now()
    for (let i = 0; i < DAILY_CAP; i++) {
      expect(await requestCode({ address: PHONE, now }), `message ${i + 1}`).toMatchObject({ ok: true })
      now += RESEND_COOLDOWN_MS
    }
    // This is the ceiling that matters: it is somebody else's phone being buzzed, and it is
    // the operator's SMS bill.
    expect(await requestCode({ address: PHONE, now })).toMatchObject({ ok: false, reason: 'daily' })
  })

  it('counts per number, so one flood does not silence everybody else', async () => {
    let now = Date.now()
    for (let i = 0; i < DAILY_CAP; i++) { await requestCode({ address: PHONE, now }); now += RESEND_COOLDOWN_MS }
    expect(await requestCode({ address: OTHER, now })).toMatchObject({ ok: true })
  })

  it('lets the day roll over', async () => {
    let now = Date.now()
    for (let i = 0; i < DAILY_CAP; i++) { await requestCode({ address: PHONE, now }); now += RESEND_COOLDOWN_MS }
    expect(await requestCode({ address: PHONE, now: now + 24 * 60 * 60 * 1000 })).toMatchObject({ ok: true })
  })
})

describe('two channels in one table', () => {
  const ADDR = 'sam@x.test'

  it('keeps a code for an address separate from a code for a number', async () => {
    const sms = await requestCode({ channel: 'sms', address: PHONE })
    const mail = await requestCode({ channel: 'email', address: ADDR })

    // Each spends only on its own channel, even though both are live at once.
    expect(await claimCode({ channel: 'email', address: ADDR, code: sms.code })).toMatchObject({ ok: false })
    expect(await claimCode({ channel: 'sms', address: PHONE, code: sms.code })).toMatchObject({ ok: true })
    expect(await claimCode({ channel: 'email', address: ADDR, code: mail.code })).toMatchObject({ ok: true })
  })

  it('does not let a code for one channel be spent on the other, even with the same address', async () => {
    /* Contrived, and the reason the channel is inside the hash: nothing stops the two columns
     * holding the same string, and a code that works on whichever channel asks first is a
     * check that has stopped checking anything. */
    const a = await requestCode({ channel: 'sms', address: ADDR })
    expect(await claimCode({ channel: 'email', address: ADDR, code: a.code })).toMatchObject({ ok: false })
  })

  it('counts the cooldown per channel, so confirming an address does not block a sign-in code', async () => {
    await requestCode({ channel: 'sms', address: PHONE })
    expect(await requestCode({ channel: 'email', address: ADDR })).toMatchObject({ ok: true })
    // ...and the same destination on the same channel is still held to the cooldown.
    expect(await requestCode({ channel: 'email', address: ADDR })).toMatchObject({ ok: false, reason: 'cooldown' })
  })

  it('refuses a channel it does not have', async () => {
    await expect(requestCode({ channel: 'carrier-pigeon', address: ADDR })).rejects.toThrow(/unknown channel/)
  })
})

describe('sweeping', () => {
  it('keeps dead rows for a day, because the ceilings are counted off them', async () => {
    const { code } = await requestCode({ address: PHONE })
    await claimCode({ address: PHONE, code })

    expect(await purgeDeadCodes()).toBe(0)
    const [{ n }] = await db()`select count(*)::int as n from verification_codes`
    expect(n).toBe(1)
  })

  it('takes them away after that', async () => {
    const { code } = await requestCode({ address: PHONE })
    await claimCode({ address: PHONE, code })
    expect(await purgeDeadCodes({ now: later(25 * 60 * 60 * 1000) })).toBe(1)
  })

  it('leaves a live code alone', async () => {
    await requestCode({ address: PHONE })
    expect(await purgeDeadCodes()).toBe(0)
    expect(await liveCodeFor(PHONE)).toBe(1)
  })
})

describe('a number on an account', () => {
  it('is stored canonically, found by that, and marked verified on the way in', async () => {
    const u = await createUser({ name: 'Sam', phone: PHONE })
    expect(u.phone).toBe(PHONE)
    // There is no path that writes the column unverified — see createUser.
    expect(u.phone_verified_at).toBeTruthy()
    expect((await findUserByPhone(PHONE)).id).toBe(u.id)
    expect(await findUserByPhone(OTHER)).toBe(null)
    expect(publicUser(u).phone).toBe(PHONE)
  })

  it('belongs to one account', async () => {
    await createUser({ name: 'Sam', phone: PHONE })
    await expect(createUser({ name: 'Imposter', phone: PHONE })).rejects.toThrow()
  })

  it('does not collide with every other account that has no number', async () => {
    // The index is partial, exactly like the one on email above it.
    await createUser({ name: 'A' })
    await createUser({ name: 'B' })
    const [{ n }] = await db()`select count(*)::int as n from users where phone is null`
    expect(n).toBe(2)
  })
})
