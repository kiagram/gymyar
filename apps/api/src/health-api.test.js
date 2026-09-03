/* The iOS shortcut's endpoint, over HTTP — docs/WEARABLES.md M3.
 *
 * Two callers with two credentials, which is the thing worth testing: a person in the app with
 * a session cookie mints and revokes, and a shortcut on a locked phone months later presents a
 * bearer token and has never had a cookie at all.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { build } from './app.js'
import { client } from './test-client.js'
import { db, close } from '@gymyar/db'

let app
const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL

beforeAll(async () => {
  process.env.SESSION_SECRET = 'test-secret-not-for-production'
  app = await build({ databaseUrl: URL, rateLimit: false })
  const { seedExercises } = await import('@gymyar/db/seed-exercises.js')
  await seedExercises()
})
beforeEach(async () => { await db()`delete from users` })
afterAll(async () => { await app.close(); await close() })

const signUp = async (name, email) => {
  const c = client(app)
  const r = await c.post('/api/register/password', { name, email, password: 'correct-horse-battery' })
  expect(r.status).toBe(200)
  return { c, user: r.body.user }
}

/** A signed-up account with a health token, the way somebody would set one up. */
const paired = async (email = 'sam@x.test') => {
  const { c, user } = await signUp('Sam', email)
  const r = await c.post('/api/health/tokens')
  expect(r.status).toBe(200)
  return { c, user, secret: r.body.secret, id: r.body.token.id }
}

/* The shortcut's own call: a bearer token and no cookie jar, which is the whole point. */
const push = (secret, body) => app.inject({
  method: 'POST', url: '/api/health/workout',
  headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
  payload: body
}).then(res => ({ status: res.statusCode, body: (() => { try { return res.json() } catch { return null } })() }))

const RUN = {
  uuid: 'D6E1D7A0-0000-4000-8000-000000000001',
  type: 'HKWorkoutActivityTypeRunning',
  start: '2026-09-01T18:00:00Z',
  end: '2026-09-01T18:35:00Z',
  distanceKm: '7.2',
  hrAvg: '148', hrMin: '96', hrMax: '171', hrSamples: '2100'
}

describe('pairing', () => {
  it('shows the secret exactly once, and never again', async () => {
    const { c, secret, id } = await paired()
    expect(secret).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    const list = await c.get('/api/health/tokens')
    expect(list.body.tokens).toHaveLength(1)
    expect(list.body.tokens[0].id).toBe(id)
    // Nothing in the listing can be used to make a request
    expect(JSON.stringify(list.body)).not.toContain(secret)
  })

  it('keeps the plaintext out of the database', async () => {
    const { secret } = await paired()
    const [row] = await db()`select token_hash from health_tokens`
    expect(row.token_hash).not.toBe(secret)
    expect(row.token_hash).not.toContain(secret)
  })

  it('lets one device be revoked without breaking the other', async () => {
    const { c, secret } = await paired()
    const second = await c.post('/api/health/tokens')
    expect((await c.get('/api/health/tokens')).body.tokens).toHaveLength(2)

    expect((await c.del(`/api/health/tokens/${second.body.token.id}`)).status).toBe(200)
    expect((await c.get('/api/health/tokens')).body.tokens).toHaveLength(1)
    expect((await push(second.body.secret, RUN)).status).toBe(401)
    expect((await push(secret, RUN)).status).toBe(201)
  })

  it('will not let one account revoke another account s token', async () => {
    const mine = await paired('sam@x.test')
    const theirs = await paired('alex@x.test')
    expect((await theirs.c.del(`/api/health/tokens/${mine.id}`)).status).toBe(404)
    expect((await push(mine.secret, RUN)).status).toBe(201)
  })

  it('refuses an eleventh live token rather than letting the list stop being usable', async () => {
    const { c } = await paired()
    for (let i = 0; i < 9; i++) expect((await c.post('/api/health/tokens')).status).toBe(200)
    expect((await c.post('/api/health/tokens')).status).toBe(409)
  })

  it('needs an account to mint one at all', async () => {
    expect((await client(app).post('/api/health/tokens')).status).toBe(401)
  })
})

describe('a session pushed from a phone', () => {
  it('lands as a workout on the account the token belongs to', async () => {
    const { c, secret, user } = await paired()
    const r = await push(secret, RUN)
    expect(r.status).toBe(201)
    expect(r.body.workout.created).toBe(true)

    const sync = await c.get('/api/sync/all')
    const [w] = sync.body.changes.workouts
    expect(w.external_id).toBe(RUN.uuid)
    expect(w.routine_name).toBe('Running')
    expect(w.user_id).toBe(user.id)
    expect(w.hr_avg_bpm).toBe(148)
    expect(w.sets).toHaveLength(1)
    expect(w.sets[0].exercise_id).toBe('0685')     // the library's run, matched not invented
    expect(w.sets[0].seconds).toBe(2100)
    expect(Number(w.sets[0].distance_m)).toBe(7200)
  })

  it('is the same workout however many times it arrives', async () => {
    // The plan's own words: automations re-fire, and people re-run a shortcut by hand when
    // they think nothing happened. Neither may add a second session.
    const { c, secret } = await paired()
    expect((await push(secret, RUN)).status).toBe(201)
    const again = await push(secret, RUN)
    expect(again.status).toBe(200)
    expect(again.body.workout.created).toBe(false)
    expect((await c.get('/api/sync/all')).body.changes.workouts).toHaveLength(1)
  })

  it('takes a correction on the second arrival rather than ignoring it', async () => {
    const { c, secret } = await paired()
    await push(secret, RUN)
    await push(secret, { ...RUN, end: '2026-09-01T18:40:00Z', hrAvg: '150', hrMax: '180' })
    const [w] = (await c.get('/api/sync/all')).body.changes.workouts
    expect(w.hr_avg_bpm).toBe(150)
    expect(w.hr_max_bpm).toBe(180)
  })

  it('lets two accounts hold the same HealthKit uuid', async () => {
    // One family phone, two accounts. A globally unique constraint would let whoever pushed
    // first lock the other out of their own session.
    const a = await paired('sam@x.test')
    const b = await paired('alex@x.test')
    expect((await push(a.secret, RUN)).status).toBe(201)
    expect((await push(b.secret, RUN)).status).toBe(201)
    expect((await b.c.get('/api/sync/all')).body.changes.workouts).toHaveLength(1)
  })

  it('records a session the library has no exercise for, with no sets and no invention', async () => {
    const { c, secret } = await paired()
    await push(secret, { ...RUN, type: 'HKWorkoutActivityTypeTraditionalStrengthTraining', distanceKm: '' })
    const [w] = (await c.get('/api/sync/all')).body.changes.workouts
    expect(w.routine_name).toBe('Traditional strength training')
    expect(w.sets).toHaveLength(0)
    expect(w.hr_avg_bpm).toBe(148)
  })

  it('reaches a phone that is already syncing, on its next pull', async () => {
    const { c, secret } = await paired()
    const before = (await c.get('/api/sync/all')).body.cursor
    await push(secret, RUN)
    const delta = await c.get(`/api/sync?since=${before}`)
    expect(delta.body.changes.workouts).toHaveLength(1)
  })
})

describe('what it refuses', () => {
  it('will not take a session without a token', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/health/workout', payload: RUN })
    expect(r.statusCode).toBe(401)
    expect((await push('not-a-real-token', RUN)).status).toBe(401)
  })

  it('will not take one without a uuid, because that is the whole of the idempotency', async () => {
    const { secret } = await paired()
    const { uuid, ...noId } = RUN
    expect((await push(secret, noId)).status).toBe(400)
  })

  it('refuses a date it would have to guess at', async () => {
    // "03/09/2026" is two different days depending on who wrote it, and a session filed on the
    // wrong one is worse than one refused with a message.
    const { secret } = await paired()
    expect((await push(secret, { ...RUN, start: '03/09/2026' })).status).toBe(400)
    expect((await push(secret, { ...RUN, start: '1 Sep 2026 18:00' })).status).toBe(400)
    expect((await push(secret, { ...RUN, start: '' })).status).toBe(400)
    expect((await push(secret, { ...RUN, end: '2026-09-01T17:00:00Z' })).status).toBe(400)
  })

  it('refuses an ISO date that does not say which zone it is in', async () => {
    // Without an offset the spec says local time, and local means the *server's* — so a 21:00
    // session in Tehran filed by an instance running in UTC lands on the following day.
    const { c, secret } = await paired()
    expect((await push(secret, { ...RUN, start: '2026-09-01T18:00:00' })).status).toBe(400)
    expect((await push(secret, { ...RUN, start: '2026-09-01T18:00:00+03:30' })).status).toBe(201)
    const [w] = (await c.get('/api/sync/all')).body.changes.workouts
    expect(new Date(w.started_at).toISOString()).toBe('2026-09-01T14:30:00.000Z')
  })

  it('drops half a heart rate rather than failing the whole session on it', async () => {
    // Every one of these fields is a step somebody adds to a shortcut by hand, so a partly
    // wired-up one is the normal case — and the four columns are all-or-nothing in the schema.
    const { c, secret } = await paired()
    expect((await push(secret, { ...RUN, hrMin: '', hrMax: '' })).status).toBe(201)
    const [w] = (await c.get('/api/sync/all')).body.changes.workouts
    expect(w.hr_avg_bpm).toBeNull()
    expect(w.routine_name).toBe('Running')
  })

  it('drops a heart rate no heart produced, and keeps the session', async () => {
    const { c, secret } = await paired()
    expect((await push(secret, { ...RUN, hrMax: '400' })).status).toBe(201)
    expect((await c.get('/api/sync/all')).body.changes.workouts[0].hr_avg_bpm).toBeNull()
  })

  it('takes a session with nothing but a uuid and a start', async () => {
    const { c, secret } = await paired()
    expect((await push(secret, { uuid: 'bare-1', start: '2026-09-02T07:00:00Z' })).status).toBe(201)
    const [w] = (await c.get('/api/sync/all')).body.changes.workouts
    expect(w.routine_name).toBe('Workout')
    expect(w.finished_at).toBeNull()
  })
})

describe('whether the automation is still firing', () => {
  it('records when the token was last used, since nothing else can say', async () => {
    const { c, secret } = await paired()
    expect((await c.get('/api/health/tokens')).body.tokens[0].last_used_at).toBeNull()
    await push(secret, RUN)
    expect((await c.get('/api/health/tokens')).body.tokens[0].last_used_at).not.toBeNull()
  })
})
