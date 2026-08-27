/* Habits, from the coach's side — which is only ever reading.
 *
 * There is nothing else for a coach to do here. A habit they suggested becomes the client's row
 * through a proposal (`coaching.js`), and every tick is written by the person who did the thing,
 * through their own sync. So this file is one question asked two ways: what has this client
 * agreed to do, and did they do it.
 */
import { db } from './index.js'
import { requireScope } from './coaching.js'

/* How far back a coach's view of a tick grid goes by default.
 *
 * Twelve weeks because that is roughly a training block, and because the grid is rendered as
 * squares — a year of them is 365 cells per habit, which is a screen nobody reads and a payload
 * nobody needed. */
const DEFAULT_WEEKS = 12

/**
 * A client's habits and their recent ticks, for their coach.
 *
 * Gated on `habits` and nothing else — not on who suggested the habit. A client granting the
 * scope has shared what they are doing daily, including the habits they set themselves, and a
 * coach seeing only the ones they authored would be a stranger view of somebody's week.
 *
 * Archived habits come back too, and say so. A habit somebody kept for three months and retired
 * is the explanation for three months of ticks, and dropping it would leave the grid with rows
 * of data belonging to nothing.
 */
export async function clientHabits({ coachId, clientId, weeks = DEFAULT_WEEKS }, s = db()) {
  await requireScope(coachId, clientId, 'habits', s)
  const days = Math.min(370, Math.max(7, Math.round(Number(weeks) || DEFAULT_WEEKS) * 7))

  const [habits, ticks] = await Promise.all([
    s`select id, title, target_per_week, position, author_id, assigned_by, archived_at
      from habits
      where user_id = ${clientId} and deleted_at is null
      order by position, title`,
    /* `to_char` rather than the date itself: postgres.js turns a `date` into a Date at UTC
     * midnight, which every local getter west of Greenwich reads as the day before — and this
     * value is about to become a key in a grid the client's app draws. Same reason
     * `lastCheckins` does it. */
    s`select habit_id, to_char(on_date, 'YYYY-MM-DD') as on_date
      from habit_ticks
      where user_id = ${clientId} and deleted_at is null
        and on_date > current_date - ${days}::int
      order by on_date`
  ])

  return { habits, ticks: ticks.map(t => ({ h: t.habit_id, d: t.on_date })) }
}

/**
 * This week's habit adherence for a whole roster, as done-days over asked-for days.
 *
 * One query rather than one per client, for the screen a coach opens every morning. The
 * arithmetic is the same as the domain's `weekAdherence` and is repeated here in SQL for the
 * same reason `roster` counts sessions in SQL: pulling every tick of eighty clients into Node
 * to divide two numbers is a payload nobody wanted.
 *
 * `least(done, target)` is the cap that stops an over-done habit covering for a neglected one —
 * eight ticks against a target of five is five, not eight. A client with no active habits is
 * absent from the map rather than present at zero: nothing was asked of them, so there is no
 * adherence to report, and a roster printing 0% would be accusing somebody of nothing.
 *
 * `weekStartsOn` is a `getDay()` index and is the coach's own, not Postgres's. `date_trunc`
 * would start the week on Monday for everybody, which puts this number two days out of step
 * with the grid the client is looking at in their own app — and a coach and a client disagreeing
 * about what "this week" contains is the kind of difference that gets read as a bug in the
 * ticking rather than in the reporting. Defaults to Monday because that is what every locale
 * this app ships is on except Persian.
 */
export async function habitWeek(coachId, clientIds, { weekStartsOn = 1 } = {}, s = db()) {
  if (!clientIds?.length) return new Map()
  const first = Number.isInteger(weekStartsOn) ? ((weekStartsOn % 7) + 7) % 7 : 1
  const rows = await s`
    select h.user_id,
           sum(least(coalesce(t.n, 0), h.target_per_week))::int as done,
           sum(h.target_per_week)::int as target
    from habits h
    join coaching_links l
      on l.client_id = h.user_id and l.coach_id = ${coachId} and 'habits' = any(l.scopes)
    left join lateral (
      select count(*)::int as n from habit_ticks tk
      where tk.habit_id = h.id and tk.deleted_at is null
        and tk.on_date >= current_date
          - ((extract(dow from current_date)::int - ${first} + 7) % 7)
    ) t on true
    where h.user_id in ${s(clientIds)} and h.deleted_at is null and h.archived_at is null
    group by h.user_id`
  return new Map(rows.map(r => [r.user_id, {
    done: r.done, target: r.target, rate: r.target ? r.done / r.target : null
  }]))
}
