import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { build } from './app.js'
import { client } from './test-client.js'
import { db, close } from '@gymyar/db'
import { config } from './config.js'

let app
const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL

beforeAll(async () => {
  process.env.SESSION_SECRET = 'test-secret-not-for-production'
  app = await build({ databaseUrl: URL, rateLimit: false })
  const { seedExercises } = await import('@gymyar/db/seed-exercises.js')
  await seedExercises()
})
beforeEach(async () => {
  // DELETE, not TRUNCATE CASCADE: the latter would take the shared exercise library with it,
  // since `exercises.owner_id` references users. Cascading deletes clear a user's own rows.
  await db()`delete from users`
  /* And the codes, which nothing cascades away: a `verification_codes` row is about a
   * destination rather than a user, so it survives the delete above and its resend cooldown
   * lands on the next test that asks about the same address. That is a 60-second window in
   * which the second test to register `sam@x.test` is silently sent no email at all. */
  await db()`delete from verification_codes`
})
afterAll(async () => { await app.close(); await close() })

const signUp = async (name, email, extra = {}) => {
  const c = client(app)
  const r = await c.post('/api/register/password', {
    name, email, password: 'correct-horse-battery', ...extra
  })
  expect(r.status).toBe(200)
  return { c, user: r.body.user }
}

describe('accounts', () => {
  it('signs up, stays signed in, and signs out', async () => {
    const { c, user } = await signUp('Ada', 'ada@x.test')
    expect((await c.get('/api/me')).body.user.id).toBe(user.id)
    await c.post('/api/logout')
    expect((await c.get('/api/me')).status).toBe(401)
  })

  it('rejects a weak password before creating anything', async () => {
    const c = client(app)
    const r = await c.post('/api/register/password', { name: 'Ada', email: 'ada@x.test', password: 'short' })
    expect(r.status).toBe(400)
    const [{ n }] = await db()`select count(*)::int as n from users`
    expect(n).toBe(0)
  })

  it('refuses a duplicate email', async () => {
    await signUp('Ada', 'ada@x.test')
    const c = client(app)
    const r = await c.post('/api/register/password', {
      name: 'Imposter', email: 'ADA@x.test', password: 'correct-horse-battery'
    })
    expect(r.status).toBe(409)
  })

  it('gives the same answer for a wrong password and an unknown address', async () => {
    await signUp('Ada', 'ada@x.test')
    const c = client(app)
    const wrong = await c.post('/api/login/password', { email: 'ada@x.test', password: 'nope' })
    const unknown = await c.post('/api/login/password', { email: 'nobody@x.test', password: 'nope' })
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(wrong.body.error).toBe(unknown.body.error)
  })

  it('signs out every device at once', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    const phone = client(app)
    await phone.post('/api/login/password', { email: 'ada@x.test', password: 'correct-horse-battery' })
    expect((await phone.get('/api/me')).status).toBe(200)

    await c.post('/api/logout/all')
    expect((await phone.get('/api/me')).status).toBe(401)   // the other device, not this one
  })

  it('locks a disabled account out everywhere', async () => {
    const { c, user } = await signUp('Ada', 'ada@x.test')
    await db()`update users set disabled_at = now() where id = ${user.id}`
    expect((await c.get('/api/me')).status).toBe(401)
  })

  it('refuses a forged cookie', async () => {
    const { user } = await signUp('Ada', 'ada@x.test')
    const res = await app.inject({
      method: 'GET', url: '/api/me',
      headers: { cookie: `gymsid=${user.id}:${Date.now() + 1e6}:1.notavalidmac` }
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('sync over http', () => {
  const routine = (id, name) => ({ id, name, exercises: [{ id: '0025', sets: 3, reps: 5 }] })

  it('needs a session', async () => {
    expect((await client(app).get('/api/sync?since=0')).status).toBe(401)
  })

  it('round-trips a push and a pull', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    const pushed = await c.post('/api/sync', { changes: { routines: [routine('r1', 'Push')] } })
    expect(pushed.status).toBe(200)
    const all = await c.get('/api/sync/all')
    expect(all.body.changes.routines[0].name).toBe('Push')
  })

  it('sends only the delta on the second pull', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    const first = await c.post('/api/sync', { changes: { routines: [routine('r1', 'Push')] } })
    const quiet = await c.get(`/api/sync?since=${first.body.cursor}`)
    expect(quiet.body.changes).toEqual({})

    await c.post('/api/sync', { changes: { routines: [routine('r2', 'Pull')] } })
    const delta = await c.get(`/api/sync?since=${first.body.cursor}`)
    expect(delta.body.changes.routines).toHaveLength(1)
    expect(delta.body.changes.routines[0].id).toBe('r2')
  })

  it('never leaks one account into another', async () => {
    const a = await signUp('Ada', 'ada@x.test')
    await a.c.post('/api/sync', { changes: { routines: [routine('r1', 'Ada only')] } })
    const b = await signUp('Bob', 'bob@x.test')
    expect((await b.c.get('/api/sync/all')).body.changes.routines).toHaveLength(0)
  })

  it('refuses an oversized push instead of holding a transaction open', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    const many = Array.from({ length: 5001 }, (_, i) => routine(`r${i}`, `R${i}`))
    const r = await c.post('/api/sync', { changes: { routines: many } })
    expect(r.status).toBe(413)
  })
})

describe('coaching over http', () => {
  const setup = async () => {
    const coach = await signUp('Coach Kim', 'kim@x.test', { asCoach: true })
    const client_ = await signUp('Sam', 'sam@x.test')
    const inv = await coach.c.post('/api/coach/invites', {
      email: 'sam@x.test', scopes: ['programmes', 'workouts']
    })
    return { coach, client_, code: inv.body.invite.code }
  }

  it('shows the client who is asking, before they accept', async () => {
    const { client_, code } = await setup()
    const r = await client_.c.get(`/api/invites/${code}`)
    expect(r.body.invite.coachName).toBe('Coach Kim')
    expect(r.body.invite.scopes).toEqual(['programmes', 'workouts'])
  })

  it('links the pair on accept and lists them both ways', async () => {
    const { coach, client_, code } = await setup()
    expect((await client_.c.post(`/api/invites/${code}/accept`)).status).toBe(200)
    const roster = await coach.c.get('/api/coach/clients')
    expect(roster.body.clients[0].client_name).toBe('Sam')
    const coaches = await client_.c.get('/api/coaches')
    expect(coaches.body.coaches[0].coach_name).toBe('Coach Kim')
  })

  it('honours the scope the client actually granted', async () => {
    const { coach, client_, code } = await setup()
    await client_.c.post(`/api/invites/${code}/accept`, { scopes: ['programmes'] })
    await client_.c.post('/api/sync', {
      changes: { bodyweight: [{ on_date: '2026-08-01', weight_kg: 82 }] }
    })
    const view = await coach.c.get(`/api/coach/clients/${client_.user.id}`)
    expect(view.status).toBe(200)
    expect(view.body.link.client_name).toBe('Sam')   // the screen is headed by a name, not "Client"
    expect(view.body.routines).toBeDefined()
    expect(view.body.bodyweight).toBeUndefined()   // shared programmes, not weigh-ins
    expect(view.body.workouts).toBeUndefined()
  })

  it('keeps a stranger out of a client\'s training', async () => {
    const { client_, code } = await setup()
    await client_.c.post(`/api/invites/${code}/accept`)
    const nosy = await signUp('Nosy', 'nosy@x.test')
    expect((await nosy.c.get(`/api/coach/clients/${client_.user.id}`)).status).toBe(403)
    expect((await nosy.c.post(`/api/coach/clients/${client_.user.id}/propose`, {
      routineId: 'r1', payload: { name: 'Mine' }
    })).status).toBe(403)
  })

  it('runs a proposal end to end without ever overwriting the client', async () => {
    const { coach, client_, code } = await setup()
    await client_.c.post(`/api/invites/${code}/accept`)
    await client_.c.post('/api/sync', {
      changes: { routines: [{ id: 'r1', name: 'My own', exercises: [] }] }
    })

    const proposed = await coach.c.post(`/api/coach/clients/${client_.user.id}/propose`, {
      routineId: 'r1',
      payload: { name: 'Push A', policy: 'linear', exercises: [{ id: '0025', sets: 5, reps: 5 }] },
      note: 'try five across'
    })
    expect(proposed.status).toBe(200)

    // still untouched
    expect((await client_.c.get('/api/sync/all')).body.changes.routines[0].name).toBe('My own')

    const inbox = await client_.c.get('/api/proposals')
    expect(inbox.body.proposals).toHaveLength(1)
    expect(inbox.body.proposals[0].note).toBe('try five across')
    expect(inbox.body.proposals[0].coach_name).toBe('Coach Kim')

    await client_.c.post(`/api/proposals/${inbox.body.proposals[0].id}/accept`)
    expect((await client_.c.get('/api/sync/all')).body.changes.routines[0].name).toBe('Push A')
  })

  it('lets a client decline and keep their own version', async () => {
    const { coach, client_, code } = await setup()
    await client_.c.post(`/api/invites/${code}/accept`)
    await client_.c.post('/api/sync', { changes: { routines: [{ id: 'r1', name: 'My own', exercises: [] }] } })
    await coach.c.post(`/api/coach/clients/${client_.user.id}/propose`, {
      routineId: 'r1', payload: { name: 'Push A', exercises: [] }
    })
    const [p] = (await client_.c.get('/api/proposals')).body.proposals
    await client_.c.post(`/api/proposals/${p.id}/decline`)
    expect((await client_.c.get('/api/sync/all')).body.changes.routines[0].name).toBe('My own')
    expect((await client_.c.get('/api/proposals')).body.proposals).toHaveLength(0)
  })

  it('will not let a coach accept on the client\'s behalf', async () => {
    const { coach, client_, code } = await setup()
    await client_.c.post(`/api/invites/${code}/accept`)
    await coach.c.post(`/api/coach/clients/${client_.user.id}/propose`, {
      routineId: 'r1', payload: { name: 'Push A', exercises: [] }
    })
    const [p] = (await client_.c.get('/api/proposals')).body.proposals
    expect((await coach.c.post(`/api/proposals/${p.id}/accept`)).status).toBe(404)
  })

  it('carries a conversation both ways', async () => {
    const { coach, client_, code } = await setup()
    const accepted = await client_.c.post(`/api/invites/${code}/accept`)
    const linkId = accepted.body.link.id
    await coach.c.post(`/api/threads/${linkId}`, { body: 'how did Monday feel?' })
    await client_.c.post(`/api/threads/${linkId}`, { body: 'heavy but fine' })
    const thread = await coach.c.get(`/api/threads/${linkId}`)
    expect(thread.body.messages.map(m => m.body))
      .toEqual(['how did Monday feel?', 'heavy but fine'])
  })

  it('lets a client cut a coach off, immediately', async () => {
    const { coach, client_, code } = await setup()
    const accepted = await client_.c.post(`/api/invites/${code}/accept`)
    await client_.c.post(`/api/coaches/${accepted.body.link.id}/end`)
    expect((await coach.c.get(`/api/coach/clients/${client_.user.id}`)).status).toBe(403)
    expect((await coach.c.get('/api/coach/clients')).body.clients).toHaveLength(0)
  })
})

describe('exercise library', () => {
  it('survives a user being deleted', async () => {
    // guards the trap this suite fell into: `truncate users cascade` takes `exercises` with it,
    // library rows and all, because owner_id references users
    const { user } = await signUp('Ada', 'ada@x.test')
    await db()`delete from users where id = ${user.id}`
    const [{ n }] = await db()`select count(*)::int as n from exercises where owner_id is null`
    expect(n).toBe(1324)
  })

  it('searches the shared catalogue', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    const r = await c.get('/api/exercises?q=bench&limit=5')
    expect(r.body.exercises.length).toBeGreaterThan(0)
    expect(r.body.exercises[0].name.toLowerCase()).toContain('bench')
    expect(r.body.exercises[0].attribution).toContain('Gym visual')
  })

  it('puts your own exercises above the library', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    await c.post('/api/sync', {
      changes: { exercises: [{ id: 'c1', name: 'Bench zzz special', body_part: 'chest' }] }
    })
    const r = await c.get('/api/exercises?q=bench')
    expect(r.body.exercises[0].custom).toBe(true)
  })

  it('never shows one user another user\'s custom exercise', async () => {
    const a = await signUp('Ada', 'ada@x.test')
    await a.c.post('/api/sync', {
      changes: { exercises: [{ id: 'c1', name: 'Zzz secret lift', body_part: 'chest' }] }
    })
    const b = await signUp('Bob', 'bob@x.test')
    const r = await b.c.get('/api/exercises?q=secret')
    expect(r.body.exercises).toHaveLength(0)
  })
})

describe('admin', () => {
  it('is closed to everyone by default', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    expect((await c.get('/api/admin/users')).status).toBe(403)
  })

  it('opens to a flagged admin', async () => {
    const { c, user } = await signUp('Root', 'root@x.test')
    await db()`update users set is_admin = true where id = ${user.id}`
    const r = await c.get('/api/admin/users')
    expect(r.status).toBe(200)
    expect(r.body.users[0].name).toBe('Root')
  })

  it('keeps revenue behind the same door', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    expect((await c.get('/api/admin/revenue')).status).toBe(403)
  })

  it('counts settled payments in Toman, and in dollars where a rate was recorded', async () => {
    const { c, user } = await signUp('Root', 'root@x.test')
    await db()`update users set is_admin = true where id = ${user.id}`

    // Two settled payments in the same month: one taken with a rate on it, one without.
    await db()`
      insert into payments (user_id, gateway, amount, currency, months, tier, toman_per_usd,
                            status, ref_id, settled_at)
      values (${user.id}, 'zarinpal', 2032000, 'IRR', 1, 'solo', 203200, 'paid', 'R-a', now()),
             (${user.id}, 'zarinpal', 1000000, 'IRR', 1, 'solo', null,   'paid', 'R-b', now())`

    const r = await c.get('/api/admin/revenue')
    expect(r.status).toBe(200)
    const [month] = r.body.months
    expect(month.payments).toBe(2)
    // Rials to Toman at the edge: 2,032,000 + 1,000,000 Rials → 303,200 Toman.
    expect(month.toman).toBeCloseTo(303_200, 0)
    // Only the rated one reaches the dollar column — 203,200 T at 203,200 T/$ is one dollar.
    expect(month.usd).toBeCloseTo(1, 6)
    // …and the screen is told how much it is missing rather than left to assume none.
    expect(month.unrated).toBe(1)
  })

  it('ignores attempts that never became money', async () => {
    const { c, user } = await signUp('Root', 'root@x.test')
    await db()`update users set is_admin = true where id = ${user.id}`
    await db()`
      insert into payments (user_id, gateway, amount, currency, months, status)
      values (${user.id}, 'zarinpal', 9999000, 'IRR', 12, 'abandoned')`
    expect((await c.get('/api/admin/revenue')).body.months).toEqual([])
  })
})

/* The language the server writes in.
 *
 * `users.locale` shipped in 001 and nothing ever wrote it, so every account sat at `'en'` and
 * two features that read it — the brief reader and the note a coach's client is sent — were
 * monolingual behind a layer that already had Farsi in it. These are about the column being
 * reachable at all.
 */
describe('the language on a profile', () => {
  it('is taken from the form the account was created on', async () => {
    const c = client(app)
    const r = await c.post('/api/register/password', {
      name: 'Reza', email: 'reza@x.test', password: 'correct-horse-battery', locale: 'fa'
    })
    expect(r.status).toBe(200)
    const [row] = await db()`select locale from users where id = ${r.body.user.id}`
    expect(row.locale).toBe('fa')
  })

  it('defaults to English rather than refusing an account over it', async () => {
    const c = client(app)
    const r = await c.post('/api/register/password', {
      name: 'Ada', email: 'ada@x.test', password: 'correct-horse-battery', locale: 'klingon'
    })
    expect(r.status).toBe(200)
    const [row] = await db()`select locale from users where id = ${r.body.user.id}`
    expect(row.locale).toBe('en')
  })

  it('moves when somebody changes the app’s language', async () => {
    const { c, user } = await signUp('Sam', 'sam@x.test')
    const r = await c.patch('/api/me', { locale: 'fa' })
    expect(r.status).toBe(200)
    expect(r.body.user.locale).toBe('fa')
    const [row] = await db()`select locale from users where id = ${user.id}`
    expect(row.locale).toBe('fa')
  })

  it('refuses a language this app does not have', async () => {
    const { c } = await signUp('Sam', 'sam@x.test')
    expect((await c.patch('/api/me', { locale: 'xx' })).status).toBe(400)
    expect((await c.patch('/api/me', { locale: 'fa-IR' })).status).toBe(400)
    expect((await c.patch('/api/me', {})).status).toBe(400)
  })

  it('is nobody’s business but the signed-in account’s', async () => {
    const c = client(app)
    expect((await c.patch('/api/me', { locale: 'fa' })).status).toBe(401)
  })

  it('says the same thing twice without writing twice', async () => {
    // Called on every sign-in, so the no-op case is the common one.
    const { c } = await signUp('Sam', 'sam@x.test')
    await c.patch('/api/me', { locale: 'fa' })
    const again = await c.patch('/api/me', { locale: 'fa' })
    expect(again.status).toBe(200)
    expect(again.body.user.locale).toBe('fa')
  })
})

/* Password reset over the real routes.
 *
 * Two things are being checked and they pull against each other. The first is that the feature
 * works. The second is that it tells a stranger nothing — which means most of these assert that
 * two different situations produce byte-identical answers.
 *
 * The transport is `log`, so the email is a line in the logger rather than a message anybody
 * sends. The link is read back out of it, which is exactly what a self-hoster running
 * MAIL_TRANSPORT=log does by hand.
 */
describe('password reset', () => {
  // Initialised here rather than in `beforeEach`: the logger below starts writing during
  // `build()`, which runs in `beforeAll` — before any `beforeEach` has.
  let sent = []
  let mailApp

  /** The link out of the last email that has one, which on this transport is a line in the log.
   *  "that has one" matters now: the confirmation code email carries no link, so the last
   *  email and the last *reset* email are no longer always the same message. */
  const linkFrom = () => {
    const url = sent.filter(l => l.body && l.subject)
      .map(l => l.body.match(/https?:\S+/)?.[0]).filter(Boolean).at(-1)
    return url ? url.split('/#/reset/')[1] : null
  }

  beforeAll(async () => {
    process.env.MAIL_TRANSPORT = 'log'
    /* A second app, with a logger that keeps what it is given.
     *
     * `req.log` is a child of the instance's logger, so replacing a property after the fact
     * would not reach it — the capture has to be the stream the logger was built around. This
     * is also exactly how a self-hoster running MAIL_TRANSPORT=log reads their own link, which
     * makes it a fair test of that path rather than a mock of it. */
    mailApp = await build({
      databaseUrl: URL,
      rateLimit: false,
      logger: { level: 'info', stream: { write: line => sent.push(JSON.parse(line)) } }
    })
  })
  beforeEach(() => { sent = [] })
  // Every log line lands in `sent`; an email is the one carrying a body.
  const emails = () => sent.filter(l => l.body && l.subject)
  afterAll(async () => {
    await mailApp.close()
    delete process.env.MAIL_TRANSPORT
    delete process.env.ORIGIN
  })

  const withMail = () => client(mailApp)

  /* The confirmation code out of the last email that is one — no link, six digits. */
  const codeFrom = () => sent.filter(l => l.body && l.subject && !/https?:/.test(l.body))
    .at(-1)?.body?.match(/[0-9]{6}/)?.[0] ?? null

  const register = async (c, email, extra = {}) => {
    const r = await c.post('/api/register/password', {
      name: 'Sam', email, password: 'correct-horse-battery', ...extra
    })
    expect(r.status).toBe(200)

    /* Signup mails a confirmation code, and reset now needs a verified address — so this
     * helper confirms it, through the real endpoint and the real code rather than by writing
     * `email_verified_at` directly. A test that reaches into the column keeps passing on the
     * day that flow breaks, which is the day it matters.
     *
     * The send is deliberately not awaited by the signup route, so it is waited for here. */
    let code = null
    for (let i = 0; i < 50 && !code; i++) {
      code = codeFrom()
      if (!code) await new Promise(r => setTimeout(r, 10))
    }
    expect(code, 'no confirmation code was mailed at signup').toBeTruthy()
    const v = await c.post('/api/me/email/verify', { email, code })
    expect(v.status, JSON.stringify(v.body)).toBe(200)
    expect(v.body.user.emailVerified).toBe(true)

    // And forget both messages, so every assertion below sees only the email it is about.
    sent.length = 0
    return r.body.user
  }

  it('is not offered at all when the instance cannot send email', async () => {
    /* Both are read from the environment per request rather than captured at boot, which is
     * what lets this be tested at all — and is the same reason an operator can turn mail on
     * without rebuilding an image. */
    const was = process.env.MAIL_TRANSPORT
    delete process.env.MAIL_TRANSPORT
    try {
      const c = withMail()
      expect((await c.get('/api/config')).body.passwordReset).toBe(false)
      // Not a 404 and not a silent 200: an instance that cannot do this says so.
      expect((await c.post('/api/password/forgot', { email: 'nobody@x.test' })).status).toBe(501)
    } finally {
      process.env.MAIL_TRANSPORT = was
    }
  })

  it('is offered when it can', async () => {
    expect((await withMail().get('/api/config')).body.passwordReset).toBe(true)
  })

  it('sends a link that sets a new password and signs in', async () => {
    const c = withMail()
    const user = await register(c, 'reset-me@x.test')
    await c.post('/api/logout')

    expect((await c.post('/api/password/forgot', { email: 'reset-me@x.test' })).status).toBe(200)
    const token = linkFrom()
    expect(token).toBeTruthy()

    expect((await c.get(`/api/password/reset/${token}`)).body.valid).toBe(true)
    const done = await c.post('/api/password/reset', { token, password: 'a-brand-new-password' })
    expect(done.status).toBe(200)
    expect(done.body.user.id).toBe(user.id)
    // Signed in on this device: reading the email and choosing the password is the whole proof.
    expect((await c.get('/api/me')).body.user.id).toBe(user.id)

    // And the new password is the one that works from a cold start.
    const fresh = client(mailApp)
    expect((await fresh.post('/api/login/password',
      { email: 'reset-me@x.test', password: 'a-brand-new-password' })).status).toBe(200)
    expect((await fresh.post('/api/login/password',
      { email: 'reset-me@x.test', password: 'correct-horse-battery' })).status).toBe(401)
  })

  it('signs every other device out', async () => {
    const c = withMail()
    await register(c, 'reset-me@x.test')
    const otherDevice = client(mailApp)
    expect((await otherDevice.post('/api/login/password',
      { email: 'reset-me@x.test', password: 'correct-horse-battery' })).status).toBe(200)
    expect((await otherDevice.get('/api/me')).status).toBe(200)

    await c.post('/api/password/forgot', { email: 'reset-me@x.test' })
    await c.post('/api/password/reset', { token: linkFrom(), password: 'a-brand-new-password' })

    // The session_version bump is what does this, and it is the point of the whole step.
    expect((await otherDevice.get('/api/me')).status).toBe(401)
  })

  it('says exactly the same thing about an address with no account', async () => {
    const c = withMail()
    await register(c, 'real@x.test')
    await c.post('/api/logout')

    const real = await c.post('/api/password/forgot', { email: 'real@x.test' })
    sent = []
    const fake = await c.post('/api/password/forgot', { email: 'nobody-at-all@x.test' })

    expect(fake.status).toBe(real.status)
    expect(fake.body).toEqual(real.body)
    // Nothing was sent, which is the only difference and it is not one the caller can see.
    expect(emails()).toHaveLength(0)
  })

  it('says the same thing about a passkey-only account', async () => {
    // Nothing to reset, and answering differently would say so.
    const c = withMail()
    await db()`insert into users (name, email) values ('Passkey Only', 'passkey@x.test')`
    const r = await c.post('/api/password/forgot', { email: 'passkey@x.test' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(emails()).toHaveLength(0)
  })

  it('says the same thing about a disabled account', async () => {
    const c = withMail()
    const user = await register(c, 'disabled@x.test')
    await db()`update users set disabled_at = now() where id = ${user.id}`
    sent = []
    const r = await c.post('/api/password/forgot', { email: 'disabled@x.test' })
    expect(r.status).toBe(200)
    expect(emails()).toHaveLength(0)
  })

  it('writes the email in the account’s language', async () => {
    const c = withMail()
    await register(c, 'reza@x.test', { locale: 'fa' })
    sent = []
    await c.post('/api/password/forgot', { email: 'reza@x.test' })

    const line = emails().at(-1)
    expect(line.subject).toMatch(/[؀-ۿ]/)
    expect(line.body).toMatch(/[؀-ۿ]/)
    // The link is still a link.
    expect(line.body).toContain(`${config.origin}/#/reset/`)
  })

  it('points the link at this instance’s own origin', async () => {
    /* Against `config.origin` rather than a literal: it is read once when the module loads, so
     * a test cannot set it afterwards — and the property worth asserting is that the link is
     * built from whatever this instance is configured with, not that it equals some string. */
    const c = withMail()
    await register(c, 'origin@x.test')
    sent = []
    await c.post('/api/password/forgot', { email: 'origin@x.test' })
    expect(emails().at(-1).body).toContain(`${config.origin}/#/reset/`)
  })

  it('refuses a spent link, and says which of the two it was', async () => {
    const c = withMail()
    await register(c, 'twice@x.test')
    await c.post('/api/password/forgot', { email: 'twice@x.test' })
    const token = linkFrom()

    expect((await c.post('/api/password/reset', { token, password: 'a-brand-new-password' })).status).toBe(200)
    const again = await c.post('/api/password/reset', { token, password: 'yet-another-one' })
    expect(again.status).toBe(400)
    expect(again.body.error).toMatch(/expired or has already been used/)
    expect((await c.get(`/api/password/reset/${token}`)).body.valid).toBe(false)
  })

  it('refuses a token nobody minted, without saying anything about it', async () => {
    const c = withMail()
    expect((await c.get('/api/password/reset/not-a-real-token')).body.valid).toBe(false)
    const r = await c.post('/api/password/reset', { token: 'not-a-real-token', password: 'a-brand-new-password' })
    expect(r.status).toBe(400)
  })

  it('applies the same password rule as the signup form, before spending the link', async () => {
    const c = withMail()
    await register(c, 'short@x.test')
    await c.post('/api/password/forgot', { email: 'short@x.test' })
    const token = linkFrom()

    const r = await c.post('/api/password/reset', { token, password: 'short' })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/at least 10/)
    // A password that was never going to be accepted must not cost somebody their link.
    expect((await c.get(`/api/password/reset/${token}`)).body.valid).toBe(true)
  })

  it('leaves only the newest link working', async () => {
    const c = withMail()
    await register(c, 'again@x.test')
    await c.post('/api/password/forgot', { email: 'again@x.test' })
    const first = linkFrom()
    await c.post('/api/password/forgot', { email: 'again@x.test' })
    const second = linkFrom()

    expect(first).not.toBe(second)
    expect((await c.get(`/api/password/reset/${first}`)).body.valid).toBe(false)
    expect((await c.get(`/api/password/reset/${second}`)).body.valid).toBe(true)
  })
})
