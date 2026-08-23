import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { build } from './app.js'
import { client } from './test-client.js'
import { db, close } from '@gymbuddy/db'
import { createAI, nullProvider } from '@gymbuddy/ai'
import { say } from '@gymbuddy/domain'

let app
const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL

beforeAll(async () => {
  process.env.SESSION_SECRET = 'test-secret-not-for-production'
  // No key in CI and none wanted: these tests assert the product works without one.
  app = await build({ databaseUrl: URL, ai: createAI({ provider: nullProvider }), rateLimit: false })
  const { seedExercises } = await import('@gymbuddy/db/seed-exercises.js')
  await seedExercises()
})
beforeEach(async () => { await db()`delete from users` })
afterAll(async () => { await app.close(); await close() })

const signUp = async (name, email, extra = {}) => {
  const c = client(app)
  const r = await c.post('/api/register/password', { name, email, password: 'correct-horse-battery', ...extra })
  expect(r.status).toBe(200)
  return { c, user: r.body.user }
}

describe('what the model layer says about itself', () => {
  it('admits when there is no model', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    const r = await c.get('/api/ai/status')
    expect(r.body.model).toBe(false)
    expect(r.body.note).toMatch(/work exactly the same/i)
  })

  it('needs a session', async () => {
    expect((await client(app).get('/api/ai/status')).status).toBe(401)
  })
})

describe('drafting a programme', () => {
  it('builds one from a description, with no model at all', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    const r = await c.post('/api/ai/programme', {
      text: 'I want to get stronger, 3 days a week, I have a barbell and dumbbells'
    })
    expect(r.status).toBe(200)
    expect(r.body.source).toBe('local')
    expect(r.body.brief.goal).toBe('strength')
    expect(r.body.brief.daysPerWeek).toBe(3)
    expect(r.body.routines).toHaveLength(3)
    expect(Object.keys(r.body.week)).toHaveLength(3)
  })

  it('names every exercise it picked', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    const r = await c.post('/api/ai/programme', { brief: { goal: 'muscle', daysPerWeek: 4, equipment: ['barbell', 'dumbbell'] } })
    for (const routine of r.body.routines) {
      for (const e of routine.ex) {
        expect(e.name).toBeTruthy()
        expect(e.name).not.toBe(e.id)
      }
    }
  })

  it('only ever picks exercises that exist in the library', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    const r = await c.post('/api/ai/programme', { brief: { goal: 'strength', daysPerWeek: 5, equipment: ['barbell', 'dumbbell', 'cable'] } })
    const ids = r.body.routines.flatMap(x => x.ex.map(e => e.id))
    const rows = await db()`select id from exercises where id in ${db()(ids.map(i => `lib:${i}`))}`
    expect(rows).toHaveLength(new Set(ids).size)
  })

  it('does not save anything', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    await c.post('/api/ai/programme', { brief: { goal: 'strength', daysPerWeek: 3 } })
    // a plan that installed itself would be a plan nobody read
    expect((await c.get('/api/sync/all')).body.changes.routines).toHaveLength(0)
  })

  it('explains what it built', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    const r = await c.post('/api/ai/programme', { brief: { goal: 'strength', daysPerWeek: 3, equipment: ['barbell'] } })
    expect(r.body.notes.join(' ')).toMatch(/strength/i)
  })

  it('needs a session', async () => {
    expect((await client(app).post('/api/ai/programme', { text: 'hi' })).status).toBe(401)
  })
})

describe('reviewing your own training', () => {
  it('says nothing is wrong when there is nothing logged', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    const r = await c.get('/api/ai/review')
    expect(r.status).toBe(200)
    expect(r.body.findings).toEqual([])
    expect(r.body.hasPlan).toBe(false)
  })

  it('notices a lapse', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    const old = new Date(Date.now() - 40 * 86400000).toISOString()
    await c.post('/api/sync', {
      changes: {
        routines: [{ id: 'r1', name: 'Push', exercises: [{ id: '0025', sets: 3, reps: 5 }] }],
        weekPlan: [{ weekday: 1, routine_id: 'r1' }],
        workouts: [{ id: 'w1', started_at: old, finished_at: old, routine_id: 'r1', routine_name: 'Push', prs: [], sets: [] }]
      }
    })
    const r = await c.get('/api/ai/review')
    expect(r.body.findings.some(f => f.kind === 'lapsed')).toBe(true)
  })
})

describe('drafting a change for a client', () => {
  const linked = async (scopes = ['programmes', 'workouts']) => {
    const coach = await signUp('Coach Kim', 'kim@x.test', { asCoach: true })
    const client_ = await signUp('Sam', 'sam@x.test')
    const inv = await coach.c.post('/api/coach/invites', { scopes })
    await client_.c.post(`/api/invites/${inv.body.invite.code}/accept`)
    return { coach, client_ }
  }

  const stalledHistory = async c => {
    const day = n => new Date(Date.now() - n * 86400000).toISOString()
    const session = (id, n, reps) => ({
      id, started_at: day(n), finished_at: day(n), routine_id: 'r1', routine_name: 'Push', prs: [],
      sets: Array.from({ length: 3 }, (_, i) => ({
        id: `${id}:${i}`, workout_id: id, exercise_id: '0025', position: i,
        weight_kg: 100, reps, seconds: null, distance_m: null, per_side: false,
        effort_value: null, effort_scale: null, is_warmup: false, done: true, done_at: day(n)
      }))
    })
    await c.post('/api/sync', {
      changes: {
        routines: [{ id: 'r1', name: 'Push', policy: 'linear', exercises: [{ id: '0025', sets: 3, reps: 5 }] }],
        weekPlan: [{ weekday: 1, routine_id: 'r1' }, { weekday: 3, routine_id: 'r1' }],
        workouts: [session('w1', 20, 5), session('w2', 15, 4), session('w3', 10, 4), session('w4', 3, 3)]
      }
    })
  }

  it('drafts a change without sending it', async () => {
    const { coach, client_ } = await linked()
    await stalledHistory(client_.c)

    const r = await coach.c.post(`/api/coach/clients/${client_.user.id}/ai-review`, {})
    expect(r.status).toBe(200)
    expect(r.body.change).toBeTruthy()
    expect(r.body.note).toBeTruthy()

    // the client's inbox is empty: drafting is not proposing
    expect((await client_.c.get('/api/proposals')).body.proposals).toHaveLength(0)
    // and their routine is untouched
    expect((await client_.c.get('/api/sync/all')).body.changes.routines[0].name).toBe('Push')
  })

  it('hands the coach something they can send as-is', async () => {
    const { coach, client_ } = await linked()
    await stalledHistory(client_.c)
    const draft = (await coach.c.post(`/api/coach/clients/${client_.user.id}/ai-review`, {})).body

    const sent = await coach.c.post(`/api/coach/clients/${client_.user.id}/propose`, {
      routineId: draft.change.routineId,
      payload: draft.change.payload,
      note: draft.note
    })
    expect(sent.status).toBe(200)
    const inbox = await client_.c.get('/api/proposals')
    expect(inbox.body.proposals).toHaveLength(1)
    expect(inbox.body.proposals[0].note).toBe(draft.note)
  })

  it('says so when nothing needs changing', async () => {
    const { coach, client_ } = await linked()
    const r = await coach.c.post(`/api/coach/clients/${client_.user.id}/ai-review`, {})
    expect(r.body.change).toBeNull()
    // Unrendered on the wire — the review carries `{ msg, args }` so the client can translate
    // it, and `say()` is what turns that back into the English the server would have written.
    expect(say(r.body.headline)).toMatch(/nothing to change/i)
  })

  it('refuses when the client never shared their workouts', async () => {
    // a review of training you have not been shown would be a guess dressed as analysis
    const { coach, client_ } = await linked(['programmes'])
    const r = await coach.c.post(`/api/coach/clients/${client_.user.id}/ai-review`, {})
    expect(r.status).toBe(403)
  })

  it('refuses a stranger', async () => {
    const { client_ } = await linked()
    const nosy = await signUp('Nosy', 'nosy@x.test')
    expect((await nosy.c.post(`/api/coach/clients/${client_.user.id}/ai-review`, {})).status).toBe(403)
  })

  it('only ever proposes exercises that exist', async () => {
    const { coach, client_ } = await linked()
    await stalledHistory(client_.c)
    const draft = (await coach.c.post(`/api/coach/clients/${client_.user.id}/ai-review`, {})).body
    for (const e of draft.change.payload.exercises) {
      const rows = await db()`select id from exercises where id = ${'lib:' + e.id}`
      expect(rows).toHaveLength(1)
    }
  })
})

describe('logging by typing', () => {
  it('reads the shorthand', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    const r = await c.post('/api/ai/parse-log', { text: 'bench 5x5 at 80' })
    expect(r.status).toBe(200)
    expect(r.body.entries).toHaveLength(1)
    expect(r.body.entries[0].name).toMatch(/bench press/i)
    expect(r.body.entries[0].sets[0]).toMatchObject({ w: 80, r: 5 })
  })

  it('knows your own exercises', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    await c.post('/api/sync', { changes: { exercises: [{ id: 'c1', name: 'Sled push', body_part: 'upper legs' }] } })
    const r = await c.post('/api/ai/parse-log', { text: 'sled push 4x20 at 60' })
    expect(r.body.entries[0].id).toBe('c1')
    expect(r.body.entries[0].name).toBe('Sled push')
  })

  it('says what it could not read instead of guessing', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    const r = await c.post('/api/ai/parse-log', { text: 'flurbulator 5x5 at 80' })
    expect(r.body.entries).toHaveLength(0)
    expect(r.body.unresolved).toHaveLength(1)
  })

  it('does not save what it read', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    await c.post('/api/ai/parse-log', { text: 'bench 5x5 at 80' })
    expect((await c.get('/api/sync/all')).body.changes.workouts).toHaveLength(0)
  })

  it('refuses an empty or enormous input', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    expect((await c.post('/api/ai/parse-log', { text: '   ' })).status).toBe(400)
    expect((await c.post('/api/ai/parse-log', { text: 'x'.repeat(3000) })).status).toBe(400)
  })
})
