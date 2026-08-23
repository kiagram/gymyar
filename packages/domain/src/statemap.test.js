import { describe, it, expect } from 'vitest'
import {
  stateToRows, applyRows, workoutToRows, rowsToWorkout, setToRow, rowToSet, toKg, fromKg
} from './statemap.js'

// The app decides a set's shape from the routine config; the tests pin it explicitly so a
// change in modeOf can't silently alter what these assert.
const modeReps   = () => 'reps'
const modeTime   = () => 'time'
const modeCardio = () => 'cardio'

describe('units', () => {
  it('round-trips pounds without drift', () => {
    for (const v of [45, 135, 225, 315, 2.5, 0]) {
      expect(fromKg(toKg(v, 'lb'), 'lb')).toBeCloseTo(v, 2)
    }
  })
  it('leaves kilograms alone', () => {
    expect(toKg(100, 'kg')).toBe(100)
    expect(fromKg(100, 'kg')).toBe(100)
  })
  it('a pound user is not silently read as kilograms', () => {
    // the failure this guards: assuming kg would store 225 as 225kg — a 2.2× fabrication
    expect(toKg(225, 'lb')).toBeCloseTo(102.06, 1)
  })
})

describe('sets', () => {
  const ctx = { workoutId: 'w1', userId: 'u1', exerciseId: '0025', position: 0, unit: 'kg' }

  it('round-trips a reps set with RIR', () => {
    const s = { w: 100, r: 5, done: true, rir: 2 }
    const back = rowToSet(setToRow(s, { ...ctx, mode: 'reps' }), { unit: 'kg', mode: 'reps' })
    expect(back).toMatchObject({ w: 100, r: 5, rir: 2, done: true })
    expect(back.rpe).toBeUndefined()
  })

  it('keeps RPE as RPE even though it is stored as RIR', () => {
    const row = setToRow({ w: 80, r: 8, rpe: 8 }, { ...ctx, mode: 'reps' })
    expect(row.effort_value).toBe(2)        // normalised for comparison across profiles
    expect(row.effort_scale).toBe('rpe')    // …but the scale it was logged on survives
    const back = rowToSet(row, { unit: 'kg', mode: 'reps' })
    expect(back.rpe).toBe(8)
    expect(back.rir).toBeUndefined()
  })

  it('never turns an unlogged effort into failure', () => {
    const row = setToRow({ w: 60, r: 10 }, { ...ctx, mode: 'reps' })
    expect(row.effort_value).toBeNull()
    const back = rowToSet(row, { unit: 'kg', mode: 'reps' })
    expect(back.rir).toBeUndefined()
    expect(back.rpe).toBeUndefined()
  })

  it('round-trips a loaded timed set', () => {
    const row = setToRow({ sec: 45, w: 20, done: true }, { ...ctx, mode: 'time' })
    expect(row.seconds).toBe(45)
    expect(rowToSet(row, { unit: 'kg', mode: 'time' })).toMatchObject({ sec: 45, w: 20 })
  })

  it('stores cardio as distance and duration, and recovers the speed', () => {
    const row = setToRow({ min: 30, speed: 12 }, { ...ctx, mode: 'cardio' })
    expect(row.seconds).toBe(1800)
    expect(Number(row.distance_m)).toBeCloseTo(6000, 0)   // the number a coach actually wants
    expect(rowToSet(row, { unit: 'kg', mode: 'cardio' })).toMatchObject({ min: 30, speed: 12 })
  })

  it('does not divide by zero on a cardio set with no duration', () => {
    const row = setToRow({ min: 0, speed: 0 }, { ...ctx, mode: 'cardio' })
    expect(rowToSet(row, { unit: 'kg', mode: 'cardio' }).speed).toBe(0)
  })

  it('carries a skipped set through as skipped', () => {
    const row = setToRow({ w: 50, r: 5, done: false }, { ...ctx, mode: 'reps' })
    expect(row.done).toBe(false)
    expect(rowToSet(row, { unit: 'kg', mode: 'reps' }).done).toBe(false)
  })
})

describe('workouts', () => {
  const w = {
    id: 'w1', d: '2026-08-01', start: Date.parse('2026-08-01T18:00:00Z'),
    end: Date.parse('2026-08-01T19:00:00Z'), routineId: 'r1', name: 'Push', bw: 82,
    prs: ['0025'],
    entries: [
      { id: '0025', sets: [{ w: 100, r: 5, done: true }, { w: 100, r: 4, done: true, rir: 0 }] },
      { id: '0043', sets: [{ w: 60, r: 10, done: true }] }
    ]
  }

  it('round-trips a whole session', () => {
    const { workout, sets } = workoutToRows(w, { userId: 'u1', unit: 'kg', modeFor: modeReps })
    expect(sets).toHaveLength(3)
    const back = rowsToWorkout(workout, sets, { unit: 'kg', modeFor: modeReps })
    expect(back.id).toBe('w1')
    expect(back.name).toBe('Push')
    expect(back.bw).toBe(82)
    expect(back.prs).toEqual(['0025'])
    expect(back.entries).toHaveLength(2)
    expect(back.entries[0].sets).toHaveLength(2)
    expect(back.entries[1].id).toBe('0043')
  })

  it('recomputes volume and top weight', () => {
    const { workout, sets } = workoutToRows(w, { userId: 'u1', unit: 'kg', modeFor: modeReps })
    const back = rowsToWorkout(workout, sets, { unit: 'kg', modeFor: modeReps })
    expect(back.vol).toBe(100 * 5 + 100 * 4 + 60 * 10)
    expect(back.entries[0].topW).toBe(100)
  })

  it('keeps the same exercise twice in a session as two entries', () => {
    // grouping by exercise id instead of by position would merge these, and a routine that
    // opens and closes on the same movement is a real thing people write
    const twice = { ...w, entries: [
      { id: '0025', sets: [{ w: 100, r: 5 }] },
      { id: '0043', sets: [{ w: 60, r: 10 }] },
      { id: '0025', sets: [{ w: 80, r: 12 }] }
    ] }
    const { workout, sets } = workoutToRows(twice, { userId: 'u1', unit: 'kg', modeFor: modeReps })
    const back = rowsToWorkout(workout, sets, { unit: 'kg', modeFor: modeReps })
    expect(back.entries.map(e => e.id)).toEqual(['0025', '0043', '0025'])
  })

  it('survives a pound profile intact', () => {
    const lb = { ...w, entries: [{ id: '0025', sets: [{ w: 225, r: 5 }] }], bw: 180 }
    const { workout, sets } = workoutToRows(lb, { userId: 'u1', unit: 'lb', modeFor: modeReps })
    expect(Number(workout.bodyweight_kg)).toBeCloseTo(81.6, 1)
    const back = rowsToWorkout(workout, sets, { unit: 'lb', modeFor: modeReps })
    expect(back.entries[0].sets[0].w).toBeCloseTo(225, 1)
    expect(back.bw).toBeCloseTo(180, 1)
  })
})

describe('whole state', () => {
  const S = {
    unit: 'kg', restSec: 90, theme: 'dark', accent: 'lime',
    routines: [{ id: 'r1', name: 'Push', emoji: '💪', ex: [{ id: '0025', sets: 3, reps: 5 }] }],
    week: { 1: 'r1', 3: 'r1' },
    dayPlan: { '2026-08-05': 'r1' },
    bodyweight: [{ d: '2026-08-01', w: 82 }],
    customEx: [{ id: 'c1', n: 'Sled push', bp: 'legs', eq: 'sled' }],
    workouts: [{
      id: 'w1', d: '2026-08-01', start: Date.parse('2026-08-01T18:00:00Z'),
      end: Date.parse('2026-08-01T19:00:00Z'), routineId: 'r1', name: 'Push',
      entries: [{ id: '0025', sets: [{ w: 100, r: 5, done: true }] }]
    }]
  }

  it('maps every part of the state to rows', () => {
    const rows = stateToRows(S, { userId: 'u1', modeFor: modeReps })
    expect(rows.routines).toHaveLength(1)
    expect(rows.routines[0].exercises).toEqual([{ id: '0025', sets: 3, reps: 5 }])
    expect(rows.workouts).toHaveLength(1)
    expect(rows.workoutSets).toHaveLength(1)
    expect(rows.bodyweight).toHaveLength(1)
    expect(rows.bodyweight[0].id).toBeUndefined()
    expect(rows.weekPlan).toEqual([
      { user_id: 'u1', weekday: 1, routine_id: 'r1' },
      { user_id: 'u1', weekday: 3, routine_id: 'r1' }
    ])
    expect(rows.dayOverrides).toHaveLength(1)
    expect(rows.exercises[0].name).toBe('Sled push')
    expect(rows.settings.restSec).toBe(90)
    expect(rows.settings.theme).toBe('dark')
  })

  it('does not leak training data into the settings blob', () => {
    const rows = stateToRows(S, { userId: 'u1', modeFor: modeReps })
    expect(rows.settings.workouts).toBeUndefined()
    expect(rows.settings.routines).toBeUndefined()
    expect(rows.settings.bodyweight).toBeUndefined()
  })

  it('completes a full state → rows → state round trip', () => {
    const rows = stateToRows(S, { userId: 'u1', modeFor: modeReps })
    const back = applyRows({}, {
      settings: rows.settings,
      routines: rows.routines,
      workouts: rows.workouts.map(w => ({
        ...w, sets: rows.workoutSets.filter(s => s.workout_id === w.id)
      })),
      bodyweight: rows.bodyweight,
      exercises: rows.exercises,
      weekPlan: rows.weekPlan,
      dayOverrides: rows.dayOverrides
    }, { modeFor: modeReps })

    expect(back.unit).toBe('kg')
    expect(back.restSec).toBe(90)
    expect(back.routines[0]).toMatchObject({ id: 'r1', name: 'Push', emoji: '💪' })
    expect(back.week).toEqual({ 1: 'r1', 3: 'r1' })
    expect(back.dayPlan).toEqual({ '2026-08-05': 'r1' })
    expect(back.bodyweight[0]).toMatchObject({ d: '2026-08-01', w: 82 })
    expect(back.customEx[0]).toMatchObject({ id: 'c1', n: 'Sled push' })
    expect(back.workouts[0].entries[0].sets[0]).toMatchObject({ w: 100, r: 5 })
  })
})

describe('applying a delta', () => {
  const base = {
    unit: 'kg',
    routines: [{ id: 'r1', name: 'Push', ex: [] }, { id: 'r2', name: 'Pull', ex: [] }],
    workouts: [], bodyweight: [], week: { 1: 'r1' }, dayPlan: {}, customEx: []
  }

  it('upserts and deletes routines without touching the rest', () => {
    const next = applyRows(base, {
      routines: [
        { id: 'r1', name: 'Push A', exercises: [], policy: 'linear' },
        { id: 'r2', deleted_at: '2026-08-01T00:00:00Z' },
        { id: 'r3', name: 'Legs', exercises: [], policy: 'linear' }
      ]
    }, { modeFor: modeReps })
    expect(next.routines.map(r => r.id).sort()).toEqual(['r1', 'r3'])
    expect(next.routines.find(r => r.id === 'r1').name).toBe('Push A')
    expect(next.week).toEqual({ 1: 'r1' })      // untouched by a routines-only delta
  })

  it('does not mutate the state it was given', () => {
    const before = JSON.stringify(base)
    applyRows(base, { routines: [{ id: 'r9', name: 'New', exercises: [] }] }, { modeFor: modeReps })
    expect(JSON.stringify(base)).toBe(before)
  })

  it('keeps workouts in chronological order however they arrive', () => {
    const mk = (id, t) => ({
      id, user_id: 'u1', started_at: t, finished_at: t, routine_id: null,
      routine_name: null, bodyweight_kg: null, prs: [], sets: []
    })
    const next = applyRows(base, {
      workouts: [mk('c', '2026-08-03T10:00:00Z'), mk('a', '2026-08-01T10:00:00Z'), mk('b', '2026-08-02T10:00:00Z')]
    }, { modeFor: modeReps })
    expect(next.workouts.map(w => w.id)).toEqual(['a', 'b', 'c'])
  })

  it('clears a weekday when its routine is removed', () => {
    const next = applyRows(base, { weekPlan: [{ weekday: 1, routine_id: null }] }, { modeFor: modeReps })
    expect(next.week[1]).toBeUndefined()
  })

  it('reads weights in the unit the delta carries, not the one it started with', () => {
    // a profile switching kg → lb arrives as settings + rows in the same delta
    const next = applyRows(base, {
      settings: { unit: 'lb' },
      bodyweight: [{ on_date: '2026-08-01', weight_kg: 81.6466 }]
    }, { modeFor: modeReps })
    expect(next.bodyweight[0].w).toBeCloseTo(180, 0)
  })
})

describe('dates survive the wire', () => {
  // The server sees Date objects from postgres.js; the client sees the ISO strings JSON made
  // of them. Both have to produce a plain YYYY-MM-DD `d`, because that is what every
  // date-keyed view matches on.
  const row = at => ({
    id: 'w1', user_id: 'u1', started_at: at, finished_at: at,
    routine_id: 'r1', routine_name: 'Push', bodyweight_kg: null, prs: []
  })

  it('reads a Date the way the server gets it', () => {
    const w = rowsToWorkout(row(new Date('2026-06-01T18:28:00Z')), [], { unit: 'kg', modeFor: modeReps })
    expect(w.d).toBe('2026-06-01')
  })

  it('reads the ISO string the way the client gets it', () => {
    const w = rowsToWorkout(row('2026-06-01T18:28:00.000Z'), [], { unit: 'kg', modeFor: modeReps })
    expect(w.d).toBe('2026-06-01')
  })

  it('leaves a plain date alone', () => {
    const w = rowsToWorkout(row('2026-06-01'), [], { unit: 'kg', modeFor: modeReps })
    expect(w.d).toBe('2026-06-01')
  })

  it('does the same for body-weight entries in both shapes', () => {
    const asDate = applyRows({}, {
      bodyweight: [{ on_date: new Date('2026-08-01T00:00:00Z'), weight_kg: 82 }]
    }, { modeFor: modeReps })
    const asString = applyRows({}, {
      bodyweight: [{ on_date: '2026-08-01T00:00:00.000Z', weight_kg: 82 }]
    }, { modeFor: modeReps })
    expect(asDate.bodyweight[0].d).toBe('2026-08-01')
    expect(asString.bodyweight[0].d).toBe('2026-08-01')
  })

  it('keeps start and end as real timestamps, not dates', () => {
    const w = rowsToWorkout(row('2026-06-01T18:28:00.000Z'), [], { unit: 'kg', modeFor: modeReps })
    expect(w.start).toBe(Date.parse('2026-06-01T18:28:00.000Z'))
    expect(w.end).toBe(Date.parse('2026-06-01T18:28:00.000Z'))
  })
})
