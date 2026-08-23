import { describe, it, expect, beforeEach, vi } from 'vitest'

/* A localStorage that behaves like the real one, including throwing when full — the quota path
 * is the one that silently loses a cursor if it isn't handled. */
function fakeStorage({ failWrites = false } = {}) {
  const map = new Map()
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (failWrites) throw new DOMException('quota', 'QuotaExceededError')
      map.set(k, String(v))
    },
    removeItem: k => map.delete(k),
    clear: () => map.clear(),
    _map: map
  }
}

let calls

const defaultApi = async (path, opts) => {
  calls.push({ path, body: opts?.body ? JSON.parse(opts.body) : null })
  if (path === '/api/sync' && opts?.method === 'POST') return { cursor: 10, touched: 1 }
  return { cursor: 10, changes: {} }
}

vi.mock('./api.js', () => ({ api: vi.fn() }))

const load = async () => {
  vi.resetModules()
  return import('./sync.js')
}

const S = () => ({
  unit: 'kg', restSec: 90,
  routines: [{ id: 'r1', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 5 }] }],
  week: { 1: 'r1' }, dayPlan: {}, bodyweight: [{ d: '2026-08-01', w: 82 }],
  customEx: [],
  workouts: [{
    id: 'w1', d: '2026-08-01', start: Date.parse('2026-08-01T18:00:00Z'),
    end: Date.parse('2026-08-01T19:00:00Z'), routineId: 'r1', name: 'Push',
    entries: [{ id: '0025', sets: [{ w: 100, r: 5, done: true }] }]
  }]
})

beforeEach(async () => {
  calls = []
  globalThis.localStorage = fakeStorage()
  // The mock module is created once and survives resetModules, so an implementation set by
  // one test leaks into the next unless it is put back here.
  const { api } = await import('./api.js')
  api.mockReset()
  api.mockImplementation(defaultApi)
})

describe('diffing', () => {
  it('sends everything the first time', async () => {
    const { diffState } = await load()
    const { changes, empty } = diffState(S(), {})
    expect(empty).toBe(false)
    expect(changes.routines).toHaveLength(1)
    expect(changes.workouts).toHaveLength(1)
    expect(changes.bodyweight).toHaveLength(1)
    expect(changes.weekPlan).toHaveLength(1)
    expect(changes.settings.restSec).toBe(90)
  })

  it('sends nothing when nothing changed', async () => {
    const { diffState } = await load()
    const first = diffState(S(), {})
    const second = diffState(S(), first.snapshot)
    expect(second.empty).toBe(true)
    expect(second.changes).toEqual({})
  })

  it('sends only the row that actually changed', async () => {
    const { diffState } = await load()
    const before = diffState(S(), {}).snapshot
    const state = S()
    state.routines[0].name = 'Push A'
    const { changes } = diffState(state, before)
    expect(Object.keys(changes)).toEqual(['routines'])
    expect(changes.routines[0].name).toBe('Push A')
  })

  it('marks a session dirty when a set inside it changes', async () => {
    // the workout row itself is unchanged — only a rep count moved, four levels down
    const { diffState } = await load()
    const before = diffState(S(), {}).snapshot
    const state = S()
    state.workouts[0].entries[0].sets[0].r = 6
    const { changes } = diffState(state, before)
    expect(changes.workouts).toHaveLength(1)
    expect(changes.workouts[0].sets[0].reps).toBe(6)
  })

  it('turns a removed routine into a delete', async () => {
    const { diffState } = await load()
    const before = diffState(S(), {}).snapshot
    const state = S()
    state.routines = []
    const { changes } = diffState(state, before)
    expect(changes.routines).toEqual([{ id: 'r1', deleted: true }])
  })

  it('clears a weekday rather than deleting the row', async () => {
    const { diffState } = await load()
    const before = diffState(S(), {}).snapshot
    const state = S()
    state.week = {}
    const { changes } = diffState(state, before)
    expect(changes.weekPlan).toEqual([{ weekday: 1, routine_id: null }])
  })

  it('notices a settings change on its own', async () => {
    const { diffState } = await load()
    const before = diffState(S(), {}).snapshot
    const state = S()
    state.restSec = 120
    const { changes } = diffState(state, before)
    expect(Object.keys(changes)).toEqual(['settings'])
    expect(changes.settings.restSec).toBe(120)
  })
})

describe('sync', () => {
  it('pushes then pulls, and remembers the cursor', async () => {
    const { sync, getCursor } = await load()
    const report = await sync(S(), () => null)
    expect(calls[0].path).toBe('/api/sync')
    expect(calls[1].path).toBe('/api/sync?since=10')
    expect(getCursor()).toBe(10)
    expect(report.pushed).toBe(1)
  })

  it('skips the push entirely when there is nothing to send', async () => {
    const { sync } = await load()
    await sync(S(), () => null)
    calls = []
    await sync(S(), () => null)
    expect(calls.map(c => c.path)).toEqual(['/api/sync?since=10'])
  })

  it('asks for everything on a full sync', async () => {
    const { sync } = await load()
    await sync(S(), () => null, { full: true })
    expect(calls.some(c => c.path === '/api/sync/all')).toBe(true)
  })

  it('resends the same delta after a failed push', async () => {
    const { api } = await import('./api.js')
    const { sync, diffState } = await load()
    api.mockImplementationOnce(async () => { throw new Error('offline') })
    await expect(sync(S(), () => null)).rejects.toThrow('offline')

    // the snapshot must not have advanced, or this delta is gone for good
    const snapshot = JSON.parse(globalThis.localStorage.getItem('gym_sync_snapshot') || '{}')
    expect(diffState(S(), snapshot).empty).toBe(false)
  })

  it('does not resend what the server just sent us', async () => {
    // the loop this guards: merge a pulled row, then diff against a stale snapshot and push
    // it straight back, forever
    const { api } = await import('./api.js')
    const { sync, diffState } = await load()
    const merged = S()
    merged.routines.push({ id: 'r2', name: 'Pull', ex: [] })

    api.mockImplementation(async path => {
      if (path === '/api/sync') return { cursor: 11, touched: 1 }
      return {
        cursor: 12,
        changes: { routines: [{ id: 'r2', name: 'Pull', exercises: [], policy: 'linear' }] }
      }
    })
    await sync(S(), () => merged)

    const snapshot = JSON.parse(globalThis.localStorage.getItem('gym_sync_snapshot') || '{}')
    expect(diffState(merged, snapshot).empty).toBe(true)
  })

  it('survives a storage quota error without throwing', async () => {
    globalThis.localStorage = fakeStorage({ failWrites: true })
    const { sync } = await load()
    await expect(sync(S(), () => null)).resolves.toBeTruthy()
  })

  it('forgets the cursor and snapshot on reset', async () => {
    const { sync, resetSync, getCursor } = await load()
    await sync(S(), () => null)
    expect(getCursor()).toBe(10)
    resetSync()
    expect(getCursor()).toBe(0)
    expect(globalThis.localStorage.getItem('gym_sync_snapshot')).toBeNull()
  })
})

describe('merging', () => {
  it('applies a delta onto the state the app is holding', async () => {
    const { mergeChanges } = await load()
    const next = mergeChanges(S(), {
      routines: [{ id: 'r2', name: 'Pull', exercises: [{ id: '0043' }], policy: 'linear' }]
    })
    expect(next.routines.map(r => r.id).sort()).toEqual(['r1', 'r2'])
  })

  it('reads a workout that arrives alongside the routine it belongs to', async () => {
    // the resolver needs that routine to know a set is timed rather than reps — if it only
    // looked at routines already in state, a first sync would decode every set wrongly
    const { mergeChanges } = await load()
    const next = mergeChanges({ routines: [], workouts: [], unit: 'kg' }, {
      routines: [{ id: 'r9', name: 'Core', exercises: [{ id: 'plank', mode: 'time' }], policy: 'linear' }],
      workouts: [{
        id: 'w9', user_id: 'u', started_at: '2026-08-02T18:00:00Z', finished_at: '2026-08-02T18:30:00Z',
        routine_id: 'r9', routine_name: 'Core', bodyweight_kg: null, prs: [],
        sets: [{
          id: 'w9:0', workout_id: 'w9', exercise_id: 'plank', position: 0,
          weight_kg: null, reps: null, seconds: 60, distance_m: null, per_side: false,
          effort_value: null, effort_scale: null, is_warmup: false, done: true
        }]
      }]
    })
    expect(next.workouts[0].entries[0].sets[0]).toMatchObject({ sec: 60 })
  })
})
