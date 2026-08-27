/* The habit list, as the screens need it.
 *
 * Everything that is arithmetic — a week's progress, a streak, adherence — is in the domain and
 * shared with the server. What is here is the small amount that is only about this app's state
 * shape: which habits are being asked about today, and what ticking one does to `S.habitTicks`.
 *
 * These are pure functions over state rather than store actions, so they can be tested without
 * a store, a component or a browser.
 */
import { uid, todayISO, normaliseHabit, MAX_ACTIVE } from '@gymyar/domain'

/** The habits somebody is being asked about, in the order they should be shown. */
export const activeHabits = S => (S.habits || []).filter(h => !h.arch)

/** Whether one more can be added. Archived ones do not count — see `MAX_ACTIVE`. */
export const hasRoom = S => activeHabits(S).length < MAX_ACTIVE

/**
 * Ticks with one day flipped.
 *
 * Returns a new array rather than mutating, and returns the *same* array when nothing changes,
 * so a caller can tell a no-op apart from a change without comparing contents.
 */
export function toggledTicks(ticks, habitId, date = todayISO()) {
  const list = ticks || []
  const i = list.findIndex(t => t.h === habitId && t.d === date)
  return i === -1
    ? [...list, { h: habitId, d: date }]
    : [...list.slice(0, i), ...list.slice(i + 1)]
}

export const isTickedOn = (S, habitId, date = todayISO()) =>
  (S.habitTicks || []).some(t => t.h === habitId && t.d === date)

/**
 * Add a habit to a state object, in place — the shape `update()` hands its callback.
 *
 * Returns the id, or null when there was no habit to add: a blank title, or a list already at
 * its cap. The caller decides what to say about it; this decides nothing about wording.
 */
export function addHabit(S, { title, target }) {
  const clean = normaliseHabit({ title, target })
  if (!clean || !hasRoom(S)) return null

  const id = uid()
  S.habits = [...(S.habits || []), { id, title: clean.title, target: clean.target, by: null, link: null, arch: null }]
  return id
}

/**
 * Retire a habit, keeping every tick it already has.
 *
 * Archived rather than removed, because the ticks are the record of six months somebody spent
 * doing the thing, and a grid of them belonging to nothing is not an improvement on a row that
 * says what they were.
 */
export function archiveHabit(S, id) {
  const h = (S.habits || []).find(x => x.id === id)
  if (h) h.arch = new Date().toISOString()
}

/**
 * Delete a habit and everything ticked on it.
 *
 * The other door, for a habit added by mistake. Ticks go too — they are only meaningful as
 * "days this habit happened", and the sync layer tombstones both so other devices agree.
 */
export function removeHabit(S, id) {
  S.habits = (S.habits || []).filter(h => h.id !== id)
  S.habitTicks = (S.habitTicks || []).filter(t => t.h !== id)
}
