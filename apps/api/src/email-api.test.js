/* Confirming an email address, through the real routes.
 *
 * The sibling of phone-api.test.js, with the transport set to `log` for the same reason: the
 * code this suite types back is read out of the line an operator running MAIL_TRANSPORT=log
 * would read it out of, so the whole path is exercised rather than mocked.
 *
 * What this file is mostly about is the asymmetry with phone. A number is a credential on its
 * own; an address is half of one, and the half that is missing is a password. So most of what
 * follows is about accounts that have one, accounts that do not, and what each is allowed to
 * end up with.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { build } from './app.js'
import { client } from './test-client.js'
import { db, close } from '@gymyar/db'
import { MAX_ATTEMPTS } from '@gymyar/db/codes.js'

let app
const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL

/* Every email the instance "sent". Filtered on the mail line specifically rather than on "any
 * line with a code in it": the SMS transport logs that shape too, `process.env` is shared
 * across test files, and a suite that ran earlier and left SMS_TRANSPORT set would otherwise
 * put a text message's code at the end of this list. */
const sent = []
const logger = {
  level: 'info',
  stream: {
    write(line) {
      let rec = null
      try { rec = JSON.parse(line) } catch { return }
      if (rec?.subject && String(rec.msg || '').startsWith('email')) sent.push(rec)
    }
  }
}

/** The six digits out of the last confirmation email. */
const lastCode = () => sent.at(-1)?.body?.match(/[0-9]{6}/)?.[0] ?? null

beforeAll(async () => {
  process.env.SESSION_SECRET = 'test-secret-not-for-production'
  process.env.MAIL_TRANSPORT = 'log'
  app = await build({ logger, databaseUrl: URL, rateLimit: false })
  const { seedExercises } = await import('@gymyar/db/seed-exercises.js')
  await seedExercises()
})
beforeEach(async () => {
  await db()`delete from users`
  await db()`delete from verification_codes`
  sent.length = 0
})
afterAll(async () => {
  await app.close(); await close()
  delete process.env.MAIL_TRANSPORT
})

const ADDR = 'ada@x.test'
const PASSWORD = 'correct-horse-battery'

/** An account with a password already on it — the ordinary email signup. */
async function withPassword(email = ADDR) {
  const c = client(app)
  const r = await c.post('/api/register/password', { name: 'Ada', email, password: PASSWORD })
  expect(r.status).toBe(200)
  // Signup mails a code of its own; forget it so each test reads the one it asked for.
  await new Promise(res => setTimeout(res, 50))
  sent.length = 0
  await db()`delete from verification_codes`
  return { c, user: r.body.user }
}

/** An account created by phone: no address, and no password to fall back on.
 *
 * Its own app instance, because the phone routes need an SMS gateway and this file's does not
 * have one. Its logger feeds *both* captures — the text messages into a local list and the
 * emails into the shared `sent`, since everything below reads its codes out of that one. A
 * logger that only knew about texts is what made this look like a wrong-code failure. */
async function byPhone(phone = '09123456789') {
  process.env.SMS_TRANSPORT = 'log'
  const codes = []
  const both = { level: 'info', stream: { write(l) {
    let r = null
    try { r = JSON.parse(l) } catch { return }
    if (r?.code && String(r.msg || '').startsWith('sms')) codes.push(r)
    if (r?.subject && String(r.msg || '').startsWith('email')) sent.push(r)
  } } }
  const phoneApp = await build({ logger: both, databaseUrl: URL, rateLimit: false, runMigrations: false })
  const c = client(phoneApp)
  expect((await c.post('/api/phone/start', { phone })).status).toBe(200)
  const r = await c.post('/api/phone/verify', { phone, code: codes.at(-1).code, name: 'Sam' })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return { c, user: r.body.user, close: () => phoneApp.close() }
}

describe('signing up by email', () => {
  it('works exactly as it did, and mails a code on the way out', async () => {
    const c = client(app)
    const r = await c.post('/api/register/password', { name: 'Ada', email: ADDR, password: PASSWORD })

    // Nothing waits on the code: the session is issued and the account is usable.
    expect(r.status).toBe(200)
    expect(r.body.user.emailVerified).toBe(false)
    expect((await c.get('/api/me')).body.user.id).toBe(r.body.user.id)

    await new Promise(res => setTimeout(res, 50))
    expect(sent.at(-1).to).toBe(ADDR)
    expect(lastCode()).toMatch(/^\d{6}$/)
  })

  it('still creates the account when the relay is refusing', async () => {
    /* The send is fire-and-forget precisely so this is true. A signup that dead-ends on
     * somebody else's mail queue is a lost user, which is worse than an unproven address. */
    process.env.MAIL_TRANSPORT = 'smtp'          // no host configured — building it throws
    try {
      const r = await client(app).post('/api/register/password', {
        name: 'Ada', email: 'other@x.test', password: PASSWORD
      })
      expect(r.status).toBe(200)
    } finally { process.env.MAIL_TRANSPORT = 'log' }
  })
})

describe('confirming an address on an account that has a password', () => {
  it('sends a code and writes the address once it comes back', async () => {
    const { c, user } = await withPassword()
    // Change of address: the account already has one, verified or not.
    expect((await c.post('/api/me/email/start', { email: 'new@x.test' })).status).toBe(200)

    const r = await c.post('/api/me/email/verify', { email: 'new@x.test', code: lastCode() })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.user).toMatchObject({ id: user.id, email: 'new@x.test', emailVerified: true })
  })

  it('does not ask for a password it already has', async () => {
    const { c } = await withPassword()
    await c.post('/api/me/email/start', { email: 'new@x.test' })
    await c.post('/api/me/email/verify', { email: 'new@x.test', code: lastCode() })

    // The old password still signs in at the new address — changing an address is not a
    // reason to make somebody choose a new password.
    const fresh = client(app)
    expect((await fresh.post('/api/login/password', { email: 'new@x.test', password: PASSWORD })).status).toBe(200)
  })

  it('reads a code typed on a Persian keyboard', async () => {
    const { c } = await withPassword()
    await c.post('/api/me/email/start', { email: 'new@x.test' })
    const persian = lastCode().replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d])
    expect((await c.post('/api/me/email/verify', { email: 'new@x.test', code: persian })).status).toBe(200)
  })

  it('writes nothing without a correct code', async () => {
    const { c, user } = await withPassword()
    await c.post('/api/me/email/start', { email: 'new@x.test' })
    const wrong = String((Number(lastCode()) + 1) % 1e6).padStart(6, '0')

    const r = await c.post('/api/me/email/verify', { email: 'new@x.test', code: wrong })
    expect(r.status).toBe(401)
    expect(r.body.details.attemptsLeft).toBe(MAX_ATTEMPTS - 1)
    const [row] = await db()`select email from users where id = ${user.id}`
    expect(row.email).toBe(ADDR)
  })

  it('refuses an address that is already somebody else’s, and keeps the code', async () => {
    await withPassword('taken@x.test')
    const { c, user } = await withPassword(ADDR)

    await c.post('/api/me/email/start', { email: 'taken@x.test' })
    const code = lastCode()
    const r = await c.post('/api/me/email/verify', { email: 'taken@x.test', code })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('email_taken')

    const [row] = await db()`select email from users where id = ${user.id}`
    expect(row.email).toBe(ADDR)
    // The claim rolled back with the refusal, so their next try costs no second email.
    const [live] = await db()`select used_at from verification_codes where address = 'taken@x.test'`
    expect(live.used_at).toBe(null)
  })
})

describe('confirming an address on an account created by phone', () => {
  it('requires a password, because the address alone would not sign anybody in', async () => {
    const { c, user, close: shut } = await byPhone()
    try {
      expect(user.email).toBe(null)
      expect((await c.post('/api/me/email/start', { email: ADDR })).status).toBe(200)

      const noPassword = await c.post('/api/me/email/verify', { email: ADDR, code: lastCode() })
      expect(noPassword.status).toBe(400)
      expect(noPassword.body.code).toBe('password_required')

      const tooShort = await c.post('/api/me/email/verify', { email: ADDR, code: lastCode(), password: 'short' })
      expect(tooShort.status).toBe(400)

      // Both refusals rolled the claim back, so the same code still works.
      const r = await c.post('/api/me/email/verify', { email: ADDR, code: lastCode(), password: PASSWORD })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(r.body.user).toMatchObject({ email: ADDR, emailVerified: true, phone: '+989123456789' })

      // Which is the whole point: a second way in, on a device with neither SIM nor passkey.
      const elsewhere = client(app)
      expect((await elsewhere.post('/api/login/password', { email: ADDR, password: PASSWORD })).status).toBe(200)
    } finally { await shut() }
  })
})

describe('removing an address', () => {
  it('takes the password with it, since neither works without the other', async () => {
    const { c, user, close: shut } = await byPhone()
    try {
      await c.post('/api/me/email/start', { email: ADDR })
      await c.post('/api/me/email/verify', { email: ADDR, code: lastCode(), password: PASSWORD })

      const r = await c.del('/api/me/email')
      expect(r.status).toBe(200)
      expect(r.body.user).toMatchObject({ email: null, emailVerified: false })

      const [row] = await db()`select password_hash from users where id = ${user.id}`
      // A hash with no address beside it is a credential nothing can present.
      expect(row.password_hash).toBe(null)
    } finally { await shut() }
  })

  it('will not take away the only way in', async () => {
    const { c } = await withPassword()
    const r = await c.del('/api/me/email')
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('last_credential')
    expect((await c.get('/api/me')).body.user.email).toBe(ADDR)
  })

  it('needs a session', async () => {
    expect((await client(app).post('/api/me/email/start', { email: ADDR })).status).toBe(401)
    expect((await client(app).del('/api/me/email')).status).toBe(401)
  })
})

describe('what an unverified address cannot do', () => {
  it('cannot be sent a reset link', async () => {
    const c = client(app)
    await c.post('/api/register/password', { name: 'Ada', email: ADDR, password: PASSWORD })
    await new Promise(res => setTimeout(res, 50))
    sent.length = 0

    /* Answers `ok` regardless — this endpoint's whole design is that it says the same thing
     * about every address — so the check is that no mail went, not that it complained. */
    const r = await c.post('/api/password/forgot', { email: ADDR })
    expect(r.status).toBe(200)
    await new Promise(res => setTimeout(res, 50))
    expect(sent.filter(l => /https?:/.test(l.body || ''))).toHaveLength(0)
  })

  it('can once it is verified', async () => {
    const c = client(app)
    await c.post('/api/register/password', { name: 'Ada', email: ADDR, password: PASSWORD })
    await new Promise(res => setTimeout(res, 50))
    expect((await c.post('/api/me/email/verify', { email: ADDR, code: lastCode() })).status).toBe(200)
    sent.length = 0

    await c.post('/api/password/forgot', { email: ADDR })
    await new Promise(res => setTimeout(res, 50))
    expect(sent.filter(l => /https?:/.test(l.body || ''))).toHaveLength(1)
  })
})

describe('an instance with no relay', () => {
  it('does not offer any of it', async () => {
    delete process.env.MAIL_TRANSPORT
    try {
      const c = client(app)
      expect((await c.get('/api/config')).body.emailVerify).toBe(false)
      // Signed out is still 401 — the session check comes first, and says less.
      expect((await c.post('/api/me/email/start', { email: ADDR })).status).toBe(401)
    } finally { process.env.MAIL_TRANSPORT = 'log' }
  })

  it('says so to somebody signed in', async () => {
    const { c } = await withPassword()
    delete process.env.MAIL_TRANSPORT
    try {
      const r = await c.post('/api/me/email/start', { email: 'new@x.test' })
      expect(r.status).toBe(501)
      expect(r.body.error).toMatch(/cannot send email/)
    } finally { process.env.MAIL_TRANSPORT = 'log' }
  })

  it('advertises it when there is one', async () => {
    expect((await client(app).get('/api/config')).body.emailVerify).toBe(true)
  })
})
