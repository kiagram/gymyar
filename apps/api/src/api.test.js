import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { build } from './app.js'
import { client } from './test-client.js'
import { db, close } from '@gymbuddy/db'

let app
const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL

beforeAll(async () => {
  process.env.SESSION_SECRET = 'test-secret-not-for-production'
  app = await build({ databaseUrl: URL })
  const { seedExercises } = await import('@gymbuddy/db/seed-exercises.js')
  await seedExercises()
})
beforeEach(async () => {
  // DELETE, not TRUNCATE CASCADE: the latter would take the shared exercise library with it,
  // since `exercises.owner_id` references users. Cascading deletes clear a user's own rows.
  await db()`delete from users`
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
      changes: { bodyweight: [{ id: 'b1', on_date: '2026-08-01', weight_kg: 82 }] }
    })
    const view = await coach.c.get(`/api/coach/clients/${client_.user.id}`)
    expect(view.status).toBe(200)
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
})
