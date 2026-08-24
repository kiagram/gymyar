// Formatting + date helpers (ported from the vanilla app, unit taken from the store where needed).
import { dateLocale, t, weekStartsOn } from './i18n-adapter.js'
export const todayISO = () => {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
export const isoOf = d =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')

export const DAYN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/* Accepts a calendar day ('2026-08-01'), a full ISO timestamp, or a Date.
 *
 * The noon suffix is not decoration: parsing a bare 'YYYY-MM-DD' is defined as UTC midnight, so
 * anyone west of Greenwich sees the previous day. Noon local puts it safely inside the day
 * whatever the offset. That trick only works on a bare date, though — appending it to a full
 * timestamp produces "…ZT12:00:00" and Invalid Date, which is what the coaching screens showed
 * once they started rendering server timestamps. So normalise first, then apply it. */
export function fmtDate(value, long) {
  if (value == null) return ''
  const iso = value instanceof Date
    ? value.toISOString().slice(0, 10)
    : /^\d{4}-\d{2}-\d{2}/.test(String(value)) ? String(value).slice(0, 10) : String(value)
  const d = new Date(iso + 'T12:00:00')
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString(dateLocale(), long ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' })
}
export function fmtDur(ms) {
  const m = Math.floor(ms / 60000)
  return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + ' min'
}
// Imported history has no clock — an unknown duration is left out rather than shown as "0 min".
export const durPart = ms => (ms >= 60000 ? [fmtDur(ms)] : [])
// Numbers follow the UI language, like the dates above — a hardcoded locale put Swiss
// apostrophes ("7'535 kg") in front of every user, in every language.
export const fmtNum = n => (Math.round(n * 10) / 10).toLocaleString(dateLocale())
// Volume stays in the profile's unit throughout: the old shorthand turned anything over
// 10 000 into "t", which is wrong for a pound profile and made one list mix "18.8t" with
// "7'535 kg" — two numbers you can't compare at a glance.
export const fmtVol = (v, unit) => fmtNum(v) + ' ' + unit
// Plural forms are not automatic when the English string is the key.
export const exCount = n => t(n === 1 ? '{0} exercise' : '{0} exercises', n)

/**
 * The first day of the week containing `value`, as a Date at local noon.
 *
 * Which day that is is a locale question rather than a constant. Iran's week starts on Saturday,
 * and a Monday-anchored grid puts two of its days in the wrong week — which does not fail
 * visibly, it quietly shifts every heatmap cell, every streak and every "this week" count by two
 * days. Noon for the same reason `fmtDate` uses it: it survives any timezone offset.
 *
 * Accepts a calendar day, a full timestamp or a Date, like the other date helpers here.
 */
export function startOfWeek(value) {
  const d = value instanceof Date
    ? new Date(value)
    : new Date(String(value).slice(0, 10) + 'T12:00:00')
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() - weekdayOffset(d))
  return d
}

/** Which column of the week grid a date belongs in — 0 is the locale's first day. */
export const weekdayOffset = d => (d.getDay() - weekStartsOn() + 7) % 7

/**
 * The short weekday labels in the order this locale's week runs.
 *
 * `DAYS` is indexed by `getDay()` and always starts at Sunday, which is the right shape for
 * looking a day up and the wrong one for heading a grid. Rotating here means a calendar cannot
 * disagree with the offset that positions its cells.
 */
export const weekdayLabels = () => DAYS.slice(weekStartsOn()).concat(DAYS.slice(0, weekStartsOn()))

/**
 * Identity of the week a day falls in — the start of that week, as a calendar day.
 *
 * This is a bucket key rather than something anybody reads: it groups sets by week, answers
 * "same week as today", and counts distinct weeks for a streak. An ISO week number did that job
 * too, but it could not follow the locale and needed its own year-boundary arithmetic to get
 * right. A date sorts, compares and is obvious in a debugger.
 */
export const weekKey = d => isoOf(startOfWeek(d))

export const localTZ = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } }

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
/* Order is the order the swatches appear in. Red is the brand's own #e63935 rather than
 * the system red, and it leads because it is what the app ships as. */
export const ACCENTS = { red: '#e63935', lime: '#30d158', sky: '#0a84ff', orange: '#ff9f0a', violet: '#bf5af2', pink: '#ff375f', teal: '#40c8e0', gold: '#ffd60a' }
