/* Import an openGym state blob into rows.
 *
 * Two callers: the migration path for people already self-hosting openGym (their
 * data/state-<uid>.json goes in, their account comes out intact), and the demo seeder.
 * Both go through the same code so the migration is exercised every time we seed.
 */
import { stateToRows, modeOf } from '@gymbuddy/domain'
import { push } from './sync.js'
import { db } from './index.js'

/* The set shape depends on the routine's mode, and a logged workout entry does not carry it —
 * so it is looked up from the routine that session was run against, falling back to the
 * exercise's own nature. Getting this wrong writes a plank's duration into a reps column. */
function modeResolver(S) {
  const cfgByExercise = new Map()
  for (const r of S.routines || []) {
    for (const e of r.ex || []) if (!cfgByExercise.has(e.id)) cfgByExercise.set(e.id, e)
  }
  return entry => modeOf(cfgByExercise.get(entry.id) || entry)
}

export async function importState(userId, S, s = db()) {
  const modeFor = modeResolver(S)
  const rows = stateToRows(S, { userId, modeFor })
  const bySet = new Map()
  for (const st of rows.workoutSets) {
    if (!bySet.has(st.workout_id)) bySet.set(st.workout_id, [])
    bySet.get(st.workout_id).push(st)
  }
  return push(userId, {
    routines: rows.routines,
    workouts: rows.workouts.map(w => ({ ...w, sets: bySet.get(w.id) || [] })),
    bodyweight: rows.bodyweight,
    exercises: rows.exercises,
    weekPlan: rows.weekPlan,
    dayOverrides: rows.dayOverrides,
    settings: rows.settings
  }, s)
}

/** Read a whole account back as a state blob — the inverse, used by tests and by export. */
export async function exportState(userId, s = db()) {
  const { pullAll } = await import('./sync.js')
  const { applyRows } = await import('@gymbuddy/domain')
  const { changes } = await pullAll(userId, s)
  const settings = changes.settings || {}
  const routines = (changes.routines || []).map(r => ({ ...r }))
  // modeOf needs the routine configs, which are in the delta we are about to apply — so
  // resolve against them directly rather than against a state that does not exist yet.
  const cfgByExercise = new Map()
  for (const r of routines) for (const e of r.exercises || []) if (!cfgByExercise.has(e.id)) cfgByExercise.set(e.id, e)
  const modeFor = entry => modeOf(cfgByExercise.get(entry.id) || entry)
  return applyRows({}, changes, { modeFor })
}
