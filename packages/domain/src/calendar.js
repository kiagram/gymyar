/* The calendar a date is *read* in, which is never the calendar it is stored in.
 *
 * Every date in this product is a Gregorian calendar day — `YYYY-MM-DD` in a `date` column, a
 * `d` on a workout, the key a heatmap cell matches on. That does not change here and must not:
 * two devices disagreeing about what today is called is a bug you cannot repair afterwards,
 * and a Jalali string in a `date` column is a value the database cannot compare, sort or index
 * as a date at all.
 *
 * What changes is the reading. A Persian reader's month starts on 1 Shahrivar, not on 1 August,
 * and every screen that says "this month", draws a month band, or lays out a grid of days was
 * asking `getMonth()` — which answers about August whoever is looking. The symptom is not a
 * crash. It is a calendar that is quietly, confidently wrong: a month grid with the right
 * number of cells starting on the wrong weekday, beside Jalali dates `fmtDate` renders
 * correctly, and a "this month" count that turns over on a day that means nothing to anybody.
 *
 * ## A Gregorian locale keeps exactly what it had
 *
 * Only a locale whose resolved calendar is *not* Gregorian reads its structure from `Intl`.
 * Everything else keeps the app's own `MONTHS` tables and its own arithmetic, unchanged.
 *
 * That split is deliberate rather than lazy. Intl's month names disagree with this app's own —
 * en-GB's short August is 'Sept' where the table says 'Sep', and that table is what every
 * screen has always rendered. Changing how the one Gregorian locale writes its months, in
 * order to teach a second calendar to a locale that does not use them, is a visible change to
 * the language that was already right.
 *
 * (This argument was originally about twelve such languages — French's 'janv.', lowercase
 * Spanish, a trailing dot in Russian. Eleven of them have since been dropped, which weakens
 * the arithmetic and not the reasoning: one correct language is still not worth restyling.)
 *
 * ## No date library
 *
 * `Intl` has the Persian calendar and `dateLocale()` already resolves to `fa-IR`, which already
 * resolves to it. So the conversion is a formatter, not an algorithm.
 *
 * The trick that makes that enough: **no Jalali arithmetic is ever required.** Every operation
 * here reduces to Gregorian arithmetic plus a Jalali *reading* of the result — the start of a
 * month is "this day minus (day-of-month − 1) days", and the length of a month is how many days
 * you can add before the month you read changes. Both are true in any calendar, so Esfand
 * having 29 days or 30 stays ICU's problem, and ICU already knows the answer.
 *
 * ## The trap
 *
 * `formatToParts` under `fa-IR` returns Persian digits — '۱۴۰۵', which `Number()` reads as NaN,
 * and NaN compares false against every month there is. Everything here that reads a number back
 * forces `numberingSystem: 'latn'`; everything meant for a person deliberately does not.
 */
import { dateLocale, t } from './i18n-adapter.js'
import { MONTHS, MONTHS_LONG, fmtInt } from './format.js'

/* Local noon, for the same reason every other date helper uses it: a bare 'YYYY-MM-DD' parses
 * as UTC midnight, so anyone west of Greenwich reads the day before. Accepts a calendar day, a
 * full timestamp or a Date, like the rest of `format.js`. */
export function atNoon(value) {
  if (value instanceof Date) { const c = new Date(value); c.setHours(12, 0, 0, 0); return c }
  const s = String(value)
  const iso = /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T12:00:00' : iso)
  if (!Number.isNaN(d.getTime())) d.setHours(12, 0, 0, 0)
  return d
}

export const addDays = (value, n) => {
  const d = atNoon(value)
  d.setDate(d.getDate() + n)
  d.setHours(12, 0, 0, 0)
  return d
}

/* Formatters are expensive to build and would otherwise be built once per cell of a 365-cell
 * heatmap. Keyed by locale as well as by options, because the locale changes at runtime — a
 * cache that ignored it would keep rendering Persian months to somebody who switched back. */
const cache = new Map()
const formatter = opts => {
  const locale = dateLocale()
  const key = locale + '|' + JSON.stringify(opts)
  let f = cache.get(key)
  if (!f) { f = new Intl.DateTimeFormat(locale, opts); cache.set(key, f) }
  return f
}

const NUMERIC = { numberingSystem: 'latn', year: 'numeric', month: 'numeric', day: 'numeric' }

/**
 * Which calendar this locale reads dates in — 'persian' under fa-IR, 'gregory' elsewhere.
 *
 * Asked of `Intl` rather than written down as a list, so a locale added later brings its own
 * answer with it instead of silently getting the wrong one.
 */
export const calendarOf = () => {
  try { return formatter({}).resolvedOptions().calendar || 'gregory' } catch { return 'gregory' }
}

export const isGregorian = () => calendarOf() === 'gregory'

/** Year, month (1-12) and day as the reader's calendar numbers them. */
export function dateParts(value) {
  const d = atNoon(value)
  if (Number.isNaN(d.getTime())) return { year: NaN, month: NaN, day: NaN }
  // The overwhelmingly common path, and the one that must not change: the Date already holds
  // these numbers, and going through a formatter to get them back would be slower and no more
  // correct.
  if (isGregorian()) return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }
  const parts = formatter(NUMERIC).formatToParts(d)
  const pick = type => Number(parts.find(p => p.type === type)?.value)
  return { year: pick('year'), month: pick('month'), day: pick('day') }
}

/**
 * The bucket key for the month a day falls in, in the reader's calendar.
 *
 * This is what replaces `iso.slice(0, 7)`. That worked only because a Gregorian month key is a
 * prefix of a Gregorian date — precisely the coincidence a second calendar does not preserve.
 * The failure is silent, because the count it produces is still a number.
 */
export function monthKey(value) {
  const { year, month } = dateParts(value)
  return Number.isNaN(year) ? '' : `${year}-${String(month).padStart(2, '0')}`
}

export const sameMonth = (a, b) => monthKey(a) === monthKey(b)

/** The first day of the month containing `value`, as a Date at local noon. */
export function startOfMonth(value) {
  const d = atNoon(value)
  const { day } = dateParts(d)
  return Number.isNaN(day) ? d : addDays(d, -(day - 1))
}

/**
 * How many days that month has — 28 to 31, or the Jalali leap year's 30th of Esfand.
 *
 * Counted rather than looked up. A table of month lengths is a leap-year rule in disguise, and
 * this calendar's rule is not one anybody should be keeping a second copy of.
 */
export function daysInMonth(value) {
  const start = startOfMonth(value)
  const { month } = dateParts(start)
  if (Number.isNaN(month)) return 30
  let n = 28
  while (n < 32 && dateParts(addDays(start, n)).month === month) n++
  return n
}

/** Every day of that month, in order — the cells of a grid, and their count. */
export function monthDays(value) {
  const start = startOfMonth(value)
  return Array.from({ length: daysInMonth(start) }, (_, i) => addDays(start, i))
}

/**
 * The start of the month `n` months away, in the reader's calendar. Negative goes back.
 *
 * Named `stepMonth` rather than `addMonths` because `entitlement.js` already exports that one,
 * and the two are not interchangeable: this walks a calendar a person is looking at, that one
 * extends a paid-through date. A star-export collision would have quietly dropped one of them
 * from the package.
 */
export function stepMonth(value, n) {
  let d = startOfMonth(value)
  for (let i = 0; i < Math.abs(n); i++) {
    d = n > 0 ? addDays(d, daysInMonth(d)) : startOfMonth(addDays(d, -1))
  }
  return d
}

/**
 * The month's name, in the reader's language and calendar.
 *
 * A Gregorian locale is answered from the app's own translations — see the header. Only a
 * calendar whose months this app has no names for asks Intl for them.
 */
export function monthLabel(value, { long = true } = {}) {
  const d = atNoon(value)
  if (isGregorian()) return t((long ? MONTHS_LONG : MONTHS)[d.getMonth()])
  return formatter({ month: long ? 'long' : 'short' }).format(d)
}

/**
 * A month and its year, as that language writes the pair.
 *
 * Composed rather than asked of Intl as one format, because ICU's Persian pattern puts the year
 * first — '۱۴۰۵ شهریور', which is not how anybody writes it. Each half is right on its own; the
 * order between two words is the part worth deciding here.
 */
export const monthYearLabel = value =>
  `${monthLabel(value)} ${fmtInt(dateParts(value).year)}`

/** The day-of-month a date falls on, in the reader's calendar and digits.
 *
 * `fmtInt` is `format.js`'s — a Persian screen must not put "23" beside "۱٬۲۳۴", and one screen
 * in two numbering systems reads as two different apps. */
export const dayNum = value => fmtInt(dateParts(value).day)
