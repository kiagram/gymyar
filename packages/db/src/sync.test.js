import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { setupDb, truncateUsers, teardownDb } from './test-helpers.js'
import { createUser } from './users.js'
import { pull, pullAll, push } from './sync.js'
import { importState, exportState } from './import-blob.js'

let s
beforeAll(async () => { s = await setupDb() })
beforeEach(truncateUsers)
afterAll(teardownDb)

const routine = (id, name) => ({ id, name, exercises: [{ id: '0025', sets: 3, reps: 5 }] })
const workout = (id, at) => ({
  id, started_at: at, finished_at: at, routine_id: 'r1', routine_name: 'Push', prs: [],
  sets: [{
    id: `${id}:0`, workout_id: id, exercise_id: '0025', position: 0,
    weight_kg: 100, reps: 5, seconds: null, distance_m: null, per_side: false,
    effort_value: 2, effort_scale: 'rir', is_warmup: false, done: true, done_at: at
  }]
})

describe('delta sync', () => {
  it('starts at cursor 0 with nothing to send', async () => {
    const u = await createUser({ name: 'A' })
    expect(await pull(u.id, 0)).toEqual({ cursor: 0, changes: {} })
  })

  it('returns only what changed since the given cursor', async () => {
    const u = await createUser({ name: 'A' })
    const first = await push(u.id, { routines: [routine('r1', 'Push')] })
    expect(first.cursor).toBeGreaterThan(0)

    await push(u.id, { routines: [routine('r2', 'Pull')] })
    const delta = await pull(u.id, first.cursor)
    expect(delta.changes.routines).toHaveLength(1)
    expect(delta.changes.routines[0].id).toBe('r2')
  })

  it('sends a row edited many times offline exactly once', async () => {
    const u = await createUser({ name: 'A' })
    const base = await pull(u.id, 0)
    for (let i = 0; i < 20; i++) await push(u.id, { routines: [routine('r1', `Push v${i}`)] })
    const delta = await pull(u.id, base.cursor)
    expect(delta.changes.routines).toHaveLength(1)
    expect(delta.changes.routines[0].name).toBe('Push v19')
  })

  it('reports a delete so an offline device removes it too', async () => {
    const u = await createUser({ name: 'A' })
    const after = await push(u.id, { routines: [routine('r1', 'Push')] })
    await push(u.id, { routines: [{ id: 'r1', deleted: true }] })
    const delta = await pull(u.id, after.cursor)
    expect(delta.changes.routines[0].deleted_at).not.toBeNull()
  })

  it('replaces a workout\'s sets rather than accumulating them', async () => {
    const u = await createUser({ name: 'A' })
    const at = '2026-08-01T18:00:00Z'
    await push(u.id, { workouts: [workout('w1', at)] })
    const twoSets = workout('w1', at)
    twoSets.sets.push({ ...twoSets.sets[0], id: 'w1:1', position: 1, reps: 4 })
    await push(u.id, { workouts: [twoSets] })
    const { changes } = await pullAll(u.id)
    expect(changes.workouts[0].sets).toHaveLength(2)
    const [{ count }] = await s`select count(*)::int from workout_sets where workout_id = 'w1'`
    expect(count).toBe(2)
  })

  it('merges settings instead of replacing them', async () => {
    const u = await createUser({ name: 'A' })
    await push(u.id, { settings: { unit: 'kg', restSec: 90 } })
    await push(u.id, { settings: { theme: 'light' } })   // a device that never saw restSec
    const { changes } = await pullAll(u.id)
    expect(changes.settings).toMatchObject({ unit: 'kg', restSec: 90, theme: 'light' })
  })

  it('lets two users weigh in on the same day', async () => {
    // caught by the demo seeder: body-weight rows used to derive an id from the date alone,
    // so the second user's weigh-in collided with the first's and the write was refused
    const a = await createUser({ name: 'A' })
    const b = await createUser({ name: 'B' })
    const day = { on_date: '2026-06-01', weight_kg: 82 }
    await push(a.id, { bodyweight: [day] })
    await push(b.id, { bodyweight: [{ ...day, weight_kg: 71 }] })
    expect(Number((await pullAll(a.id)).changes.bodyweight[0].weight_kg)).toBe(82)
    expect(Number((await pullAll(b.id)).changes.bodyweight[0].weight_kg)).toBe(71)
  })

  it('keeps two users entirely separate', async () => {
    const a = await createUser({ name: 'A' })
    const b = await createUser({ name: 'B' })
    await push(a.id, { routines: [routine('r1', 'A only')] })
    expect((await pullAll(b.id)).changes.routines).toHaveLength(0)
    expect((await pull(b.id, 0)).changes).toEqual({})
  })

  it('refuses to let one user overwrite another\'s row', async () => {
    const a = await createUser({ name: 'A' })
    const b = await createUser({ name: 'B' })
    await push(a.id, { routines: [routine('r1', 'A only')] })
    // b pushes a row whose id belongs to a. The guarded upsert must not touch a's data.
    await expect(push(b.id, { routines: [routine('r1', 'hijacked')] })).rejects.toThrow()
    const { changes } = await pullAll(a.id)
    expect(changes.routines[0].name).toBe('A only')
  })

  it('rolls the whole push back when one row fails', async () => {
    const u = await createUser({ name: 'A' })
    const before = await pull(u.id, 0)
    await expect(push(u.id, {
      routines: [routine('r1', 'Good')],
      // a workout with a set that violates its foreign key
      workouts: [{ ...workout('w1', '2026-08-01T18:00:00Z'), started_at: null }]
    })).rejects.toThrow()
    const after = await pull(u.id, before.cursor)
    expect(after.changes.routines ?? []).toHaveLength(0)
  })
})

describe('openGym blob import', () => {
  const S = {
    unit: 'lb', restSec: 120, theme: 'dark',
    routines: [{ id: 'r1', name: 'Push', emoji: '💪', ex: [{ id: '0025', sets: 3, reps: 5 }] }],
    week: { 1: 'r1' },
    dayPlan: { '2026-08-05': 'r1' },
    bodyweight: [{ d: '2026-08-01', w: 180 }],
    customEx: [{ id: 'c1', n: 'Sled push', bp: 'upper legs', eq: 'sled' }],
    workouts: [{
      id: 'w1', d: '2026-08-01', start: Date.parse('2026-08-01T18:00:00Z'),
      end: Date.parse('2026-08-01T19:00:00Z'), routineId: 'r1', name: 'Push', bw: 180,
      prs: ['0025'],
      entries: [{ id: '0025', sets: [{ w: 225, r: 5, done: true, rir: 1 }] }]
    }]
  }

  it('round-trips a whole account, pounds and all', async () => {
    const u = await createUser({ name: 'Migrated' })
    await importState(u.id, S)
    const back = await exportState(u.id)

    expect(back.unit).toBe('lb')
    expect(back.restSec).toBe(120)
    expect(back.routines[0]).toMatchObject({ id: 'r1', name: 'Push', emoji: '💪' })
    expect(back.week).toEqual({ 1: 'r1' })
    expect(back.dayPlan).toEqual({ '2026-08-05': 'r1' })
    expect(back.customEx[0]).toMatchObject({ id: 'c1', n: 'Sled push' })
    expect(back.bodyweight[0].w).toBeCloseTo(180, 0)
    expect(back.workouts[0].entries[0].sets[0].w).toBeCloseTo(225, 0)
    expect(back.workouts[0].entries[0].sets[0].rir).toBe(1)
    expect(back.workouts[0].prs).toEqual(['0025'])
  })

  it('stores pounds as kilograms so the server can compare two profiles', async () => {
    const u = await createUser({ name: 'Migrated' })
    await importState(u.id, S)
    const [set] = await s`select weight_kg from workout_sets where user_id = ${u.id}`
    expect(Number(set.weight_kg)).toBeCloseTo(102.06, 1)
  })

  it('is idempotent — importing twice does not duplicate anything', async () => {
    const u = await createUser({ name: 'Migrated' })
    await importState(u.id, S)
    await importState(u.id, S)
    const back = await exportState(u.id)
    expect(back.workouts).toHaveLength(1)
    expect(back.routines).toHaveLength(1)
    expect(back.bodyweight).toHaveLength(1)
  })
})
