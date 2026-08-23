/* Delta sync: the thing that replaces openGym's `PUT /api/data` with the whole account in it.
 *
 * The protocol, in full:
 *   pull(userId, since) → { cursor, changes }   everything that changed above `since`
 *   push(userId, payload, base) → { cursor }    write these rows, log each one
 *
 * Every write bumps a per-user monotonic counter and records what changed at that value. A
 * client remembers the last cursor it saw and asks for what came after. That is why a coach's
 * dashboard, a phone that has been in a locker for a week and a laptop can all be current
 * without anyone shipping their entire training history on every save.
 *
 * Conflict rule: last write wins **per row**, not per account. That sounds like what openGym
 * did, and it is not: the unit is one routine or one session instead of every routine, every
 * session and every weigh-in at once. Losing a race now costs the row you were editing rather
 * than everything you have ever logged. The second writer problem that actually mattered —
 * a coach editing a client's programme mid-session — is gone structurally, because a coach
 * never writes a client's rows at all; their version arrives as a proposal.
 */
import { db, logChange, cursorFor } from './index.js'

/* A guarded upsert whose WHERE clause fails does not error — ON CONFLICT DO UPDATE simply
 * updates nothing. Silence is the wrong answer here: the client believes its push landed and
 * will never retry. Every guarded write therefore returns its id and we check for it, so an
 * attempt to write a row belonging to someone else fails loudly instead of vanishing. */
function assertWrote(rows, table, id) {
  if (!rows.length) {
    throw Object.assign(
      new Error(`refusing to write ${table} ${id}: it belongs to another account`),
      { status: 409, code: 'not_yours' })
  }
}

/* Which client-facing key each table is returned under, and how a row is addressed. */
const TABLES = {
  routines:           { key: 'routines',     id: r => r.id },
  workouts:           { key: 'workouts',     id: r => r.id },
  bodyweight_entries: { key: 'bodyweight',   id: r => String(r.on_date) },
  exercises:          { key: 'exercises',    id: r => r.id },
  week_plan:          { key: 'weekPlan',     id: r => String(r.weekday) },
  day_overrides:      { key: 'dayOverrides', id: r => String(r.on_date) },
  user_settings:      { key: 'settings',     id: () => 'settings' }
}

/* ------------------------------------------------------------------ pull ---- */

export async function pull(userId, since = 0, s = db()) {
  const cursor = await cursorFor(userId, s)
  if (cursor <= since) return { cursor, changes: {} }

  // What changed, deduplicated to the latest touch per row — a row edited forty times while
  // a phone was offline is still one row to send.
  const touched = await s`
    select distinct on (table_name, row_id) table_name, row_id, op
    from change_log
    where user_id = ${userId} and cursor > ${since}
    order by table_name, row_id, cursor desc`

  const byTable = new Map()
  for (const t of touched) {
    if (!byTable.has(t.table_name)) byTable.set(t.table_name, [])
    byTable.get(t.table_name).push(t.row_id)
  }

  const changes = {}
  for (const [table, ids] of byTable) {
    const spec = TABLES[table]
    if (!spec) continue
    changes[spec.key] = await readRows(s, table, userId, ids)
  }
  return { cursor, changes }
}

/** Everything a user has, as a first sync. Also how a coach reads a client's training. */
export async function pullAll(userId, s = db()) {
  const cursor = await cursorFor(userId, s)
  const [routines, workouts, bodyweight, exercises, weekPlan, dayOverrides, settings] =
    await Promise.all([
      s`select * from routines where user_id = ${userId} and deleted_at is null order by position`,
      loadWorkouts(s, userId),
      s`select * from bodyweight_entries where user_id = ${userId} and deleted_at is null order by on_date`,
      s`select * from exercises where owner_id = ${userId} and deleted_at is null`,
      s`select * from week_plan where user_id = ${userId}`,
      s`select * from day_overrides where user_id = ${userId} and deleted_at is null`,
      s`select settings from user_settings where user_id = ${userId}`
    ])
  return {
    cursor,
    changes: {
      routines, workouts, bodyweight, exercises, weekPlan, dayOverrides,
      settings: settings[0]?.settings ?? {}
    }
  }
}

async function readRows(s, table, userId, ids) {
  if (table === 'workouts') return loadWorkouts(s, userId, ids)
  if (table === 'user_settings') {
    const rows = await s`select settings from user_settings where user_id = ${userId}`
    return rows[0]?.settings ?? {}
  }
  if (table === 'week_plan') {
    return s`select * from week_plan where user_id = ${userId} and weekday in ${s(ids.map(Number))}`
  }
  if (table === 'day_overrides') {
    return s`select * from day_overrides where user_id = ${userId} and on_date in ${s(ids)}`
  }
  if (table === 'bodyweight_entries') {
    return s`select * from bodyweight_entries where user_id = ${userId} and on_date in ${s(ids)}`
  }
  const owner = table === 'exercises' ? s`owner_id = ${userId}` : s`user_id = ${userId}`
  return s`select * from ${s(table)} where ${owner} and id in ${s(ids)}`
}

/** Workouts with their sets attached — the unit the client and the mapper both expect. */
async function loadWorkouts(s, userId, ids = null) {
  const workouts = ids
    ? await s`select * from workouts where user_id = ${userId} and id in ${s(ids)}`
    : await s`select * from workouts where user_id = ${userId} and deleted_at is null
              order by started_at`
  if (!workouts.length) return []
  const live = workouts.filter(w => !w.deleted_at).map(w => w.id)
  const sets = live.length
    ? await s`select * from workout_sets where workout_id in ${s(live)} order by workout_id, position`
    : []
  const byWorkout = new Map()
  for (const st of sets) {
    if (!byWorkout.has(st.workout_id)) byWorkout.set(st.workout_id, [])
    byWorkout.get(st.workout_id).push(st)
  }
  return workouts.map(w => ({ ...w, sets: byWorkout.get(w.id) || [] }))
}

/* ------------------------------------------------------------------ push ---- */

/**
 * Apply a client's changes. One transaction: a partly-applied push would leave the change log
 * describing rows that were rolled back, and every client that pulled it would 404 forever.
 */
export async function push(userId, payload = {}, s = db()) {
  return s.begin(async tx => {
    let touched = 0

    for (const r of payload.routines || []) {
      if (r.deleted) {
        await tx`update routines set deleted_at = now(), updated_at = now()
                 where id = ${r.id} and user_id = ${userId}`
        await logChange(tx, userId, 'routines', r.id, 'delete')
      } else {
        const wrote = await tx`
          insert into routines (id, user_id, author_id, assigned_by, name, emoji, policy,
                                policy_config, position, exercises)
          values (${r.id}, ${userId}, ${r.author_id ?? userId}, ${r.assigned_by ?? null},
                  ${r.name}, ${r.emoji ?? null}, ${r.policy ?? 'linear'},
                  ${tx.json(r.policy_config ?? {})}, ${r.position ?? 0}, ${tx.json(r.exercises ?? [])})
          on conflict (id) do update set
            name = excluded.name, emoji = excluded.emoji, policy = excluded.policy,
            policy_config = excluded.policy_config, position = excluded.position,
            exercises = excluded.exercises, deleted_at = null, updated_at = now()
          where routines.user_id = ${userId}
          returning id`
        assertWrote(wrote, 'routine', r.id)
        await logChange(tx, userId, 'routines', r.id)
      }
      touched++
    }

    for (const w of payload.workouts || []) {
      if (w.deleted) {
        await tx`update workouts set deleted_at = now(), updated_at = now()
                 where id = ${w.id} and user_id = ${userId}`
        await logChange(tx, userId, 'workouts', w.id, 'delete')
        touched++
        continue
      }
      const wroteWorkout = await tx`
        insert into workouts (id, user_id, routine_id, routine_name, started_at, finished_at,
                              bodyweight_kg, notes, prs)
        values (${w.id}, ${userId}, ${w.routine_id ?? null}, ${w.routine_name ?? null},
                ${w.started_at}, ${w.finished_at ?? null}, ${w.bodyweight_kg ?? null},
                ${w.notes ?? null}, ${w.prs ?? []})
        on conflict (id) do update set
          routine_id = excluded.routine_id, routine_name = excluded.routine_name,
          started_at = excluded.started_at, finished_at = excluded.finished_at,
          bodyweight_kg = excluded.bodyweight_kg, notes = excluded.notes,
          prs = excluded.prs, deleted_at = null, updated_at = now()
        where workouts.user_id = ${userId}
        returning id`
      assertWrote(wroteWorkout, 'workout', w.id)
      // A workout's sets are replaced wholesale rather than merged. The session is the unit
      // that was edited, only its owner ever edits it, and diffing set rows to save three
      // DELETEs would buy nothing but a reordering bug.
      await tx`delete from workout_sets where workout_id = ${w.id}`
      if (w.sets?.length) {
        await tx`insert into workout_sets ${tx(w.sets.map(st => ({ ...st, user_id: userId })),
          'id', 'workout_id', 'user_id', 'exercise_id', 'position', 'weight_kg', 'reps',
          'seconds', 'distance_m', 'per_side', 'effort_value', 'effort_scale', 'is_warmup',
          'done', 'done_at')}`
      }
      await logChange(tx, userId, 'workouts', w.id)
      touched++
    }

    for (const b of payload.bodyweight || []) {
      // (user, date) is the key, so the upsert is naturally scoped to the caller and there is
      // no cross-account write to guard against.
      if (b.deleted) {
        await tx`update bodyweight_entries set deleted_at = now(), updated_at = now()
                 where user_id = ${userId} and on_date = ${b.on_date}`
        await logChange(tx, userId, 'bodyweight_entries', String(b.on_date), 'delete')
      } else {
        await tx`
          insert into bodyweight_entries (user_id, on_date, weight_kg)
          values (${userId}, ${b.on_date}, ${b.weight_kg})
          on conflict (user_id, on_date) do update set
            weight_kg = excluded.weight_kg, deleted_at = null, updated_at = now()`
        await logChange(tx, userId, 'bodyweight_entries', String(b.on_date))
      }
      touched++
    }

    for (const e of payload.exercises || []) {
      if (e.deleted) {
        await tx`update exercises set deleted_at = now(), updated_at = now()
                 where id = ${e.id} and owner_id = ${userId}`
        await logChange(tx, userId, 'exercises', e.id, 'delete')
      } else {
        const wrote = await tx`
          insert into exercises (id, owner_id, name, body_part, target, equipment, secondary,
                                 steps, description, is_cardio, is_bodyweight, per_side)
          values (${e.id}, ${userId}, ${e.name}, ${e.body_part}, ${e.target ?? null},
                  ${e.equipment ?? null}, ${e.secondary ?? []}, ${e.steps ?? []},
                  ${e.description ?? null}, ${!!e.is_cardio}, ${!!e.is_bodyweight}, ${!!e.per_side})
          on conflict (id) do update set
            name = excluded.name, body_part = excluded.body_part, target = excluded.target,
            equipment = excluded.equipment, secondary = excluded.secondary, steps = excluded.steps,
            description = excluded.description, is_cardio = excluded.is_cardio,
            is_bodyweight = excluded.is_bodyweight, per_side = excluded.per_side,
            deleted_at = null, updated_at = now()
          where exercises.owner_id = ${userId}
          returning id`
        assertWrote(wrote, 'exercise', e.id)
        await logChange(tx, userId, 'exercises', e.id)
      }
      touched++
    }

    for (const p of payload.weekPlan || []) {
      await tx`
        insert into week_plan (user_id, weekday, routine_id)
        values (${userId}, ${p.weekday}, ${p.routine_id ?? null})
        on conflict (user_id, weekday) do update set
          routine_id = excluded.routine_id, updated_at = now()`
      await logChange(tx, userId, 'week_plan', String(p.weekday))
      touched++
    }

    for (const d of payload.dayOverrides || []) {
      if (d.deleted) {
        await tx`update day_overrides set deleted_at = now(), updated_at = now()
                 where user_id = ${userId} and on_date = ${d.on_date}`
        await logChange(tx, userId, 'day_overrides', String(d.on_date), 'delete')
      } else {
        await tx`
          insert into day_overrides (user_id, on_date, routine_id)
          values (${userId}, ${d.on_date}, ${d.routine_id ?? null})
          on conflict (user_id, on_date) do update set
            routine_id = excluded.routine_id, deleted_at = null, updated_at = now()`
        await logChange(tx, userId, 'day_overrides', String(d.on_date))
      }
      touched++
    }

    if (payload.settings && Object.keys(payload.settings).length) {
      // Merged, not replaced: a phone that only knows about the settings it has must not
      // wipe a preference set on a laptop it has never synced with.
      await tx`
        insert into user_settings (user_id, settings)
        values (${userId}, ${tx.json(payload.settings)})
        on conflict (user_id) do update set
          settings = user_settings.settings || excluded.settings, updated_at = now()`
      await logChange(tx, userId, 'user_settings', 'settings')
      touched++
    }

    const cursor = await cursorFor(userId, tx)
    return { cursor, touched }
  })
}
