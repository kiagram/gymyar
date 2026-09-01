/* Signing up and signing in with a phone number, through the real routes.
 *
 * The gateway is `SMS_TRANSPORT=log`, which is a real transport rather than a mock — the code
 * this suite types back is read out of the log line the operator of a household instance would
 * read it out of. So what is exercised here is the whole path: normalisation, the OTP table, the
 * ceilings, the session cookie, and the one thing no unit test can check — that a number typed
 * one way and a number typed another way land on the same account.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { build } from './app.js'
import { client } from './test-client.js'
import { db, close } from '@gymyar/db'
import { MAX_ATTEMPTS, DAILY_CAP } from '@gymyar/db/phone-codes.js'
import { config } from './config.js'

let app
const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL

/* Every code the instance "sent", in order. The log transport writes one line per message with
 * the code in it — see packages/sms/src/index.js — so this is the handset. */
const sent = []
/* A pino stream rather than a fake logger object: `build()` hands whatever it is given straight
 * to Fastify, and Fastify wants a configuration object. So this is the real logger writing real
 * lines, and the test reads the code out of one the way an operator would. */
const logger = {
  level: 'info',
  stream: {
    write(line) {
      let rec = null
      try { rec = JSON.parse(line) } catch { return }
      if (rec?.code) sent.push(rec)
    }
  }
}

beforeAll(async () => {
  process.env.SESSION_SECRET = 'test-secret-not-for-production'
  process.env.SMS_TRANSPORT = 'log'
  app = await build({ logger, databaseUrl: URL, rateLimit: false })
  const { seedExercises } = await import('@gymyar/db/seed-exercises.js')
  await seedExercises()
})
beforeEach(async () => {
  await db()`delete from users`
  await db()`delete from phone_codes`
  await db()`delete from invites`
  sent.length = 0
  config.inviteOnly = false
})
afterAll(async () => {
  await app.close(); await close()
  delete process.env.SMS_TRANSPORT
})

const PHONE = '09123456789'
const CANON = '+989123456789'

/** Ask for a code and read it off the wire. Returns the client that asked, and the code. */
async function codeFor(phone = PHONE, c = client(app)) {
  const r = await c.post('/api/phone/start', { phone })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return { c, code: sent.at(-1).code, body: r.body }
}

describe('asking for a code', () => {
  it('sends one, and says how long it lasts and when a resend is allowed', async () => {
    const { body } = await codeFor()
    expect(body).toMatchObject({ ok: true, expiresIn: 300, resendIn: 60 })
    expect(sent).toHaveLength(1)
    // The gateway is handed E.164, whatever the person typed.
    expect(sent[0].to).toBe(CANON)
    expect(sent[0].code).toMatch(/^\d{6}$/)
  })

  it('writes the message in the language of the screen that asked', async () => {
    await client(app).post('/api/phone/start', { phone: PHONE, locale: 'en' })
    expect(sent.at(-1).body).toMatch(/is your GymYar code/)
    // Persian when nobody says — the message is going to a +98 handset.
    await db()`delete from phone_codes`
    await client(app).post('/api/phone/start', { phone: '09121112233' })
    expect(sent.at(-1).body).toMatch(/کد ورود/)
  })

  it('refuses a number that cannot receive an SMS', async () => {
    for (const no of ['02112345678', '+12125551234', 'nope', '']) {
      const r = await client(app).post('/api/phone/start', { phone: no })
      expect(r.status, no).toBe(400)
    }
    expect(sent).toHaveLength(0)
  })

  it('answers a registered number exactly as it answers an unknown one', async () => {
    // The property this endpoint exists to have: it is not a way to ask who trains here.
    const { c, code } = await codeFor()
    await c.post('/api/phone/verify', { phone: PHONE, code, name: 'Sam' })
    await db()`delete from phone_codes`

    const known = await client(app).post('/api/phone/start', { phone: PHONE })
    const unknown = await client(app).post('/api/phone/start', { phone: '09129998877' })
    expect(known.status).toBe(unknown.status)
    expect(known.body).toEqual(unknown.body)
  })

  it('refuses a resend inside the cooldown, and says how long to wait', async () => {
    await codeFor()
    const again = await client(app).post('/api/phone/start', { phone: PHONE })
    expect(again.status).toBe(429)
    expect(again.body.code).toBe('sms_throttled')
    expect(again.body.details.retryAfter).toBeGreaterThan(0)
    expect(sent).toHaveLength(1)          // and no second message was paid for
  })

  it('counts the cooldown against the number, however it was spelled', async () => {
    await codeFor()
    // Three spellings of one number are one budget — otherwise the ceiling is a formality.
    for (const spelling of ['+989123456789', '۰۹۱۲۳۴۵۶۷۸۹', '9123456789']) {
      expect((await client(app).post('/api/phone/start', { phone: spelling })).status, spelling).toBe(429)
    }
  })
})

describe('spending a code', () => {
  it('creates the account and signs the person in', async () => {
    const { c, code } = await codeFor()

    const first = await c.post('/api/phone/verify', { phone: PHONE, code })
    // A new number is asked for a name — and only now, to somebody holding a code that was
    // texted to this handset, is it admitted that there is no account here.
    expect(first.status).toBe(400)
    expect(first.body.code).toBe('name_required')

    // The code survived that refusal — a blank field must not cost a text message and a
    // minute of waiting.
    const r = await c.post('/api/phone/verify', { phone: PHONE, code, name: 'Sam' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ created: true })
    expect(r.body.user).toMatchObject({ name: 'Sam', phone: CANON })
    // The session is real, and the cookie came back on that response.
    expect((await c.get('/api/me')).body.user.id).toBe(r.body.user.id)
  })

  it('signs an existing account back in without asking for anything', async () => {
    const first = await codeFor()
    const { user } = (await first.c.post('/api/phone/verify', { phone: PHONE, code: first.code, name: 'Sam' })).body

    await db()`delete from phone_codes`
    const again = await codeFor(PHONE, client(app))
    const r = await again.c.post('/api/phone/verify', { phone: PHONE, code: again.code })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ created: false })
    expect(r.body.user.id).toBe(user.id)
  })

  it('lands on the same account however the number was typed', async () => {
    const a = await codeFor('۰۹۱۲۳۴۵۶۷۸۹')
    const { user } = (await a.c.post('/api/phone/verify', { phone: '۰۹۱۲۳۴۵۶۷۸۹', code: a.code, name: 'Sam' })).body

    await db()`delete from phone_codes`
    const b = await codeFor('+98 912 345 6789')
    const r = await b.c.post('/api/phone/verify', { phone: '+98 912 345 6789', code: b.code })
    expect(r.body.user.id).toBe(user.id)
    // One account, one row, one number.
    const [{ n }] = await db()`select count(*)::int as n from users`
    expect(n).toBe(1)
  })

  it('reads a code typed on a Persian keyboard', async () => {
    const { c, code } = await codeFor()
    const persian = code.replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d])
    const r = await c.post('/api/phone/verify', { phone: PHONE, code: persian, name: 'Sam' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
  })

  it('says one thing for a wrong code and for a number nobody texted', async () => {
    const { c, code } = await codeFor()
    const wrong = String((Number(code) + 1) % 1e6).padStart(6, '0')
    const bad = await c.post('/api/phone/verify', { phone: PHONE, code: wrong })
    const none = await client(app).post('/api/phone/verify', { phone: '09129998877', code: '123456' })

    expect(bad.status).toBe(401)
    expect(none.status).toBe(401)
    // The difference between them is exactly the fact this endpoint will not publish.
    expect(bad.body.error).toBe(none.body.error)
  })

  it('counts guesses down and then kills the code', async () => {
    const { c, code } = await codeFor()
    const wrong = String((Number(code) + 1) % 1e6).padStart(6, '0')

    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const r = await c.post('/api/phone/verify', { phone: PHONE, code: wrong })
      expect(r.body.details.attemptsLeft).toBe(MAX_ATTEMPTS - i)
    }
    // Six digits is nothing against a script — so the code faces a constant number of tries.
    expect((await c.post('/api/phone/verify', { phone: PHONE, code, name: 'Sam' })).status).toBe(401)
    const [{ n }] = await db()`select count(*)::int as n from users`
    expect(n).toBe(0)
  })

  it('spends a code once, even when two requests carry it together', async () => {
    const { code } = await codeFor()
    const [a, b] = await Promise.all([
      client(app).post('/api/phone/verify', { phone: PHONE, code, name: 'Sam' }),
      client(app).post('/api/phone/verify', { phone: PHONE, code, name: 'Sam' })
    ])
    expect([a.status, b.status].filter(s => s === 200)).toHaveLength(1)
    // A double-tap that got through twice would be two accounts on one number.
    const [{ n }] = await db()`select count(*)::int as n from users`
    expect(n).toBe(1)
  })

  it('refuses a disabled account rather than signing it back in', async () => {
    const first = await codeFor()
    const { user } = (await first.c.post('/api/phone/verify', { phone: PHONE, code: first.code, name: 'Sam' })).body
    await db()`update users set disabled_at = now() where id = ${user.id}`

    await db()`delete from phone_codes`
    const again = await codeFor(PHONE, client(app))
    const r = await again.c.post('/api/phone/verify', { phone: PHONE, code: again.code })
    expect(r.status).toBe(403)
  })

  it('creates a coach when the signup screen said so', async () => {
    const { c, code } = await codeFor()
    const r = await c.post('/api/phone/verify', { phone: PHONE, code, name: 'Sam', asCoach: true, locale: 'fa' })
    expect(r.body.user.isCoach).toBe(true)
    const [row] = await db()`select locale from users where id = ${r.body.user.id}`
    expect(row.locale).toBe('fa')
  })
})

describe('the daily ceiling', () => {
  it('stops at it, and stops the messages with it', async () => {
    // Every one of these is a message the operator is billed for and a buzz on a handset.
    for (let i = 0; i < DAILY_CAP; i++) {
      await db()`update phone_codes set created_at = created_at - interval '2 minutes' where phone = ${CANON}`
      const r = await client(app).post('/api/phone/start', { phone: PHONE })
      expect(r.status, `message ${i + 1}`).toBe(200)
    }
    await db()`update phone_codes set created_at = created_at - interval '2 minutes' where phone = ${CANON}`
    const over = await client(app).post('/api/phone/start', { phone: PHONE })
    expect(over.status).toBe(429)
    expect(sent).toHaveLength(DAILY_CAP)
  })
})

describe('an invite-only instance', () => {
  it('takes a code from the signup, and only after the SMS code was right', async () => {
    config.inviteOnly = true
    await db()`insert into invites (code) values ('GYMYAR')`
    const { c, code } = await codeFor()

    // The invite is checked inside the claim, so this endpoint cannot be used to guess at
    // invite codes — you need a handset first.
    const noInvite = await c.post('/api/phone/verify', { phone: PHONE, code, name: 'Sam' })
    expect(noInvite.status).toBe(403)

    // And the wrong invite cost a retype rather than the code: the claim rolled back with it.
    const r = await c.post('/api/phone/verify', {
      phone: PHONE, code, name: 'Sam', invite: 'gymyar'
    })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const [row] = await db()`select used_by from invites where code = 'GYMYAR'`
    expect(row.used_by).toBe(r.body.user.id)
  })
})

describe('a number on an account that already exists', () => {
  /** Somebody who joined the ordinary way and has no number yet. */
  const withPassword = async (email = 'ada@x.test') => {
    const c = client(app)
    const r = await c.post('/api/register/password', {
      name: 'Ada', email, password: 'correct-horse-battery'
    })
    expect(r.status).toBe(200)
    return { c, user: r.body.user }
  }

  it('attaches a confirmed number, and that number then signs them in', async () => {
    const { c, user } = await withPassword()
    expect(user.phone).toBe(null)

    expect((await c.post('/api/me/phone/start', { phone: PHONE })).status).toBe(200)
    const r = await c.post('/api/me/phone/verify', { phone: PHONE, code: sent.at(-1).code })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.user).toMatchObject({ id: user.id, phone: CANON, email: 'ada@x.test' })

    // The point of the whole exercise: a laptop account is now reachable from the phone.
    await db()`delete from phone_codes`
    const onPhone = await codeFor(PHONE, client(app))
    const back = await onPhone.c.post('/api/phone/verify', { phone: PHONE, code: onPhone.code })
    expect(back.body).toMatchObject({ created: false })
    expect(back.body.user.id).toBe(user.id)
  })

  it('writes nothing without a correct code', async () => {
    const { c, user } = await withPassword()
    await c.post('/api/me/phone/start', { phone: PHONE })
    const wrong = String((Number(sent.at(-1).code) + 1) % 1e6).padStart(6, '0')

    expect((await c.post('/api/me/phone/verify', { phone: PHONE, code: wrong })).status).toBe(401)
    const [row] = await db()`select phone, phone_verified_at from users where id = ${user.id}`
    expect(row.phone).toBe(null)
    expect(row.phone_verified_at).toBe(null)
  })

  it('refuses a number that is already somebody else’s, and keeps the code', async () => {
    // Sam signs up by phone; Ada then tries to claim the same number.
    const sam = await codeFor()
    await sam.c.post('/api/phone/verify', { phone: PHONE, code: sam.code, name: 'Sam' })
    await db()`delete from phone_codes`

    const { c, user } = await withPassword()
    await c.post('/api/me/phone/start', { phone: PHONE })
    const code = sent.at(-1).code

    const taken = await c.post('/api/me/phone/verify', { phone: PHONE, code })
    expect(taken.status).toBe(409)
    expect(taken.body.code).toBe('phone_taken')
    // Nothing moved, and nothing was half-written.
    const [row] = await db()`select phone from users where id = ${user.id}`
    expect(row.phone).toBe(null)

    /* And the code survived, so a person who mistyped one digit of somebody else's number can
     * try their own immediately rather than waiting out a cooldown. */
    const [live] = await db()`select used_at from phone_codes where phone = ${CANON}`
    expect(live.used_at).toBe(null)
  })

  it('needs a session', async () => {
    expect((await client(app).post('/api/me/phone/start', { phone: PHONE })).status).toBe(401)
    expect((await client(app).post('/api/me/phone/verify', { phone: PHONE, code: '123456' })).status).toBe(401)
    expect((await client(app).del('/api/me/phone')).status).toBe(401)
  })

  it('takes a number off an account that has another way in', async () => {
    const { c } = await withPassword()
    await c.post('/api/me/phone/start', { phone: PHONE })
    await c.post('/api/me/phone/verify', { phone: PHONE, code: sent.at(-1).code })

    const r = await c.del('/api/me/phone')
    expect(r.status).toBe(200)
    expect(r.body.user.phone).toBe(null)
    // And the number is free for somebody else to claim.
    expect(await db()`select 1 from users where phone = ${CANON}`).toHaveLength(0)
  })

  it('will not take away the only way in', async () => {
    // An account created by phone has no password and no passkey. Removing the number here is
    // not unlinking a contact detail, it is deleting the credential.
    const { c, code } = await codeFor()
    await c.post('/api/phone/verify', { phone: PHONE, code, name: 'Sam' })

    const r = await c.del('/api/me/phone')
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('last_credential')
    expect((await c.get('/api/me')).body.user.phone).toBe(CANON)
  })
})

describe('an instance with no gateway', () => {
  it('says so rather than pretending a code is on its way', async () => {
    delete process.env.SMS_TRANSPORT
    try {
      expect((await client(app).get('/api/config')).body.phoneAuth).toBe(false)
      const r = await client(app).post('/api/phone/start', { phone: PHONE })
      expect(r.status).toBe(501)
      expect(r.body.error).toMatch(/cannot send text messages/)
      expect((await client(app).post('/api/phone/verify', { phone: PHONE, code: '123456' })).status).toBe(501)
    } finally { process.env.SMS_TRANSPORT = 'log' }
  })

  it('advertises the door when there is one', async () => {
    expect((await client(app).get('/api/config')).body.phoneAuth).toBe(true)
  })
})
