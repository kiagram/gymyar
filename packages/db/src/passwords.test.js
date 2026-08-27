/* Password reset tokens, against a real database.
 *
 * This is the one feature in GymYar where a bug hands somebody an account. So the tests are
 * mostly about refusals: a spent link, an expired one, a token that was almost right, and the
 * two requests that arrive together carrying the same one.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import crypto from 'node:crypto'
import { setupDb, truncateUsers, teardownDb } from './test-helpers.js'
import { createUser, findUserById, verifyPassword, setDisabled } from './users.js'
import { createReset, consume, isLive, purgeDeadResets, liveResetsFor, RESET_TTL_MS } from './passwords.js'
import { db } from './index.js'

beforeAll(async () => { await setupDb() })
beforeEach(async () => { await truncateUsers() })
afterAll(async () => { await teardownDb() })

const NEW = 'a-brand-new-password'
const user = () => createUser({ name: 'Sam', email: 'sam@x.test', password: 'correct-horse-battery' })

describe('minting a link', () => {
  it('hands back a token and stores something that is not it', async () => {
    const u = await user()
    const token = await createReset({ userId: u.id })

    expect(token.length).toBeGreaterThan(32)
    const [row] = await db()`select token_hash from password_resets where user_id = ${u.id}`
    // The whole point: a dump of this table contains nothing that opens an account.
    expect(row.token_hash).not.toBe(token)
    expect(row.token_hash).not.toContain(token)
  })

  it('mints a different token every time', async () => {
    const u = await user()
    const seen = new Set()
    for (let i = 0; i < 5; i++) seen.add(await createReset({ userId: u.id }))
    expect(seen.size).toBe(5)
  })

  it('leaves only the newest link working', async () => {
    // Asking twice should not leave two open doors. The second email is the one they are
    // looking at; the first is a link in an inbox that no longer opens anything.
    const u = await user()
    const first = await createReset({ userId: u.id })
    const second = await createReset({ userId: u.id })

    expect(await isLive({ token: first })).toBe(false)
    expect(await isLive({ token: second })).toBe(true)
    expect(await liveResetsFor(u.id)).toBe(1)
  })

  it('expires an hour out', async () => {
    const u = await user()
    const now = Date.parse('2026-08-01T12:00:00Z')
    await createReset({ userId: u.id, now })
    const [row] = await db()`select expires_at from password_resets where user_id = ${u.id}`
    expect(new Date(row.expires_at).getTime()).toBe(now + RESET_TTL_MS)
  })
})

describe('spending one', () => {
  it('sets the password and answers with the account', async () => {
    const u = await user()
    const token = await createReset({ userId: u.id })

    const after = await consume({ token, password: NEW })
    expect(after.id).toBe(u.id)
    expect(await verifyPassword(NEW, after.password_hash)).toBe(true)
    expect(await verifyPassword('correct-horse-battery', after.password_hash)).toBe(false)
  })

  it('signs the account out everywhere', async () => {
    /* The part not to remove. Somebody resetting a password may be doing it *because* another
     * person has the old one, and a reset that leaves that person's cookie working has fixed
     * nothing at all. */
    const u = await user()
    const token = await createReset({ userId: u.id })
    await consume({ token, password: NEW })

    const after = await findUserById(u.id)
    expect(after.session_version).toBe(u.session_version + 1)
  })

  it('hands back the account as it is *after* the bump', async () => {
    /* The caller issues a session from this row. Stamped with the version it was read at, the
     * cookie is dead on arrival and the person is signed out on the device they just proved
     * themselves on — everywhere else is the point, here is not. */
    const u = await user()
    const token = await createReset({ userId: u.id })
    const returned = await consume({ token, password: NEW })
    const stored = await findUserById(u.id)
    expect(returned.session_version).toBe(stored.session_version)
  })

  it('works once', async () => {
    const u = await user()
    const token = await createReset({ userId: u.id })
    expect(await consume({ token, password: NEW })).toBeTruthy()
    expect(await consume({ token, password: 'a-third-password' })).toBe(null)

    // And the second attempt changed nothing.
    const after = await findUserById(u.id)
    expect(await verifyPassword(NEW, after.password_hash)).toBe(true)
  })

  it('works once even when two requests arrive together', async () => {
    /* A mail client that prefetches links, a double tap, a retry. The check and the claim are
     * one UPDATE precisely so that these race the database rather than each other. */
    const u = await user()
    const token = await createReset({ userId: u.id })

    const results = await Promise.all([
      consume({ token, password: NEW }),
      consume({ token, password: 'the-other-password' })
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('refuses an expired link', async () => {
    const u = await user()
    const token = await createReset({ userId: u.id, now: Date.now() - RESET_TTL_MS - 1000 })
    expect(await isLive({ token })).toBe(false)
    expect(await consume({ token, password: NEW })).toBe(null)
  })

  it('refuses a token that was never minted', async () => {
    await user()
    expect(await consume({ token: crypto.randomBytes(32).toString('base64url'), password: NEW }))
      .toBe(null)
    expect(await consume({ token: '', password: NEW })).toBe(null)
    expect(await consume({ token: null, password: NEW })).toBe(null)
  })

  it('refuses a token that is nearly right', async () => {
    const u = await user()
    const token = await createReset({ userId: u.id })
    // One character. There is no prefix matching, no truncation, nothing to walk.
    expect(await consume({ token: token.slice(0, -1), password: NEW })).toBe(null)
    expect(await consume({ token: token + 'A', password: NEW })).toBe(null)
    expect(await isLive({ token })).toBe(true)     // and the real one is untouched
  })

  it('will not let a disabled account back in', async () => {
    const u = await user()
    const token = await createReset({ userId: u.id })
    await setDisabled(u.id, true)

    expect(await consume({ token, password: NEW })).toBe(null)
    // The link is spent regardless: a token that quietly does nothing beats one left live.
    expect(await isLive({ token })).toBe(false)
    const after = await findUserById(u.id)
    expect(await verifyPassword('correct-horse-battery', after.password_hash)).toBe(true)
  })

  it('needs a password to set', async () => {
    const u = await user()
    const token = await createReset({ userId: u.id })
    expect(await consume({ token, password: '' })).toBe(null)
    expect(await isLive({ token })).toBe(true)     // and did not burn the link doing it
  })

  it('does not touch another account', async () => {
    const a = await user()
    const b = await createUser({ name: 'Theo', email: 'theo@x.test', password: 'another-password-x' })
    const token = await createReset({ userId: a.id })
    await consume({ token, password: NEW })

    const other = await findUserById(b.id)
    expect(await verifyPassword('another-password-x', other.password_hash)).toBe(true)
    expect(other.session_version).toBe(b.session_version)
  })
})

describe('asking without spending', () => {
  it('says yes to a live link and no to everything else', async () => {
    const u = await user()
    const token = await createReset({ userId: u.id })
    expect(await isLive({ token })).toBe(true)
    expect(await isLive({ token: 'nonsense' })).toBe(false)
    expect(await isLive({ token: '' })).toBe(false)
  })

  it('does not spend the link by asking', async () => {
    const u = await user()
    const token = await createReset({ userId: u.id })
    for (let i = 0; i < 3; i++) expect(await isLive({ token })).toBe(true)
    expect(await consume({ token, password: NEW })).toBeTruthy()
  })
})

describe('clearing up', () => {
  it('keeps a spent link for a day, then takes it', async () => {
    const u = await user()
    const token = await createReset({ userId: u.id })
    await consume({ token, password: NEW })

    // "Was a reset requested for this account, and when" is worth being able to answer for a
    // little while after somebody asks it.
    expect(await purgeDeadResets()).toBe(0)
    expect(await purgeDeadResets({ now: Date.now() + 25 * 60 * 60 * 1000 })).toBe(1)
  })

  it('takes an expired link that was never spent', async () => {
    const u = await user()
    await createReset({ userId: u.id, now: Date.now() - 26 * 60 * 60 * 1000 })
    expect(await purgeDeadResets()).toBe(1)
  })

  it('leaves a live one alone', async () => {
    const u = await user()
    const token = await createReset({ userId: u.id })
    expect(await purgeDeadResets()).toBe(0)
    expect(await isLive({ token })).toBe(true)
  })

  it('goes with the account', async () => {
    const u = await user()
    await createReset({ userId: u.id })
    await db()`delete from users where id = ${u.id}`
    const [{ n }] = await db()`select count(*)::int as n from password_resets`
    expect(n).toBe(0)
  })
})
