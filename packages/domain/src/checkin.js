/* Check-ins: the questions a coach asks every week, and the shape of an answer.
 *
 * The division is the same one the planner draws. This file owns what a field is, what an
 * answer may be and when a check-in is due — all of it pure, all of it running unchanged on the
 * phone that fills the form and on the server that stores it. A language model is not involved
 * anywhere: nothing here is a matter of phrasing.
 *
 * Why validation is shared rather than server-side
 * ------------------------------------------------
 * A check-in is filled in offline. The phone has to know that 11 is not a valid answer to a
 * 1–5 question at the moment somebody types it, not a day later when the sync finally lands —
 * and the server has to know the same thing, because a client is not a thing you trust. Two
 * implementations of one rule is how they drift, and the one that drifts is always the one
 * nobody is looking at.
 */

/** What a field can ask for. */
export const FIELD_TYPES = ['bodyweight', 'measure', 'scale', 'bool', 'text', 'photo']

/**
 * A 1–5 scale, and nothing else on offer.
 *
 * Sleep, energy, soreness and stress are not measurements; they are somebody's impression on a
 * Saturday morning. Ten points of resolution on an impression is false precision that makes a
 * trend look like data — and unlike RIR, which counts something real, there is no anchor here
 * to make a 7 mean the same thing in March as it did in January. Five points, one scale, so a
 * chart of one field can be read beside another.
 */
export const SCALE_MIN = 1
export const SCALE_MAX = 5

/* A photo is asked for and is never answered *here*.
 *
 * The answer is an attachment with a date on it, behind the `photos` scope — see migration 007.
 * The field exists so a template can say "and send a photo"; storing anything for it in
 * `answers` would be a second copy of a consent decision that has already been made properly
 * somewhere else. */
const STORES_NOTHING = new Set(['photo'])

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const str = (v, max) => String(v ?? '').trim().slice(0, max)
const num = v => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * The questions somebody with no coach answers.
 *
 * Not a row. A client tracking their own weeks needs no coaching relationship and no template
 * belonging to anybody, and a table holding one identical row per user is a table holding a
 * constant. `template_id` null means this.
 */
export const BUILT_IN_FIELDS = [
  { key: 'weight', type: 'bodyweight', label: 'Body weight' },
  { key: 'sleep', type: 'scale', label: 'Sleep' },
  { key: 'energy', type: 'scale', label: 'Energy' },
  { key: 'soreness', type: 'scale', label: 'Soreness' },
  { key: 'notes', type: 'text', label: 'Anything worth saying' }
]

/** A key that can be a JSON property and a form input's name without being escaped anywhere. */
const KEY_OK = /^[a-z][a-z0-9_]{0,31}$/

/**
 * Coerce one field definition into something answerable, or null if it is not one.
 *
 * Dropped rather than rejected: a template is edited by a person in a form, and one unusable
 * row should cost that row rather than the save. What cannot be dropped is a bad `key` — every
 * answer is filed under it — so a field without a usable one is not a field.
 */
export function normaliseField(f) {
  if (!f || typeof f !== 'object') return null
  const key = String(f.key ?? '').trim().toLowerCase()
  if (!KEY_OK.test(key)) return null
  const type = FIELD_TYPES.includes(f.type) ? f.type : 'text'

  const field = { key, type, label: str(f.label, 80) || key }
  if (f.required) field.required = true
  // Only a `measure` carries its own bounds; a scale's are fixed and a number that could be
  // anything is how you get a waist of 4,000.
  if (type === 'measure') {
    const min = num(f.min), max = num(f.max)
    if (min != null) field.min = min
    if (max != null && (min == null || max > min)) field.max = max
    field.unit = str(f.unit, 12) || null
  }
  return field
}

/**
 * A whole template's fields: valid, unique by key, and capped.
 *
 * The cap is not a storage limit — it is the length of a form somebody fills in every week. A
 * check-in with thirty questions is one that gets answered twice and then never again, and the
 * failure mode of that is a coach concluding their client has gone quiet.
 */
export const MAX_FIELDS = 12

export function normaliseFields(fields) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(fields) ? fields : []) {
    const f = normaliseField(raw)
    if (!f || seen.has(f.key)) continue
    seen.add(f.key)
    out.push(f)
    if (out.length === MAX_FIELDS) break
  }
  return out
}

/** The fields a check-in was answering — a coach's template, or the built-in set. */
export const fieldsOf = template =>
  (template?.fields?.length ? normaliseFields(template.fields) : BUILT_IN_FIELDS)

/**
 * Coerce a set of answers to the fields that were asked.
 *
 * Answers to fields the template no longer has are **kept**, untouched. That is deliberate and
 * it is the opposite of what validation usually does: this is a record of what a person said,
 * and a coach reordering their questions in April cannot make somebody un-say something in
 * March. What the coach's edit changes is what gets *asked* next week.
 */
export function normaliseAnswers(fields, answers) {
  const asked = new Map((fields || []).map(f => [f.key, f]))
  const out = {}

  for (const [key, value] of Object.entries(answers || {})) {
    const field = asked.get(key)
    if (!field) { out[key] = value; continue }        // no longer asked; still what they said
    if (STORES_NOTHING.has(field.type)) continue
    if (value == null || value === '') continue        // unanswered is absent, not null

    switch (field.type) {
      case 'scale': {
        const n = num(value)
        if (n != null) out[key] = Math.round(clamp(n, SCALE_MIN, SCALE_MAX))
        break
      }
      case 'bodyweight':
      case 'measure': {
        const n = num(value)
        if (n == null) break
        const lo = field.min ?? 0
        const hi = field.max ?? Number.MAX_SAFE_INTEGER
        // Rounded to a tenth: nobody's waist is 81.4732 cm, and a stored precision the form
        // cannot produce makes two equal measurements compare unequal.
        if (n >= lo && n <= hi) out[key] = Math.round(n * 10) / 10
        break
      }
      case 'bool':
        out[key] = !!value
        break
      default:
        out[key] = str(value, 2000)
    }
  }
  return out
}

/** Every required field that has no answer. Empty means it can be submitted. */
export const missingFrom = (fields, answers) =>
  (fields || [])
    .filter(f => f.required && !STORES_NOTHING.has(f.type))
    .filter(f => answers?.[f.key] === undefined || answers[f.key] === '')
    .map(f => f.key)

/**
 * The date a week's check-in is filed under: the scheduled weekday inside that week.
 *
 * Not "the next Saturday". A check-in filled in on Sunday for a Saturday due date belongs to
 * the week it is *about*, and filing it under the day it was typed would put two of them in one
 * week and none in the next. The week is named by its first day, which the caller works out —
 * which weekday a week begins on is a locale question this file has no business answering, and
 * `startOfWeek` in `format.js` already answers it.
 */
export function checkinDateFor(weekStart, weekday) {
  const d = new Date(weekStart)
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7))
  return d
}

/**
 * How far past due a scheduled check-in is, in whole days. Negative is not yet due.
 *
 * A number rather than a boolean because the two callers want different things from it: the
 * form shows one that is due, and a coach's roster wants to know that this client is three
 * weeks behind rather than merely behind.
 */
export function daysOverdue(dueDate, now = Date.now()) {
  /* Noon first, then the end of the day. A bare 'YYYY-MM-DD' parses as UTC midnight, which is
   * the *previous* calendar day for every reader west of Greenwich — so applying local hours to
   * it straight away moves the deadline a day early for half the world. Same trick, same
   * reason, as `fmtDate` in format.js. */
  const d = dueDate instanceof Date
    ? new Date(dueDate)
    : new Date(String(dueDate).slice(0, 10) + 'T12:00:00')
  d.setHours(23, 59, 59, 999)
  return Math.floor((now - d.getTime()) / 86400000)
}

/* ------------------------------------------------------------- reading ---- */

/* A week of answers is a data point; a run of them is a signal. What follows turns the second
 * into numbers the review can act on, and it is deliberately smaller than it could be.
 *
 * ## Why an arbitrary scale is not readable
 *
 * A `scale` field says a person answered 1–5. It does not say which end is the good one, and
 * nothing in a template can: soreness at 5 is a problem, energy at 5 is not, and a coach who
 * asks about stress means the first while one who asks about motivation means the second. The
 * type is the same in all four cases.
 *
 * So direction is not inferred — it is known, for the three keys the built-in check-in defines
 * and that a coach's template overwhelmingly copies, and unknown for everything else. An
 * unknown scale still produces a series a screen can chart; what it does not produce is a
 * finding claiming somebody is run down. Guessing that from the field type is how you tell a
 * person their stress is dangerously low.
 *
 * The same reasoning stops `measure` short of a judgement. A waist coming down and an arm
 * coming down are the same number and opposite news, and the field carries no way to tell them
 * apart, so a measurement's trend is reported and never rated.
 */

/** Which way is up, for the scales whose meaning the built-in check-in fixes. */
export const SCALE_DIRECTION = { sleep: 'up-good', energy: 'up-good', soreness: 'up-bad' }

/** Types that hold a number worth putting on a line. `bool` and `text` are not one. */
const NUMERIC = new Set(['bodyweight', 'measure', 'scale'])

/**
 * Submitted check-ins, read as one series per numeric field.
 *
 * `fields` is what the answers were *asked* by — a coach's template, or the built-in set. A key
 * nothing describes is skipped rather than guessed at: an answer is a number under a name, and
 * without the field it could be kilograms, centimetres or a rating out of five.
 *
 * Drafts are excluded. A half-filled form is not an answer, and a weight typed into one before
 * somebody stood on the scale would move a trend that nobody meant to report.
 *
 * Returns `{ [key]: { field, points: [{ d, v }] } }`, points ascending by date.
 */
export function numericSeries(checkins, fields = BUILT_IN_FIELDS) {
  /* Built-ins underneath rather than instead: a coach's template that drops `sleep` has stopped
   * asking about it, which does not unname the answers already given under that key. */
  const asked = new Map(BUILT_IN_FIELDS.map(f => [f.key, f]))
  for (const f of normaliseFields(fields)) asked.set(f.key, f)

  const out = {}
  for (const c of [...(checkins || [])].sort((a, b) => (a.d < b.d ? -1 : 1))) {
    if (!c?.at) continue
    for (const [key, value] of Object.entries(c.a || {})) {
      const field = asked.get(key)
      if (!field || !NUMERIC.has(field.type)) continue
      const v = num(value)
      if (v == null) continue
      ;(out[key] ??= { field, points: [] }).points.push({ d: c.d, v })
    }
  }
  return out
}

/**
 * The line through a series, and what it is worth.
 *
 * Least squares against the *dates*, not against the positions in the array. A person who
 * answered three weeks running and then again after a month apart has a gap in the series, and
 * treating those four answers as four equal steps would report a month of drift as a week of it.
 *
 * `perWeek` is the slope in the field's own units; `pctPerWeek` is that as a share of the mean,
 * which is the only form in which two people's weight change can be compared. Both are null
 * below three points or inside a week — a trend drawn through two answers is a line drawn
 * through two answers.
 */
export function trendOf(points = []) {
  const pts = points.filter(p => Number.isFinite(p?.v))
  const n = pts.length
  if (!n) return { n: 0, mean: null, first: null, last: null, perWeek: null, pctPerWeek: null, days: 0 }

  const at = p => new Date(String(p.d).slice(0, 10) + 'T12:00:00').getTime() / 86400000
  const mean = pts.reduce((a, p) => a + p.v, 0) / n
  const first = pts[0].v
  const last = pts[n - 1].v
  const days = Math.round(at(pts[n - 1]) - at(pts[0]))

  if (n < 3 || days < 7 || mean === 0) {
    return { n, mean, first, last, perWeek: null, pctPerWeek: null, days }
  }

  const t0 = at(pts[0])
  const xs = pts.map(p => at(p) - t0)
  const xbar = xs.reduce((a, b) => a + b, 0) / n
  let sxy = 0; let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - xbar) * (pts[i].v - mean)
    sxx += (xs[i] - xbar) ** 2
  }
  if (!sxx) return { n, mean, first, last, perWeek: null, pctPerWeek: null, days }

  const perDay = sxy / sxx
  return {
    n, mean, first, last, days,
    perWeek: perDay * 7,
    pctPerWeek: (perDay * 7 * 100) / Math.abs(mean)
  }
}
