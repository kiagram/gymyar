/* The one endpoint with no account behind it.
 *
 * Two things are worth holding still here. It has to count the right rows — warm-ups and
 * abandoned sessions are not training anybody did, and a landing page that counts them is
 * lying quietly. And it must never grow a field that names somebody: the assertion at the
 * bottom is written against the whole response rather than against a list of things not to
 * say, so a future field arrives as a failing test rather than as a leak.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { build } from './app.js'
import { client } from './test-client.js'
import { db, close } from '@gymyar/db'
import { _resetStatsCache } from './routes/public.js'

let app
const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL

beforeAll(async () => {
  process.env.SESSION_SECRET = 'test-secret-not-for-production'
  app = await build({ databaseUrl: URL, rateLimit: false })
  const { seedExercises } = await import('@gymyar/db/seed-exercises.js')
  await seedExercises()
})
beforeEach(async () => {
  await db()`delete from users`
  // The route hands out a five-minute-old answer on purpose. Every test below changes the
  // database and then asks, so every test has to clear it first.
  _resetStatsCache()
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

/** One finished session: a working set, a warm-up, and a plank that has no tonnage. */
const logSession = async (c, id) => {
  const now = new Date().toISOString()
  const set = (sid, over) => ({
    id: sid, workout_id: id, exercise_id: '0025', position: 0,
    weight_kg: null, reps: null, seconds: null, distance_m: null, per_side: false,
    effort_value: null, effort_scale: null, is_warmup: false, done: true, done_at: now, ...over
  })
  const r = await c.post('/api/sync', {
    changes: {
      workouts: [{
        id, started_at: now, finished_at: now, routine_name: 'Test', sets: [
          set(id + '-w', { weight_kg: 40, reps: 10, is_warmup: true }),
          set(id + '-s', { weight_kg: 100, reps: 5 }),
          set(id + '-p', { seconds: 60 })
        ]
      }]
    }
  })
  expect(r.status).toBe(200)
}

describe('public counters', () => {
  it('counts accounts, finished sessions and working sets', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    await signUp('Coach', 'coach@x.test', { asCoach: true })
    await logSession(c, 'pub-w1')

    const { status, body } = await client(app).get('/api/public/stats')
    expect(status).toBe(200)
    expect(body.stats.athletes).toBe(2)
    expect(body.stats.coaches).toBe(1)
    expect(body.stats.workouts).toBe(1)
    // The warm-up and the plank are rows; one working set is the answer, and the plank still
    // counts as a set even though it weighs nothing.
    expect(body.stats.sets).toBe(2)
    // 100 × 5. The warm-up's 400 is excluded and the plank contributes nothing rather than 0×0.
    expect(body.stats.volumeKg).toBe(500)
    expect(body.stats.exercises).toBeGreaterThan(1000)
  })

  it('does not count a session that was never finished', async () => {
    const { c } = await signUp('Ada', 'ada@x.test')
    const now = new Date().toISOString()
    await c.post('/api/sync', {
      changes: { workouts: [{ id: 'pub-open', started_at: now, finished_at: null, sets: [] }] }
    })
    const { body } = await client(app).get('/api/public/stats')
    expect(body.stats.workouts).toBe(0)
  })

  it('answers without a session cookie, and lets a cache keep it', async () => {
    const r = await client(app).get('/api/public/stats')
    expect(r.status).toBe(200)
    // Every other route in this API is no-store. This is the exception, and the exception is
    // the point: it is the same answer for everybody.
    expect(r.headers['cache-control']).toMatch(/max-age=\d+/)
    expect(r.headers['cache-control']).not.toMatch(/no-store/)
  })

  it('says nothing that names anybody', async () => {
    await signUp('Ada Lovelace', 'ada@x.test')
    const { body } = await client(app).get('/api/public/stats')
    // Whole-response, not field-by-field: a field added later is caught here rather than
    // shipped. Every value must be a number; the only string is the timestamp.
    expect(Object.values(body.stats).every(v => typeof v === 'number')).toBe(true)
    expect(JSON.stringify(body)).not.toMatch(/Ada|ada@x\.test/)
    expect(Object.keys(body).sort()).toEqual(['generatedAt', 'stats'])
  })

  it('is not there at all when the instance turns it off', async () => {
    const off = await build({
      databaseUrl: URL, rateLimit: false, runMigrations: false, publicStats: false
    })
    try {
      // A 404 and not a 403: off means the route was never registered, so there is nothing
      // here to be refused access to.
      expect((await client(off).get('/api/public/stats')).status).toBe(404)
    } finally { await off.close() }
  })
})
