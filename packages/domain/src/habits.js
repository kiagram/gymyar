/* Habits: the things done between sessions, and whether they were.
 *
 * Pure, like everything else the domain owns. A tick is a date on a habit and nothing more, so
 * every question worth asking about one — did they do it today, how is this week going, how
 * many weeks in a row have they hit it — is arithmetic over a list of dates.
 *
 * Weeks come from `weekKey`, which follows the reader's locale, so a Persian week runs Saturday
 * to Friday here exactly as it does in the heatmap. That matters more than it sounds: a habit
 * with a target of five days a week is judged against a boundary, and drawing the boundary two
 * days out shifts every week's verdict.
 */
import { weekKey, isoOf } from './format.js'

/**
 * How many active habits somebody may keep.
 *
 * Not a storage limit. A list of thirty habits is a list nobody ticks, and the way that fails
 * is not that the thirty-first is refused — it is that the first five stop being done either.
 * Archived ones do not count: the cap is on what a person is asked about today.
 */
export const MAX_ACTIVE = 10

/** A week can ask for every day of itself, and no more. */
export const MIN_TARGET = 1
export const MAX_TARGET = 7

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/**
 * Coerce a habit into something storable, or null if there is no habit there.
 *
 * A title is the whole of what a habit is — there is no other field carrying meaning — so a
 * blank one is not a habit with a missing name, it is not a habit.
 */
export function normaliseHabit(h) {
  if (!h || typeof h !== 'object') return null
  const title = String(h.title ?? '').trim().slice(0, 80)
  if (!title) return null

  const raw = Number(h.target ?? h.target_per_week)
  return {
    title,
    target: Number.isFinite(raw) ? clamp(Math.round(raw), MIN_TARGET, MAX_TARGET) : MAX_TARGET
  }
}

/** Ticks as a set of `habitId|date`, which is the shape every "is it done?" lookup wants. */
export const tickIndex = ticks =>
  new Set((ticks || []).map(t => `${t.h}|${t.d}`))

export const isTicked = (index, habitId, date) => index.has(`${habitId}|${date}`)

/** Every date this habit was ticked on, ascending. */
export const datesFor = (ticks, habitId) =>
  (ticks || []).filter(t => t.h === habitId).map(t => t.d).sort()

/**
 * How a habit's week is going: days done, days asked for, and whether that is enough.
 *
 * `on` names any day inside the week in question, not its start — callers have a date in hand
 * (today, or the day a chart cell is about) and should not have to know where a week begins to
 * ask about it.
 */
export function weekProgress(habit, dates, on = isoOf(new Date())) {
  const week = weekKey(on)
  const target = normaliseHabit(habit)?.target ?? MAX_TARGET
  const done = (dates || []).filter(d => weekKey(d) === week).length
  return { done, target, met: done >= target, left: Math.max(0, target - done) }
}

/**
 * Consecutive weeks this habit hit its target, counting back from the week containing `on`.
 *
 * The current week does not have to be finished. A habit with a target of five, four days in on
 * a Wednesday, is not on a broken streak — it is mid-week, and a counter that says zero until
 * Friday is a counter that punishes people for looking at it. So an unmet *current* week is
 * skipped rather than ending the run, and every week before it must have been met.
 *
 * Named for habits rather than sharing `streakWeeks` with `history.js`: that one counts weeks
 * somebody trained at all, this one counts weeks a target was reached, and a package that
 * exported both under one name would export neither.
 */
export function habitStreakWeeks(habit, dates, on = isoOf(new Date())) {
  const target = normaliseHabit(habit)?.target ?? MAX_TARGET
  const perWeek = new Map()
  for (const d of dates || []) perWeek.set(weekKey(d), (perWeek.get(weekKey(d)) ?? 0) + 1)

  let streak = 0
  const cur = new Date(String(on).slice(0, 10) + 'T12:00:00')
  for (let i = 0; i < 520; i++) {
    const met = (perWeek.get(weekKey(isoOf(cur))) ?? 0) >= target
    if (met) streak++
    else if (i > 0) break
    cur.setDate(cur.getDate() - 7)
  }
  return streak
}

/**
 * Consecutive days up to and including `on`, for a habit that is asked for daily.
 *
 * Only meaningful at a target of seven — a run of days says nothing about a habit that was
 * never supposed to happen on all of them — so it answers null for the rest rather than a
 * number a screen would render as though it meant something.
 */
export function currentRunDays(habit, dates, on = isoOf(new Date())) {
  if ((normaliseHabit(habit)?.target ?? MAX_TARGET) !== MAX_TARGET) return null
  const has = new Set(dates || [])
  let run = 0
  const cur = new Date(String(on).slice(0, 10) + 'T12:00:00')
  // Today not being ticked yet is not a broken run — the day is not over.
  if (!has.has(isoOf(cur))) cur.setDate(cur.getDate() - 1)
  while (has.has(isoOf(cur)) && run < 3650) {
    run++
    cur.setDate(cur.getDate() - 1)
  }
  return run
}

/**
 * Adherence across every active habit, for the week containing `on`.
 *
 * What a coach's roster shows next to a client's name, and what the client sees at the top of
 * their own list. Days rather than habits: two of three habits fully done reads as 67%, which
 * flatters somebody who skipped one entirely, where six of nine days says what happened.
 *
 * Null when there is nothing to be adherent to — a client with no habits is not at zero, the
 * same reason `roster` refuses to print 0% for somebody with no weekly plan.
 */
export function weekAdherence(habits, ticks, on = isoOf(new Date())) {
  const active = (habits || []).filter(h => !h.arch)
  if (!active.length) return null

  let done = 0
  let target = 0
  for (const h of active) {
    const p = weekProgress(h, datesFor(ticks, h.id), on)
    // Capped per habit: eight ticks against a target of five is not 160% of anything.
    done += Math.min(p.done, p.target)
    target += p.target
  }
  return target ? done / target : null
}
