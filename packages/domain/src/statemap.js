/* The wire format: openGym's in-memory state object ⇄ database rows.
 *
 * This module exists because the client and the server have to agree on it exactly, and both
 * import it from here rather than each keeping their own half. A drift between two hand-written
 * mappers is the kind of bug that eats a user's training history quietly.
 *
 * Why the client keeps the blob at all
 * ------------------------------------
 * The blob was fatal as the *storage and sync unit* — one whole-account PUT with last-write-wins
 * means a coach and a client writing in the same minute silently destroy one of the two edits,
 * and the server can never answer a question about data it never parses. It is perfectly fine as
 * the client's *in-memory working copy*: it is what every view already reads, it survives being
 * offline, and it costs nothing to hold. So the blob stays in the browser, rows go over the wire
 * and into Postgres, and this module is the boundary.
 *
 * Units
 * -----
 * openGym stores whatever number the user typed, in whatever unit they had selected. The database
 * stores kilograms, always. Every conversion in this file goes through `toKg`/`fromKg` with the
 * profile's unit, because assuming kg would quietly multiply every pound-user's history by 2.2.
 */

import { modeOf } from './history.js'

const LB_PER_KG = 0.45359237

export const toKg = (v, unit) => (v == null ? null : round(unit === 'lb' ? v * LB_PER_KG : v, 4))
export const fromKg = (v, unit) => (v == null ? null : round(unit === 'lb' ? v / LB_PER_KG : v, 3))

const round = (n, dp) => { const f = 10 ** dp; return Math.round(Number(n) * f) / f }
const num = v => (v == null || v === '' ? null : Number(v))
/* A calendar day as `YYYY-MM-DD`, whichever shape the value arrives in.
 *
 * This matters more than it looks. On the server, postgres.js hands back `Date` objects; over
 * the wire those become ISO *timestamp* strings, so the client sees "2026-06-01T18:28:00.000Z"
 * where the server saw a Date. Passing that straight through gives every workout a `d` that is
 * a timestamp rather than a date — and `d` is the key the heatmap, the streak counter, the
 * weekly filters and "today's session" all match on, so all of them quietly stop finding
 * anything. Server-side tests cannot catch it; only a round trip through JSON can. */
const iso = d => {
  if (d == null) return null
  if (d instanceof Date) return d.toISOString().slice(0, 10)
  const str = String(d)
  return /^\d{4}-\d{2}-\d{2}/.test(str) ? str.slice(0, 10) : str
}
const ms = d => (d instanceof Date ? d.getTime() : typeof d === 'number' ? d : d ? Date.parse(d) : null)
const stamp = v => (v == null ? null : new Date(v).toISOString())

/* Settings that live on the profile rather than in a table of their own. Everything here is
 * small, read as a unit and never written by anyone but its owner, so a row per key would be
 * cost with no benefit.
 *
 * `active` — the workout in progress — is deliberately NOT in this list. openGym keeps it
 * device-local and that is the right call: syncing it means two devices can both believe they
 * are mid-session, and the loser's half-logged sets are the ones that vanish. A session is
 * finished on the phone it was started on. */
export const SETTING_KEYS = [
  'unit', 'restSec', 'sound', 'keepAwake', 'lang', 'theme', 'accent', 'body', 'targetW',
  'gifSize', 'reminder', 'effort', 'showRir', 'exWeights',
  /* Which server-sent notifications this person wants. Here rather than in a table of its own
   * because it is a preference like every other one in this list, and putting it in the blob the
   * client already syncs means the switch somebody flips and the row the API reads before
   * sending are the same row. `true`/absent is everything, `false` is nothing, an object is
   * per kind — see apps/api/src/notify.js. */
  'push'
]

/* A logged workout entry does not carry the mode its sets were recorded in — that lives on the
 * routine config. Resolving it wrong writes a plank's duration into a reps column, so both the
 * client and the importer build the resolver the same way, from here.
 *
 * `routines` may be state routines (`ex`) or database rows (`exercises`); both shapes turn up
 * depending on which side of the wire the caller is on. */
export function makeModeResolver(routines = []) {
  const byExercise = new Map()
  for (const r of routines) {
    for (const e of (r.ex || r.exercises || [])) if (!byExercise.has(e.id)) byExercise.set(e.id, e)
  }
  return entry => modeOf(byExercise.get(entry.id) || entry)
}

/* ---------------------------------------------------------------- sets ---- */
/* A set is one of three shapes and the database has to hold all three without a `kind` column
 * doing the work — the columns themselves say which it is.
 *   reps   { w, r }            → weight_kg + reps
 *   time   { sec, w? }         → seconds (+ weight for a loaded carry)
 *   cardio { min, speed }      → seconds + distance_m
 * Cardio is stored as distance and duration rather than the km/h the UI collects, because
 * "how far did they actually run this month" is a question the coach dashboard asks and
 * "8.5" in a speed column cannot answer. Speed is recovered exactly on the way back. */

export function setToRow(s, { workoutId, userId, exerciseId, position, unit, mode, doneAt }) {
  const row = {
    id: s.id || `${workoutId}:${position}`,
    workout_id: workoutId,
    user_id: userId,
    exercise_id: exerciseId,
    position,
    weight_kg: null, reps: null, seconds: null, distance_m: null,
    per_side: !!s.side,
    effort_value: null, effort_scale: null,
    is_warmup: !!s.warm,
    done: s.done !== false,
    done_at: stamp(doneAt) || new Date().toISOString()
  }
  if (mode === 'cardio') {
    const min = num(s.min) ?? 0
    const speed = num(s.speed) ?? 0
    row.seconds = Math.round(min * 60)
    row.distance_m = round((speed * min) / 60 * 1000, 2)
  } else if (mode === 'time') {
    row.seconds = num(s.sec) ?? 0
    row.weight_kg = s.w ? toKg(num(s.w), unit) : null
  } else {
    row.weight_kg = toKg(num(s.w) ?? 0, unit)
    row.reps = num(s.r) ?? 0
  }
  // Effort is normalised to reps-in-reserve so two profiles on different scales are comparable,
  // with the scale it was logged on kept alongside. RPE 8 is exactly RIR 2, so this round-trips.
  if (s.rir != null) { row.effort_value = num(s.rir); row.effort_scale = 'rir' }
  else if (s.rpe != null) { row.effort_value = round(10 - num(s.rpe), 2); row.effort_scale = 'rpe' }
  return row
}

export function rowToSet(row, { unit, mode }) {
  const s = {}
  if (mode === 'cardio') {
    const seconds = num(row.seconds) ?? 0
    const metres = num(row.distance_m) ?? 0
    s.min = round(seconds / 60, 3)
    s.speed = seconds > 0 ? round(metres / 1000 / (seconds / 3600), 2) : 0
  } else if (mode === 'time') {
    s.sec = num(row.seconds) ?? 0
    if (row.weight_kg != null) s.w = fromKg(num(row.weight_kg), unit)
  } else {
    s.w = fromKg(num(row.weight_kg) ?? 0, unit)
    s.r = num(row.reps) ?? 0
  }
  if (row.effort_value != null) {
    // null, not 0 — an unlogged effort must never come back as "taken to failure".
    if (row.effort_scale === 'rpe') s.rpe = round(10 - num(row.effort_value), 2)
    else s.rir = num(row.effort_value)
  }
  if (row.per_side) s.side = true
  if (row.is_warmup) s.warm = true
  s.done = row.done !== false
  return s
}

/* ------------------------------------------------------------ workouts ---- */
/* A workout and its sets travel as one payload. Nobody edits somebody else's session, so there
 * is no second writer to reconcile and no reason to sync a set on its own. */

/* The session's heart rate as its four columns, or as four nulls.
 *
 * Half of an aggregate is refused here rather than sent and bounced: migration 012 makes
 * all-four-or-none a check constraint, so a workout carrying an average with no denominator
 * would fail the whole push — every other row in it included — over a number nothing was
 * going to draw. An aggregate that does not hold together is not a heart rate, and the
 * session is worth more than it is. */
function hrRow(hr) {
  const n = num(hr && hr.n), avg = num(hr && hr.avg), min = num(hr && hr.min), max = num(hr && hr.max)
  const whole = [n, avg, min, max].every(v => v != null && isFinite(v)) &&
    n > 0 && min >= 25 && max <= 240 && min <= avg && avg <= max
  return whole
    ? {
      hr_avg_bpm: Math.round(avg), hr_min_bpm: Math.round(min),
      hr_max_bpm: Math.round(max), hr_samples: Math.round(n)
    }
    : { hr_avg_bpm: null, hr_min_bpm: null, hr_max_bpm: null, hr_samples: null }
}

export function workoutToRows(w, { userId, unit, modeFor }) {
  const startedAt = stamp(ms(w.start)) || new Date(`${w.d}T12:00:00Z`).toISOString()
  const row = {
    id: w.id,
    user_id: userId,
    routine_id: w.routineId ?? null,
    routine_name: w.name ?? null,
    started_at: startedAt,
    finished_at: stamp(ms(w.end)),
    bodyweight_kg: w.bw != null ? toKg(num(w.bw), unit) : null,
    notes: w.notes ?? null,
    prs: w.prs || [],
    ...hrRow(w.hr)
  }
  const sets = []
  let position = 0
  for (const entry of w.entries || []) {
    const mode = modeFor(entry)
    for (const s of entry.sets || []) {
      sets.push(setToRow(s, {
        workoutId: w.id, userId, exerciseId: entry.id, position: position++,
        unit, mode, doneAt: ms(w.end) || ms(w.start)
      }))
    }
  }
  return { workout: row, sets }
}

export function rowsToWorkout(row, setRows, { unit, modeFor }) {
  const w = {
    id: row.id,
    d: iso(row.started_at) || iso(row.finished_at),
    start: ms(row.started_at),
    end: ms(row.finished_at),
    routineId: row.routine_id ?? null,
    name: row.routine_name ?? null,
    bw: row.bodyweight_kg != null ? fromKg(num(row.bodyweight_kg), unit) : null,
    prs: row.prs || [],
    entries: []
  }
  if (row.notes) w.notes = row.notes
  // Absent rather than null when there was no heart rate, so `w.hr &&` is the whole test a
  // view needs and a session from before 012 reads exactly like one recorded without a watch.
  if (row.hr_avg_bpm != null) {
    w.hr = {
      n: num(row.hr_samples), avg: num(row.hr_avg_bpm),
      min: num(row.hr_min_bpm), max: num(row.hr_max_bpm)
    }
  }
  // Sets arrive ordered by position; consecutive runs of one exercise are one entry, which is
  // how the app groups them — and re-grouping by exercise id instead would silently merge an
  // exercise that legitimately appears twice in a session (a routine that opens and closes
  // with the same movement).
  const ordered = [...setRows].sort((a, b) => a.position - b.position)
  let current = null
  for (const r of ordered) {
    if (!current || current.id !== r.exercise_id) {
      current = { id: r.exercise_id, sets: [] }
      w.entries.push(current)
    }
    current.sets.push(rowToSet(r, { unit, mode: modeFor(current) }))
  }
  for (const e of w.entries) {
    const top = e.sets.reduce((m, s) => Math.max(m, num(s.w) || 0), 0)
    e.topW = top || null
  }
  w.vol = w.entries.reduce(
    (v, e) => v + e.sets.reduce((n, s) => n + (num(s.w) || 0) * (num(s.r) || 0), 0), 0)
  return w
}

/* ------------------------------------------------------------- routines ---- */

export const routineToRow = (r, { userId, position = 0 }) => ({
  id: r.id,
  user_id: userId,
  author_id: r.authorId ?? userId,
  assigned_by: r.assignedBy ?? null,
  name: r.name,
  emoji: r.emoji ?? null,
  policy: r.policy || 'linear',
  policy_config: r.policyConfig || {},
  position,
  // The exercise list is stored as JSON on the routine rather than as rows. A routine is
  // authored, proposed and accepted as a whole — there is no query that wants half of one,
  // and no second writer to merge, because a coach's version arrives as a proposal.
  exercises: r.ex || []
})

export const rowToRoutine = row => {
  const r = {
    id: row.id, name: row.name, ex: row.exercises || [],
    policy: row.policy || 'linear'
  }
  if (row.emoji) r.emoji = row.emoji
  if (row.policy_config && Object.keys(row.policy_config).length) r.policyConfig = row.policy_config
  if (row.author_id) r.authorId = row.author_id
  if (row.assigned_by) r.assignedBy = row.assigned_by
  return r
}

/* -------------------------------------------------------- custom exercises ---- */

export const customToRow = (ex, { userId }) => ({
  id: ex.id,
  owner_id: userId,
  library_key: null,
  name: ex.n ?? ex.name,
  body_part: ex.bp ?? ex.bodyPart ?? 'other',
  target: ex.tg ?? null,
  equipment: ex.eq ?? null,
  secondary: ex.sm || [],
  steps: ex.st || [],
  description: ex.desc ?? null,
  is_cardio: (ex.bp ?? '') === 'cardio',
  is_bodyweight: (ex.eq ?? '') === 'body weight',
  per_side: !!ex.side,
  image_url: null, animation_url: null, attribution: null
})

export const rowToCustom = row => {
  const ex = { id: row.id, n: row.name, bp: row.body_part, custom: true }
  if (row.equipment) ex.eq = row.equipment
  if (row.target) ex.tg = row.target
  if (row.secondary?.length) ex.sm = row.secondary
  if (row.steps?.length) ex.st = row.steps
  if (row.description) ex.desc = row.description
  if (row.per_side) ex.side = true
  return ex
}

/* -------------------------------------------------------------- the whole ---- */

/** Whole state object → every row it implies. Used by the importer and by the client's push. */
export function stateToRows(S, { userId, modeFor }) {
  const unit = S.unit || 'kg'
  const routines = (S.routines || []).map((r, i) => routineToRow(r, { userId, position: i }))
  const workouts = []
  const workoutSets = []
  for (const w of S.workouts || []) {
    const { workout, sets } = workoutToRows(w, { userId, unit, modeFor })
    workouts.push(workout)
    workoutSets.push(...sets)
  }
  // No id: one weigh-in per person per day, so (user, date) is the key. Anything derived from
  // the date alone would be the same string for every user.
  const bodyweight = (S.bodyweight || []).map(b => ({
    user_id: userId,
    on_date: b.d,
    weight_kg: toKg(num(b.w), unit)
  }))
  /* And the same again for a resting heart rate: one per day, the date is the key, no id.
   * `bpm` is rounded here rather than trusted — it arrives from an importer's arithmetic and
   * the column is a smallint with a range check on it, so a fractional 54.5 would be a failed
   * push rather than a stored 54. */
  const resting = (S.resting || [])
    .filter(r => r && r.bpm != null && isFinite(Number(r.bpm)))
    .map(r => ({ user_id: userId, on_date: r.d, bpm: Math.round(Number(r.bpm)) }))
  const weekPlan = Object.entries(S.week || {})
    .filter(([, rid]) => rid)
    .map(([weekday, routineId]) => ({ user_id: userId, weekday: Number(weekday), routine_id: routineId }))
  const dayOverrides = Object.entries(S.dayPlan || {})
    .map(([on_date, routine_id]) => ({ user_id: userId, on_date, routine_id: routine_id || null }))
  /* Same shape as a weigh-in and for the same reason: one per person per day, so the date is
   * the key and there is no id to generate. `a` is the answers object, `tpl` the template they
   * were answering, `at` when it was submitted — null while it is still a draft. */
  const checkins = (S.checkins || []).map(c => ({
    user_id: userId,
    on_date: c.d,
    template_id: c.tpl ?? null,
    answers: c.a ?? {},
    submitted_at: c.at ?? null
  }))
  /* A habit carries who wrote it, like a routine — that is how a coach-suggested one stays
   * distinguishable from one somebody invented, after the proposal that delivered it is gone. */
  const habits = (S.habits || []).map((h, i) => ({
    id: h.id,
    user_id: userId,
    author_id: h.by ?? userId,
    assigned_by: h.link ?? null,
    title: h.title,
    target_per_week: h.target ?? 7,
    position: i,
    archived_at: h.arch ?? null
  }))
  // A tick is its two keys and nothing else — the row's existence is the fact it records.
  const habitTicks = (S.habitTicks || []).map(t => ({
    user_id: userId, habit_id: t.h, on_date: t.d
  }))
  const exercises = (S.customEx || []).map(ex => customToRow(ex, { userId }))
  const settings = {}
  for (const k of SETTING_KEYS) if (S[k] !== undefined) settings[k] = S[k]

  return {
    routines, workouts, workoutSets, bodyweight, resting, weekPlan, dayOverrides, checkins,
    habits, habitTicks, exercises, settings
  }
}

/**
 * Merge a delta of rows into a state object, in place on a copy the caller owns.
 * `changes` is what the sync endpoint returns: per-table upserts and deletes.
 */
export function applyRows(S, changes, { modeFor }) {
  const next = { ...S }
  const unit = changes.settings?.unit ?? S.unit ?? 'kg'

  if (changes.settings) Object.assign(next, changes.settings)

  if (changes.routines) {
    const by = new Map((next.routines || []).map(r => [r.id, r]))
    for (const row of changes.routines) {
      if (row.deleted_at) by.delete(row.id)
      else by.set(row.id, rowToRoutine(row))
    }
    next.routines = [...by.values()]
  }

  if (changes.workouts) {
    const by = new Map((next.workouts || []).map(w => [w.id, w]))
    for (const row of changes.workouts) {
      if (row.deleted_at) by.delete(row.id)
      else by.set(row.id, rowsToWorkout(row, row.sets || [], { unit, modeFor }))
    }
    // Chronological, because every view that walks history assumes it.
    next.workouts = [...by.values()].sort((a, b) => (a.start || 0) - (b.start || 0))
  }

  if (changes.bodyweight) {
    const by = new Map((next.bodyweight || []).map(b => [b.d, b]))
    for (const row of changes.bodyweight) {
      const d = iso(row.on_date)
      if (row.deleted_at) by.delete(d)
      else by.set(d, { d, w: fromKg(num(row.weight_kg), unit) })
    }
    next.bodyweight = [...by.values()].sort((a, b) => (a.d < b.d ? -1 : 1))
  }

  if (changes.resting) {
    const by = new Map((next.resting || []).map(r => [r.d, r]))
    for (const row of changes.resting) {
      const d = iso(row.on_date)
      if (row.deleted_at) by.delete(d)
      else by.set(d, { d, bpm: num(row.bpm) })
    }
    next.resting = [...by.values()].sort((a, b) => (a.d < b.d ? -1 : 1))
  }

  if (changes.checkins) {
    const by = new Map((next.checkins || []).map(c => [c.d, c]))
    for (const row of changes.checkins) {
      const d = iso(row.on_date)
      if (row.deleted_at) by.delete(d)
      else by.set(d, { d, tpl: row.template_id ?? null, a: row.answers ?? {}, at: stamp(row.submitted_at) })
    }
    next.checkins = [...by.values()].sort((a, b) => (a.d < b.d ? -1 : 1))
  }

  if (changes.habits) {
    const by = new Map((next.habits || []).map(h => [h.id, h]))
    for (const row of changes.habits) {
      if (row.deleted_at) by.delete(row.id)
      else {
        by.set(row.id, {
          id: row.id,
          title: row.title,
          target: row.target_per_week ?? 7,
          by: row.author_id ?? null,
          link: row.assigned_by ?? null,
          arch: stamp(row.archived_at)
        })
      }
    }
    next.habits = [...by.values()]
  }

  if (changes.habitTicks) {
    const by = new Map((next.habitTicks || []).map(t => [`${t.h}|${t.d}`, t]))
    for (const row of changes.habitTicks) {
      const d = iso(row.on_date)
      const key = `${row.habit_id}|${d}`
      if (row.deleted_at) by.delete(key)
      else by.set(key, { h: row.habit_id, d })
    }
    next.habitTicks = [...by.values()].sort((a, b) => (a.d < b.d ? -1 : 1))
  }

  if (changes.exercises) {
    const by = new Map((next.customEx || []).map(e => [e.id, e]))
    for (const row of changes.exercises) {
      if (row.deleted_at) by.delete(row.id)
      else by.set(row.id, rowToCustom(row))
    }
    next.customEx = [...by.values()]
  }

  if (changes.weekPlan) {
    const week = { ...(next.week || {}) }
    for (const row of changes.weekPlan) {
      if (row.routine_id) week[row.weekday] = row.routine_id
      else delete week[row.weekday]
    }
    next.week = week
  }

  if (changes.dayOverrides) {
    const plan = { ...(next.dayPlan || {}) }
    for (const row of changes.dayOverrides) {
      const d = iso(row.on_date)
      if (row.deleted_at) delete plan[d]
      else plan[d] = row.routine_id || null
    }
    next.dayPlan = plan
  }

  return next
}
