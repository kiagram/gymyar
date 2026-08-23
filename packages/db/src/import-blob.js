/* Import an openGym state blob into rows.
 *
 * Two callers: the migration path for people already self-hosting openGym (their
 * data/state-<uid>.json goes in, their account comes out intact), and the demo seeder.
 * Both go through the same code so the migration is exercised every time we seed.
 */
import { stateToRows, makeModeResolver, modeOf } from '@gymbuddy/domain'
import { push } from './sync.js'
import { db } from './index.js'

export async function importState(userId, S, s = db()) {
  const modeFor = makeModeResolver(S.routines)
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
  // The resolver needs the routine configs, which are in the delta we are about to apply —
  // so build it from those rather than from a state that does not exist yet.
  const modeFor = makeModeResolver(changes.routines || [])
  return applyRows({}, changes, { modeFor })
}
