/* Delta sync, client side. Replaces openGym's "PUT the whole account and hope".
 *
 * How it works
 * ------------
 * The app keeps its state object exactly as before — every view reads it, it works offline, and
 * none of that changed. What changed is what goes over the wire. On each sync we map the current
 * state to rows, compare against a snapshot of the rows we last successfully sent, and send only
 * what differs. Then we ask the server for everything above our cursor and merge it in.
 *
 * Why a snapshot diff rather than tracking mutations
 * -------------------------------------------------
 * The store mutates state through one generic `update(fn)`, so there is no single place a change
 * could announce itself, and adding one would mean touching every caller and trusting that nobody
 * ever forgets. Diffing cannot forget. It costs a JSON pass over the user's history per sync,
 * which for a few thousand sessions is a couple of milliseconds and happens debounced, off the
 * interaction path.
 *
 * What happens when it goes wrong
 * ------------------------------
 * Offline, a push fails and the snapshot is left alone, so the next attempt resends the same
 * delta — the queue is the difference between state and snapshot, not a list we could lose.
 * A row the server rejects as belonging to someone else is dropped from the outbox rather than
 * retried forever, because retrying will never start working.
 */
import { stateToRows, makeModeResolver, applyRows } from '@gymyar/domain'
import { api } from './api.js'

const CURSOR_KEY = 'gym_sync_cursor'
const SNAPSHOT_KEY = 'gym_sync_snapshot'

const read = (key, fallback) => {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback }
  catch { return fallback }
}
const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* quota — next sync retries */ }
}

export const getCursor = () => Number(read(CURSOR_KEY, 0)) || 0
export const setCursor = n => write(CURSOR_KEY, Number(n) || 0)

/** Forget everything we think the server knows. Used on sign-out and on a full resync. */
export function resetSync() {
  try {
    localStorage.removeItem(CURSOR_KEY)
    localStorage.removeItem(SNAPSHOT_KEY)
  } catch { /* nothing to clear */ }
}

/* ------------------------------------------------------------- diffing ---- */

/* Rows are compared by their JSON, which is a real equality test rather than a heuristic: two
 * rows that stringify the same produce the same database state. Key order is stable because
 * every row in statemap.js is built by an object literal with fixed key order. */
const fingerprint = row => JSON.stringify(row)

const indexBy = (rows, key = 'id') => {
  const m = new Map()
  for (const r of rows) m.set(String(r[key]), r)
  return m
}

/**
 * What changed between the last snapshot and now.
 * Returns both the payload to send and the snapshot to store once it lands.
 */
export function diffState(S, snapshot = {}) {
  const modeFor = makeModeResolver(S.routines)
  const rows = stateToRows(S, { userId: null, modeFor })

  // Workouts travel with their sets, so they are fingerprinted together — a changed rep in
  // set four has to mark the session dirty, and the workout row itself would not show it.
  const setsByWorkout = new Map()
  for (const st of rows.workoutSets) {
    if (!setsByWorkout.has(st.workout_id)) setsByWorkout.set(st.workout_id, [])
    setsByWorkout.get(st.workout_id).push(st)
  }
  const workouts = rows.workouts.map(w => ({ ...w, sets: setsByWorkout.get(w.id) || [] }))

  const next = {
    routines: Object.fromEntries(rows.routines.map(r => [r.id, fingerprint(r)])),
    workouts: Object.fromEntries(workouts.map(w => [w.id, fingerprint(w)])),
    bodyweight: Object.fromEntries(rows.bodyweight.map(b => [String(b.on_date), fingerprint(b)])),
    exercises: Object.fromEntries(rows.exercises.map(e => [e.id, fingerprint(e)])),
    weekPlan: Object.fromEntries(rows.weekPlan.map(p => [String(p.weekday), fingerprint(p)])),
    dayOverrides: Object.fromEntries(rows.dayOverrides.map(d => [String(d.on_date), fingerprint(d)])),
    checkins: Object.fromEntries(rows.checkins.map(c => [String(c.on_date), fingerprint(c)])),
    habits: Object.fromEntries(rows.habits.map(h => [h.id, fingerprint(h)])),
    habitTicks: Object.fromEntries(
      rows.habitTicks.map(t => [`${t.habit_id}:${t.on_date}`, fingerprint(t)])),
    settings: fingerprint(rows.settings)
  }

  const changes = {}
  const byId = {
    routines: indexBy(rows.routines),
    workouts: indexBy(workouts),
    bodyweight: indexBy(rows.bodyweight, 'on_date'),
    exercises: indexBy(rows.exercises),
    weekPlan: indexBy(rows.weekPlan, 'weekday'),
    dayOverrides: indexBy(rows.dayOverrides, 'on_date'),
    checkins: indexBy(rows.checkins, 'on_date'),
    habits: indexBy(rows.habits),
    // Two columns make the address, so the generic `indexBy` cannot build it.
    habitTicks: new Map(rows.habitTicks.map(t => [`${t.habit_id}:${t.on_date}`, t]))
  }

  for (const key of Object.keys(byId)) {
    const before = snapshot[key] || {}
    const after = next[key]
    const out = []
    for (const [id, print] of Object.entries(after)) {
      if (before[id] !== print) out.push(byId[key].get(id))
    }
    for (const id of Object.keys(before)) {
      if (after[id] === undefined) out.push(deletionFor(key, id))
    }
    if (out.length) changes[key] = out
  }

  if (snapshot.settings !== next.settings) changes.settings = rows.settings

  // A weekday cleared in the plan is `routine_id: null`, not a deleted row — the row is the
  // weekday itself and it always exists.
  return { changes, snapshot: next, empty: Object.keys(changes).length === 0 }
}

function deletionFor(key, id) {
  if (key === 'weekPlan') return { weekday: Number(id), routine_id: null }
  if (key === 'dayOverrides' || key === 'bodyweight' || key === 'checkins') {
    return { on_date: id, deleted: true }
  }
  // Unticking is a deletion, and the row it names is the pair in its address.
  if (key === 'habitTicks') {
    return { habit_id: id.slice(0, -11), on_date: id.slice(-10), deleted: true }
  }
  return { id, deleted: true }
}

/* ---------------------------------------------------------------- sync ---- */

/**
 * One full sync: send what we have, take what we don't.
 *
 * `applyChanges(next)` is called with the merged state when the server had something for us.
 * Returns a short report so the caller can show "last synced" without guessing.
 */
export async function sync(S, applyChanges, { full = false } = {}) {
  const snapshot = full ? {} : read(SNAPSHOT_KEY, {})
  let cursor = full ? 0 : getCursor()
  let pushed = 0

  const { changes, snapshot: nextSnapshot, empty } = diffState(S, snapshot)

  if (!empty) {
    const res = await api('/api/sync', { method: 'POST', body: JSON.stringify({ changes }) })
    // Snapshot only advances on success. A failed push leaves it behind, so the same delta is
    // recomputed and resent next time rather than being lost.
    write(SNAPSHOT_KEY, nextSnapshot)
    cursor = res.cursor
    setCursor(cursor)
    pushed = res.touched ?? 0
  }

  const pulled = full
    ? await api('/api/sync/all')
    : await api(`/api/sync?since=${cursor}`)

  const hasChanges = Object.keys(pulled.changes || {}).length > 0
  if (hasChanges) {
    const merged = applyChanges(pulled.changes)
    // The merge may have changed rows we would otherwise think we still owe the server, so
    // re-fingerprint from the merged state. Without this the next diff resends everything the
    // server just sent us, in a loop.
    if (merged) write(SNAPSHOT_KEY, diffState(merged, {}).snapshot)
  }
  setCursor(pulled.cursor)

  return { pushed, pulled: hasChanges, cursor: pulled.cursor }
}

/** Merge a server delta into a state object. Thin wrapper so callers don't rebuild the resolver. */
export function mergeChanges(S, changes) {
  // Resolver built from the routines the delta brings plus the ones already held: a workout
  // arriving in the same payload as the routine it belongs to has to see that routine.
  const routines = [...(changes.routines || []), ...(S.routines || [])]
  return applyRows(S, changes, { modeFor: makeModeResolver(routines) })
}
