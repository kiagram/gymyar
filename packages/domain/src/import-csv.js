// Import a training history exported from another app.
//
// Every one of these apps exports the same thing in a different dialect: one row per
// *set*, carrying a date, an exercise name and some mix of weight/reps/distance/time.
// So this reads a column MAP built from the header rather than fixed positions, which
// means a new app is usually a few header aliases rather than another importer.
//
// Verified against real exports:
//   FitNotes (Android) Date,Exercise,Category,Weight,Weight Unit,Reps,Distance,Distance Unit,Time,Comment
//   FitNotes 2 (iOS)   Date,Exercise,Category,Weight (kg),Weight (lbs),Reps,Distance,Distance Unit,Time,Notes,Kind
//   Strong             Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE
//   Hevy               title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe
// Anything else falls through to loose header matching, which covers Lyfta and the
// spreadsheet round-trips people actually have on disk, as long as the file has a
// date, an exercise name and something measured.
//
// Apple Health is a different animal — an XML dump, often hundreds of MB. parseAppleHealth()
// reads its sessions, its heart rate and its weigh-ins by scanning rather than building a
// DOM; parseBodyweight() is the older and narrower path, and still the one a plain CSV of
// weights takes.

import { EXDB, EXIDX } from './exercises.js'
import { uid } from './format.js'
import { hrStats, restingHr, RESTING_LOWEST } from './heartrate.js'

/* ----------------------------------------------------------------- CSV ---- */

/**
 * A real CSV reader: quoted fields, embedded commas and newlines, doubled quotes, BOM
 * and CRLF. Splitting on commas breaks on the first exercise named "Bench Press, Close
 * Grip" — and a whole history would import shifted by one column without ever erroring.
 */
export function parseCSV(text) {
  const rows = []
  let row = [], field = '', quoted = false
  const s = String(text).replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++ } else quoted = false }
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(x => x !== '')) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some(x => x !== '')) rows.push(row)
  return rows
}

const norm = h => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// header text -> the field we care about. Specific names first; first match wins.
const COLUMNS = [
  ['exercise', ['exercise', 'exercise name', 'exercise title']],
  ['date', ['date', 'workout date']],
  ['startTime', ['start time']],
  ['endTime', ['end time']],
  ['workoutName', ['workout name', 'title']],
  ['category', ['category', 'body part', 'muscle group']],
  ['weightKg', ['weight kg']],
  ['weightLb', ['weight lbs', 'weight lb']],
  ['weight', ['weight']],
  ['weightUnit', ['weight unit', 'unit']],
  ['reps', ['reps', 'repetitions']],
  // Hevy and Strong both write an RPE per set. Nothing mainstream exports RIR, but read it
  // when it is there rather than dropping the column on the floor.
  ['rpe', ['rpe', 'rpe rating']],
  ['rir', ['rir', 'reps in reserve']],
  ['distanceKm', ['distance km']],
  ['distance', ['distance']],
  ['distanceUnit', ['distance unit']],
  ['seconds', ['seconds', 'duration seconds']],
  ['time', ['time', 'duration']],
  ['setType', ['set type']],
  ['note', ['comment', 'comments', 'notes', 'note']],
]

function mapHeader(header) {
  const map = {}
  header.forEach((h, i) => {
    const n = norm(h)
    for (const [field, names] of COLUMNS) {
      if (map[field] === undefined && names.includes(n)) { map[field] = i; return }
    }
  })
  return map
}

/** Name of the app a header looks like — shown back to the user so they can sanity-check. */
export function detectSource(header) {
  const h = header.map(norm)
  if (h.includes('exercise title') && h.includes('set index')) return 'Hevy'
  if (h.includes('exercise name') && h.includes('set order')) return 'Strong'
  if (h.includes('exercise') && h.includes('kind')) return 'FitNotes (iOS)'
  if (h.includes('exercise') && h.includes('weight unit')) return 'FitNotes'
  if (h.includes('exercise') && h.includes('category')) return 'FitNotes'
  return null
}

/* ------------------------------------------------------ exercise matching -- */

// Other apps bolt qualifiers onto names — Hevy writes "Leg Press (Machine)", Strong
// "Snatch (Barbell)", FitNotes "Lat Pulldown (Pulley)" — while the dataset writes
// "barbell snatch". Strip the parentheses, expand the shorthand, then compare as a
// sorted bag of words so word order stops mattering.
const SYN = [
  [/\bbb\b/g, 'barbell'], [/\bdb\b/g, 'dumbbell'], [/\bkb\b/g, 'kettlebell'],
  [/\bohp\b/g, 'overhead press'], [/\bbw\b/g, 'body weight'], [/\bbodyweight\b/g, 'body weight'],
  [/\bmachine\b/g, 'lever'], [/\bsmith machine\b/g, 'smith'], [/\bez bar\b/g, 'ez barbell'],
  [/\bpull ups?\b/g, 'pull up'], [/\bchin ups?\b/g, 'chin up'], [/\bpush ups?\b/g, 'push up'],
  [/\bsit ups?\b/g, 'sit up'], [/\bdips?\b/g, 'dip'], [/\braises?\b/g, 'raise'],
  [/\bcurls?\b/g, 'curl'], [/\bpresses\b/g, 'press'], [/\bextensions?\b/g, 'extension'],
  [/\bcables?\b/g, 'cable'], [/\bseated\b/g, 'seated'], [/\bassisted\b/g, 'assisted'],
]
// Words that say nothing about which exercise this is, so they shouldn't stop a match.
const FILLER = new Set(['the', 'a', 'with', 'and', 'v', 'variation', 'version', 'pulley', 'weighted'])

function wordsOf(name) {
  // Parentheses are unwrapped rather than dropped: "Bench Press (Barbell)" carries its
  // equipment in there, and the dataset writes that as "barbell bench press".
  let k = String(name || '').toLowerCase()
    .replace(/[()[\]]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  SYN.forEach(([re, to]) => { k = k.replace(re, to) })
  return k.split(' ').filter(w => w && !FILLER.has(w))
}
const keyOf = name => wordsOf(name).sort().join(' ')

let INDEX = null
function buildIndex() {
  if (INDEX) return INDEX
  INDEX = { exact: new Map(), all: [] }
  EXDB.forEach(e => {
    const w = wordsOf(e.n)
    const k = w.slice().sort().join(' ')
    if (!INDEX.exact.has(k)) INDEX.exact.set(k, e.id)
    INDEX.all.push({ id: e.id, set: new Set(w), n: w.length })
  })
  return INDEX
}

// Curated: the names people actually log, mapped by hand to the dataset id they mean.
//
// Other apps let you name a lift "Bench Press"; the dataset only has qualified names
// like "barbell bench press". Word-overlap alone can't resolve that — "bench press" sits
// inside thirty-three entries — and where it *is* unique it tends to be wrong, happily
// resolving "Squat" to "weighted squat" and "Leg Press" to "smith leg press". So the
// common vocabulary is spelled out. The convention is that an unqualified name means the
// canonical barbell version, which is what these apps assume when they show it to you.
// Extending this table is the intended way to improve import accuracy.
const ALIAS_EX = {
  'bench press': '0025', 'barbell bench press': '0025', 'flat bench press': '0025',
  'incline bench press': '0047', 'decline bench press': '0033',
  'close grip bench press': '0030', 'close-grip bench press': '0030',
  squat: '0043', 'back squat': '0043', 'barbell squat': '0043', 'front squat': '0042',
  deadlift: '0032', 'romanian deadlift': '0085', rdl: '0085', 'sumo deadlift': '0117',
  'lat pulldown': '2330', 'lat pull down': '2330', pulldown: '2330',
  shrug: '0095', shrugs: '0095',
  'overhead press': '0091', 'military press': '0091', 'shoulder press': '0091', ohp: '0091',
  'barbell row': '0027', 'bent over row': '0027', 'bent-over row': '0027',
  'dumbbell row': '0292', 'one arm dumbbell row': '0292',
  'leg curl': '0586', 'lying leg curl': '0586', 'seated leg curl': '0586',
  'leg press': '0739', 'leg extension': '0585',
  'calf raise': '1372', 'standing calf raise': '1372', 'seated calf raise': '0088',
  'lateral raise': '0334', 'side raise': '0334', 'reverse fly': '0348', 'rear delt fly': '0348',
  'bicep curl': '0294', 'biceps curl': '0294', 'dumbbell curl': '0294',
  'preacher curl': '0070', 'barbell curl': '0031',
  'tricep pushdown': '0241', 'triceps pushdown': '0241', pushdown: '0241',
  skullcrusher: '0060', 'skull crusher': '0060', 'lying triceps extension': '0061',
  lunge: '0054', lunges: '0054', 'cable crossover': '1269', 'cable cross over': '1269',
}

let ALIAS_IDX = null
const aliasIndex = () => {
  if (!ALIAS_IDX) {
    ALIAS_IDX = new Map()
    for (const k in ALIAS_EX) ALIAS_IDX.set(wordsOf(k).sort().join(' '), ALIAS_EX[k])
  }
  return ALIAS_IDX
}

/**
 * Find the dataset exercise a foreign name refers to, or null.
 *
 * Curated alias first, then an exact word-bag match, then entries that contain every
 * word of the query — but only when exactly one candidate is that close. Guessing
 * between "barbell bench press" and "dumbbell bench press" would file years of training
 * under the wrong lift, which is worse than leaving it as a custom exercise the user can
 * see and fix.
 *
 * Named for the import rather than for the matching, because `parse-log.js` resolves exercises
 * too and does it by opposite rules — that one takes a phrase somebody just typed and picks the
 * *shortest* name containing every word, because a person writing "bench" means the obvious one.
 * This takes a name from somebody else's export and refuses unless it is certain, because a
 * wrong guess here is silent and permanent.
 *
 * Both were called `matchExercise`, and both are re-exported by the package root. A star export
 * with two of the same name resolves to neither: `import { matchExercise } from '@gymyar/domain'`
 * was `undefined`, with the build saying so in a line nobody reads.
 */
export function matchImportedName(name) {
  const idx = buildIndex()
  const w = wordsOf(name)
  if (!w.length) return null
  // Compared as a sorted bag of words, so "Squat (Barbell)" finds the 'barbell squat'
  // alias — the exporters disagree about whether the equipment leads or trails.
  const sorted = w.slice().sort().join(' ')
  const aliased = aliasIndex().get(sorted)
  if (aliased && EXIDX[aliased]) return aliased
  const exact = idx.exact.get(sorted)
  if (exact) return exact
  const q = new Set(w)
  let best = null, bestExtra = Infinity, ties = 0
  for (const c of idx.all) {
    let ok = true
    for (const word of q) if (!c.set.has(word)) { ok = false; break }
    if (!ok) continue
    const extra = c.n - q.size
    if (extra > 2) continue
    if (extra < bestExtra) { best = c.id; bestExtra = extra; ties = 1 }
    else if (extra === bestExtra) ties++
  }
  return ties === 1 ? best : null
}

// Categories the exporters use -> the dataset's body parts, for exercises we invent.
const CATEGORY_BP = {
  chest: 'chest', back: 'back', lats: 'back', shoulders: 'shoulders', delts: 'shoulders',
  legs: 'upper legs', quads: 'upper legs', hamstrings: 'upper legs', glutes: 'upper legs',
  calves: 'lower legs', abs: 'waist', core: 'waist', obliques: 'waist',
  arms: 'upper arms', biceps: 'upper arms', triceps: 'upper arms', forearms: 'lower arms',
  cardio: 'cardio', 'full body': 'upper legs', olympic: 'upper legs', neck: 'neck',
}

/* ----------------------------------------------------------- conversion --- */

const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : 0 }
// An effort rating out of someone else's export. A blank cell means "not rated" and has to
// stay absent rather than becoming 0 — and 0 itself means opposite things on the two scales:
// RIR 0 is a set taken to failure and worth keeping, while RPE has no 0 (the scale is 1–10),
// so an app writing 0 for "nothing here" must not be read as an effort. Ratings above the
// scale are capped rather than dropped — the set was still rated, just written oddly.
const effortNum = (raw, zeroMeansRated) => {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const n = parseFloat(s.replace(',', '.'))
  if (!isFinite(n) || n < 0 || (n === 0 && !zeroMeansRated)) return null
  return Math.min(10, Math.round(n * 100) / 100)
}
const LB_TO_KG = 0.45359237
const p2 = n => String(n).padStart(2, '0')
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

/** "2020-12-30 18:51:52" · "2024-03-07" · "22 Dec 2025, 08:00" · "07/03/2024" -> { d, t } */
export function parseWhen(s) {
  const v = String(s || '').trim()
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/)
  if (m) return { d: `${m[1]}-${p2(m[2])}-${p2(m[3])}`, t: hm(m[4], m[5]) }
  m = v.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2}))?/)
  if (m && MON[m[2].toLowerCase()]) return { d: `${m[3]}-${p2(MON[m[2].toLowerCase()])}-${p2(m[1])}`, t: hm(m[4], m[5]) }
  m = v.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2}))?/)
  if (m && MON[m[1].toLowerCase()]) return { d: `${m[3]}-${p2(MON[m[1].toLowerCase()])}-${p2(m[2])}`, t: hm(m[4], m[5]) }
  // Day-first when ambiguous: FitNotes/Strong/Hevy all write unambiguous dates, so a
  // bare numeric one came through a spreadsheet, and those are usually European.
  m = v.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:[, ]+(\d{1,2}):(\d{2}))?/)
  if (m) {
    const [, a, b, y] = m
    const day = +a > 12 ? a : +b > 12 ? b : a
    const mon = day === a ? b : a
    return { d: `${y}-${p2(mon)}-${p2(day)}`, t: hm(m[4], m[5]) }
  }
  return null
}
const hm = (h, mi) => (h === undefined ? null : (parseInt(h, 10) || 0) * 3600000 + (parseInt(mi, 10) || 0) * 60000)

/** "HH:MM:SS" · "MM:SS" · "90" -> minutes */
function toMinutes(v) {
  const s = String(v ?? '').trim()
  if (!s) return 0
  if (s.includes(':')) {
    const p = s.split(':').map(x => parseInt(x, 10) || 0)
    const sec = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]
    return Math.round(sec / 60 * 10) / 10
  }
  const m = s.match(/(\d+)\s*h/i), mm = s.match(/(\d+)\s*m/i)      // Strong's "2h 38m"
  if (m || mm) return (m ? +m[1] * 60 : 0) + (mm ? +mm[1] : 0)
  return Math.round(num(s) * 10) / 10
}
const KM = { m: 0.001, km: 1, cm: 0.00001, in: 0.0000254, ft: 0.0003048, yd: 0.0009144, mi: 1.609344 }
const toKm = (v, unit) => num(v) * (KM[String(unit || 'km').toLowerCase().trim()] ?? 1)

/* --------------------------------------------------------------- parse ---- */

/**
 * Read an export into workouts GymYar understands, WITHOUT touching state — the caller
 * shows the summary for confirmation first. Nothing here throws on a bad row: a history
 * of several thousand sets will contain oddities, and losing the file over one of them
 * helps nobody. Bad rows are counted and reported instead.
 */
export function parseWorkoutCSV(text, { unit = 'kg' } = {}) {
  const rows = parseCSV(text)
  if (rows.length < 2) return { error: 'empty' }
  const map = mapHeader(rows[0])
  const source = detectSource(rows[0])
  const dateCol = map.date !== undefined ? 'date' : map.startTime !== undefined ? 'startTime' : null
  if (!dateCol || map.exercise === undefined) return { error: 'unrecognised' }

  const resolved = new Map()          // exercise name -> dataset id | null, resolved once
  const byDate = new Map()
  const created = new Map()
  const unmatched = new Set()
  let sets = 0, skipped = 0, matched = 0, warmups = 0, rpeSets = 0, rirSets = 0
  let sawLb = false, sawKg = false

  const cell = (r, f) => (map[f] === undefined ? '' : String(r[map[f]] ?? '').trim())

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const name = cell(r, 'exercise')
    const when = parseWhen(cell(r, dateCol))
    if (!name || !when) { skipped++; continue }

    // explicit kg/lb columns beat a generic column plus a unit column
    let w = 0, rowUnit = ''
    if (map.weightKg !== undefined && cell(r, 'weightKg')) { w = num(cell(r, 'weightKg')); rowUnit = 'kg' }
    else if (map.weightLb !== undefined && cell(r, 'weightLb')) { w = num(cell(r, 'weightLb')); rowUnit = 'lb' }
    else {
      w = num(cell(r, 'weight'))
      const u = cell(r, 'weightUnit').toLowerCase()
      rowUnit = u.startsWith('lb') ? 'lb' : u.startsWith('kg') ? 'kg' : ''
    }
    if (rowUnit === 'lb') sawLb = true
    if (rowUnit === 'kg') sawKg = true

    const reps = Math.round(num(cell(r, 'reps')))
    const secs = num(cell(r, 'seconds'))
    const mins = secs > 0 ? Math.round(secs / 60 * 10) / 10 : toMinutes(cell(r, 'time'))
    const km = map.distanceKm !== undefined && cell(r, 'distanceKm')
      ? num(cell(r, 'distanceKm'))
      : toKm(cell(r, 'distance'), cell(r, 'distanceUnit'))
    if (!w && !reps && !mins && !km) { skipped++; continue }
    if (/warm/i.test(cell(r, 'setType'))) warmups++

    const key = keyOf(name)
    let id = resolved.get(key)
    if (id === undefined) { id = matchImportedName(name); resolved.set(key, id) }
    if (id) matched++
    else {
      let c = created.get(key)
      if (!c) {
        c = {
          id: 'im' + uid(), n: name.toLowerCase(), custom: true, eq: 'custom', tg: '', desc: '',
          bp: CATEGORY_BP[cell(r, 'category').toLowerCase()] || (km || (mins && !reps) ? 'cardio' : 'upper legs'),
        }
        created.set(key, c)
        unmatched.add(name)
      }
      id = c.id
    }

    const isCardio = (km > 0 || mins > 0) && !reps
    // `u` carries the row's own unit into the conversion pass below and is dropped there —
    // it never reaches the stored set.
    const set = isCardio
      ? { min: mins || 0, speed: mins > 0 ? Math.round(km / (mins / 60) * 10) / 10 : 0, done: true }
      : { w, r: reps || 0, done: true, u: rowUnit }
    // Effort rides along only where the app can show it again: a weighted rep set. A treadmill
    // row with an RPE would have nowhere to put it. A set is kept on one scale, so a file
    // carrying both columns is read as RIR — the same precedence setLabel reads them back with.
    if (!isCardio) {
      const rir = effortNum(cell(r, 'rir'), true)
      const rpe = rir == null ? effortNum(cell(r, 'rpe'), false) : null
      if (rir != null) { set.rir = rir; rirSets++ }
      else if (rpe != null) { set.rpe = rpe; rpeSets++ }
    }

    let day = byDate.get(when.d)
    if (!day) {
      day = { ex: new Map(), name: cell(r, 'workoutName') || '', start: when.t, end: null }
      byDate.set(when.d, day)
    }
    if (!day.name) day.name = cell(r, 'workoutName') || ''
    if (map.endTime !== undefined) { const e = parseWhen(cell(r, 'endTime')); if (e && e.t != null) day.end = e.t }
    else if (map.time !== undefined && !map.seconds && reps) { /* FitNotes' Time is per-set */ }
    if (!day.ex.has(id)) day.ex.set(id, [])
    day.ex.get(id).push(set)
    sets++
  }

  // lb -> kg only where a row disagrees with the profile. The app never converts units on
  // its own, so importing unconverted would silently rewrite someone's numbers.
  // Converting PER ROW matters: apps like FitNotes write the unit next to every set, and a
  // history recorded partly in lb and partly in kg used to be taken over as-is, turning
  // "185 lb" into 185 kg.
  const fileUnit = sawLb && !sawKg ? 'lb' : sawKg && !sawLb ? 'kg' : ''
  const mixedUnits = sawLb && sawKg
  const toKg = x => Math.round(x * LB_TO_KG * 10) / 10
  const toLb = x => Math.round(x / LB_TO_KG * 10) / 10
  // A row without its own unit follows the file's, and a file that says nothing is taken
  // to already be in the profile's unit.
  const convRow = s => {
    const u = s.u || fileUnit
    if (!u || u === unit) return s.w
    return u === 'lb' ? toKg(s.w) : toLb(s.w)
  }
  const converted = (!!fileUnit && fileUnit !== unit) || mixedUnits

  const dates = [...byDate.keys()].sort()
  const workouts = dates.map(d => {
    const day = byDate.get(d)
    const entries = [...day.ex.entries()].map(([id, ss]) => {
      const conv2 = ss.map(({ u, ...s }) => (s.w !== undefined ? { ...s, w: convRow({ ...s, u }) } : s))
      const mx = Math.max(0, ...conv2.map(s => s.w || 0))
      return { id, sets: conv2, topW: mx || null }
    })
    const base = new Date(d + 'T00:00:00').getTime()
    const start = base + (day.start ?? 18 * 3600000)
    const end = day.end != null ? base + day.end : start
    const w = {
      id: 'iw' + uid(), d, start, end: end > start ? end : start,
      routineId: null, name: day.name || 'Imported', entries, prs: [],
    }
    w.vol = entries.reduce((a, e) => a + e.sets.reduce((b, s) => b + (s.w || 0) * (s.r || 0), 0), 0)
    return w
  })

  return {
    kind: 'workouts', source, workouts, customEx: [...created.values()],
    // distinct library exercises behind the matched rows — the summary calls this
    // "exercises matched", and counting rows there made three exercises read as five
    matched: new Set([...resolved.values()].filter(Boolean)).size,
    matchedSets: matched,
    created: created.size, unmatchedNames: [...unmatched].sort(),
    sets, skipped, warmups, fileUnit, mixedUnits, converted, rpeSets, rirSets,
    from: dates[0] || null, to: dates[dates.length - 1] || null,
  }
}

/* ------------------------------------------------------- body weight ------ */

/**
 * Body-weight history from Apple Health, or any CSV with a date and a weight.
 *
 * Health's own export is one big `export.xml` — often several hundred MB, nearly all of
 * it step counts and heart rate. Building a DOM would blow up the tab, so the body-mass
 * records are pulled out with a scan instead. Health writes weights in the unit the
 * phone is set to and labels each record, so the unit is read per record.
 */
export function parseBodyweight(text, { unit = 'kg' } = {}) {
  const s = String(text)
  const out = new Map()          // iso date -> { w, t }  (one weigh-in per day, the last)
  let fileUnit = ''

  if (s.includes('HKQuantityTypeIdentifierBodyMass')) {
    const re = /<Record[^>]*type="HKQuantityTypeIdentifierBodyMass"[^>]*>/g
    let m
    while ((m = re.exec(s))) {
      const tag = m[0]
      const val = /value="([\d.]+)"/.exec(tag)
      const dt = /startDate="([^"]+)"/.exec(tag) || /creationDate="([^"]+)"/.exec(tag)
      const u = /unit="([^"]+)"/.exec(tag)
      if (!val || !dt) continue
      const when = parseWhen(dt[1])
      if (!when) continue
      if (u) fileUnit = /lb/i.test(u[1]) ? 'lb' : 'kg'
      out.set(when.d, { w: parseFloat(val[1]), t: new Date(dt[1]).getTime() || null })
    }
  } else {
    const rows = parseCSV(s)
    if (rows.length < 2) return { error: 'empty' }
    const map = mapHeader(rows[0])
    // a weight-only CSV: whichever weight column it has
    const wCol = map.weightKg ?? map.weightLb ?? map.weight
    const dCol = map.date ?? map.startTime
    if (wCol === undefined || dCol === undefined) return { error: 'unrecognised' }
    if (map.weightKg !== undefined) fileUnit = 'kg'
    else if (map.weightLb !== undefined) fileUnit = 'lb'
    for (let i = 1; i < rows.length; i++) {
      const when = parseWhen(String(rows[i][dCol] ?? ''))
      const w = num(rows[i][wCol])
      if (!when || !w) continue
      out.set(when.d, { w, t: new Date(when.d).getTime() + (when.t ?? 0) })
    }
  }

  if (!out.size) return { error: 'unrecognised' }
  const converted = !!fileUnit && fileUnit !== unit
  const conv = converted
    ? (fileUnit === 'lb' ? x => Math.round(x * LB_TO_KG * 10) / 10 : x => Math.round(x / LB_TO_KG * 10) / 10)
    : x => Math.round(x * 10) / 10
  const dates = [...out.keys()].sort()
  return {
    kind: 'bodyweight', source: 'Apple Health',
    bodyweight: dates.map(d => ({ d, w: conv(out.get(d).w), t: out.get(d).t || new Date(d).getTime() })),
    fileUnit, converted, from: dates[0], to: dates[dates.length - 1],
  }
}

/* ------------------------------------------------------- Apple Health ----- */

/**
 * The whole of an Apple Health export, not only the weights: sessions, and the heart rate
 * recorded during them.
 *
 * This is the one integration that reaches every watch at once. Apple Watch writes here,
 * and so does Zepp, Garmin, Polar, Fitbit, Whoop and Oura — the hub is the integration, and
 * a vendor is not (see docs/WEARABLES.md). It is also the only one that needs no native
 * code, no permission and no account, so it runs in the PWA and in both native builds
 * unchanged.
 *
 * ## Why two passes and not a DOM
 *
 * `export.xml` runs to hundreds of megabytes, nearly all of it step counts and heart rate.
 * `parseBodyweight` above already scans rather than parses for that reason and this keeps
 * its technique. Two passes rather than one because Apple writes every `<Record>` first and
 * every `<Workout>` last, so the spans a heart-rate sample might belong to are not known
 * until the file has been read once — and the alternative, holding every sample in memory
 * until the workouts show up, is a hundred thousand objects on a phone. Pass one takes the
 * body mass and the sessions, which are rare; pass two streams the heart rate past those
 * spans and keeps only what lands inside one, plus ten numbers per day for a resting figure.
 *
 * Bad records are skipped, never thrown on: a decade of health data contains oddities and
 * losing the file over one of them helps nobody.
 */
export function parseAppleHealth(text, { unit = 'kg', onProgress = null } = {}) {
  const s = String(text)
  // Progress is reported as a fraction of the file, not of the work: the two passes are read
  // ends-to-end, so `lastIndex` over the length is the only honest measure available and it is
  // the one the caller needs — a bar that sits at 100% while the second pass runs reads as a
  // hang exactly like no bar at all. Pass one is the first half, pass two the second; they
  // cost roughly the same because both walk the whole string.
  const say = onProgress ? (base, at) => onProgress(Math.min(1, base + (at / s.length) * 0.5)) : null
  let seen = 0
  const weights = new Map()      // iso date -> { w, t }
  let fileUnit = ''
  const spans = []               // { ms, end, ... } one per HKWorkout, sorted after pass 1

  // ---- pass 1: body mass and sessions. Both are rare, so the alternation is cheap.
  // `<Workout` needs the boundary: without it the same pattern matches `<WorkoutStatistics`
  // and `<WorkoutEvent`, which are children of a session rather than sessions, and every one
  // of them would be read as a workout with no start date.
  const p1 = /<Record[^>]*type="HKQuantityTypeIdentifierBodyMass"[^>]*>|<Workout(?=[\s>])[^>]*>/g
  let m
  while ((m = p1.exec(s))) {
    const tag = m[0]
    if (tag.startsWith('<Record')) {
      const val = attr(tag, 'value'), dt = attr(tag, 'startDate') || attr(tag, 'creationDate')
      const when = dt && appleDate(dt)
      if (!val || !when) continue
      const u = attr(tag, 'unit')
      if (u) fileUnit = /lb/i.test(u) ? 'lb' : 'kg'
      weights.set(when.d, { w: parseFloat(val), t: when.ms })
      continue
    }
    // A workout carries its distance either as attributes (older exports) or as
    // <WorkoutStatistics> children (iOS 16 and later), so the element's own body is read
    // when it has one. There are a few hundred of these in a file, not a few hundred
    // thousand, which is what makes looking inside them affordable at all.
    const inner = tag.endsWith('/>') ? '' : innerOf(s, p1.lastIndex, '</Workout>')
    const w = workoutFromHK(tag, inner)
    if (w) spans.push(w)
    // Every 16 rather than every 4096 as in pass two, because what this pass matches is rare
    // — a few hundred sessions and a few hundred weigh-ins in a file of a million records —
    // so ticking per match is free here. It also means the first half of the bar advances
    // with where those elements sit rather than smoothly: Apple writes every session at the
    // end of the file, so a profile that has never logged a weight sees this half move only
    // as it finishes. The phase label is what carries that stretch, which is why there is one.
    if (say && (++seen & 15) === 0) say(0, p1.lastIndex)
  }
  if (say) say(0.5, 0)
  spans.sort((a, b) => a.ms - b.ms)

  // ---- pass 2: heart rate, against the spans pass one found.
  //
  // `lowest` keeps each day's ten smallest readings and nothing else — see RESTING_LOWEST in
  // heartrate.js for why a count rather than a percentile. Everything outside a workout and
  // above those ten is read once and dropped, which is what keeps a decade of data from
  // having to fit in memory to be imported.
  const lowest = new Map()       // iso date -> the day's ten smallest bpm, ascending
  let hrSamples = 0
  const p2 = /<Record[^>]*type="HKQuantityTypeIdentifierHeartRate"[^>]*>/g
  while ((m = p2.exec(s))) {
    const tag = m[0]
    const bpm = Math.round(parseFloat(attr(tag, 'value')))
    const dt = attr(tag, 'startDate') || attr(tag, 'creationDate')
    if (!isFinite(bpm) || bpm < 25 || bpm > 240 || !dt) continue
    const when = appleDate(dt)
    if (!when) continue
    hrSamples++

    const span = spanAt(spans, when.ms)
    if (span) span.hr.push({ t: when.ms, bpm })

    let day = lowest.get(when.d)
    if (!day) lowest.set(when.d, day = [])
    if (day.length < RESTING_LOWEST || bpm < day[day.length - 1]) {
      let i = day.length
      while (i > 0 && day[i - 1] > bpm) i--
      day.splice(i, 0, bpm)
      if (day.length > RESTING_LOWEST) day.pop()
    }
    // Every 4096 records rather than every one: a year of watch data is ~175,000 of them, and
    // a postMessage per record costs more than the parse it is reporting on.
    if (say && (++seen & 4095) === 0) say(0.5, p2.lastIndex)
  }
  if (say) say(1, 0)

  // ---- what any of that amounts to
  const created = new Map()
  const unmatched = new Set()
  const workouts = spans.map(sp => {
    let id = sp.exId
    if (!id) {
      let c = created.get(sp.name)
      if (!c) {
        c = { id: 'im' + uid(), n: sp.name, custom: true, eq: 'custom', tg: '', desc: '', bp: 'cardio' }
        created.set(sp.name, c)
        unmatched.add(sp.name)
      }
      id = c.id
    }
    const set = { min: sp.min, speed: sp.min > 0 && sp.km > 0 ? Math.round(sp.km / (sp.min / 60) * 10) / 10 : 0, done: true }
    const w = {
      id: 'iw' + uid(), d: sp.d, start: sp.ms, end: sp.end > sp.ms ? sp.end : sp.ms,
      routineId: null, name: sp.title, entries: [{ id, sets: [set], topW: null }], prs: [], vol: 0,
    }
    // Four numbers rather than the samples they came from: that is what migration 012 gives
    // a session, and what `statemap.js` carries in both directions. The samples themselves
    // are read once and dropped — see the header of 012 for why they are not kept.
    const hr = hrStats(sp.hr)
    return hr ? { ...w, hr } : w
  })

  const dates = [...weights.keys()].sort()
  const bodyweight = dates.map(d => ({ d, w: convertWeight(weights.get(d).w, fileUnit, unit), t: weights.get(d).t }))
  const resting = [...lowest.keys()].sort()
    .map(d => ({ d, bpm: restingHr(lowest.get(d).map(bpm => ({ bpm }))) }))
    .filter(x => x.bpm != null)

  // A weights-only export is what this file used to be able to read, and it still returns the
  // shape that path expects rather than a new one the caller would have to learn.
  if (!workouts.length) {
    if (!bodyweight.length) return { error: 'unrecognised' }
    return {
      kind: 'bodyweight', source: 'Apple Health', bodyweight, fileUnit,
      converted: !!fileUnit && fileUnit !== unit, from: dates[0], to: dates[dates.length - 1],
    }
  }

  const days = workouts.map(w => w.d).sort()
  const all = [...days, ...dates].sort()
  return {
    kind: 'health', source: 'Apple Health',
    workouts, bodyweight, customEx: [...created.values()],
    matched: new Set(workouts.map(w => w.entries[0].id).filter(id => EXIDX[id])).size,
    created: created.size, unmatchedNames: [...unmatched].sort(),
    sets: workouts.length,
    fileUnit, converted: !!fileUnit && fileUnit !== unit, mixedUnits: false,
    // Heart rate is counted here and stored nowhere — see the comment on the workout above.
    hrSamples, hrWorkouts: workouts.filter(w => w.hr).length, resting,
    from: all[0] || null, to: all[all.length - 1] || null,
  }
}

// One attribute out of one tag. A tag here is at most a few hundred characters and there are
// only a handful of attributes wanted per tag, so this is a regex per lookup rather than a
// parse of the whole attribute list — the same trade the body-mass scan above already makes.
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return m ? m[1] : null
}

/** The text between here and the next `close`, or '' when there is no close tag ahead. */
function innerOf(s, from, close) {
  const end = s.indexOf(close, from)
  return end === -1 ? '' : s.slice(from, end)
}

// "2024-03-07 18:20:00 +0330" — the phone's local time, with the offset it was recorded at.
//
// Both halves are wanted and they are not the same question. The local date is what the day a
// session belongs to means to the person who trained: a 21:00 run in Tehran is that Tuesday,
// whatever UTC calls it. The epoch is what a heart-rate sample is matched to a session with,
// and getting that from the local half would put every sample three and a half hours out.
//
// Built by hand rather than handed to `new Date`, which is only specified to parse ISO 8601
// — this format is not that, and what a runtime does with it is its own business.
const APPLE_DT = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\s*([+-])(\d{2}):?(\d{2}))?/
export function appleDate(str) {
  const m = APPLE_DT.exec(String(str || '').trim())
  if (!m) return null
  const [, y, mo, da, h, mi, se, sign, oh, om] = m
  const off = sign ? (sign === '-' ? -1 : 1) * ((+oh) * 3600000 + (+om) * 60000) : 0
  return {
    d: `${y}-${mo}-${da}`,
    t: (+h) * 3600000 + (+mi) * 60000 + (+se) * 1000,
    ms: Date.UTC(+y, +mo - 1, +da, +h, +mi, +se) - off,
  }
}

// The session types the dataset has a real exercise for. Short on purpose: the rule the whole
// importer runs on is that a wrong match is silent and permanent, so a type without an
// obvious counterpart becomes a custom exercise named after itself rather than the nearest
// thing in the library. There is no plain "walk" or "outdoor cycle" in the dataset, and
// filing a walk under "walking on incline treadmill" would be inventing a treadmill.
const HK_EXERCISE = {
  running: '0685',
  jumprope: '2612',
  elliptical: '2141',
  stairclimbing: '2311',
  stairclimbingmachine: '2311',
}

/* An activity name out of either dialect.
 *
 *   "HKWorkoutActivityTypeTraditionalStrengthTraining" -> "traditional strength training"
 *   "STAIR_CLIMBING_MACHINE"                           -> "stair climbing machine"
 *
 * Apple writes camel case with a prefix; Health Connect writes upper snake. Both are read here
 * rather than in two places, because the whole reason `healthActivity` is exported is that a
 * run must land on the same exercise whichever hub it came through — and it would not if one
 * of the two spellings were normalised somewhere else and slightly differently. */
const hkActivity = type => String(type || '')
  .replace(/^HKWorkoutActivityType/, '')
  .replace(/_+/g, ' ')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .trim().toLowerCase()

/**
 * What a HealthKit activity type means here: the library exercise it is, or the name to invent
 * one under.
 *
 * Exported because two different things now speak this vocabulary — the file importer above,
 * and the endpoint the iOS shortcut POSTs to (docs/WEARABLES.md M3). They have to agree: a run
 * imported from `export.xml` and the same run pushed in by a shortcut must land on the same
 * exercise, or one person's history holds two kinds of running that never merge.
 *
 * `exerciseId` is null wherever the library has no honest match, and then `name` is what a
 * custom exercise should be called. That is the same refusal `matchImportedName` makes, for the
 * same reason: a wrong match here is silent and permanent.
 */
export function healthActivity(type) {
  const name = hkActivity(type) || 'workout'
  return {
    name,
    title: name.replace(/^./, c => c.toUpperCase()),
    exerciseId: HK_EXERCISE[name.replace(/\s/g, '')] || null
  }
}

const DIST_STAT = /<WorkoutStatistics[^>]*type="HKQuantityTypeIdentifierDistance[^"]*"[^>]*>/

/** One `<Workout>` element into the span the rest of this works from, or null. */
function workoutFromHK(tag, inner) {
  const when = appleDate(attr(tag, 'startDate'))
  if (!when) return null
  const endAt = appleDate(attr(tag, 'endDate'))

  // Apple's own `duration` excludes the time a session was paused, which is what a speed
  // should be computed against. Wall-clock from the two timestamps is the fallback.
  const durUnit = (attr(tag, 'durationUnit') || 'min').toLowerCase()
  const dur = parseFloat(attr(tag, 'duration'))
  const min = isFinite(dur) && dur > 0
    ? Math.round((durUnit === 's' || durUnit === 'sec' ? dur / 60 : durUnit === 'hr' ? dur * 60 : dur) * 10) / 10
    : endAt ? Math.round((endAt.ms - when.ms) / 60000 * 10) / 10 : 0

  let km = 0
  const dv = attr(tag, 'totalDistance')
  if (dv) km = toKm(dv, attr(tag, 'totalDistanceUnit') || 'km')
  else if (inner) {
    const st = DIST_STAT.exec(inner)
    if (st) km = toKm(attr(st[0], 'sum'), attr(st[0], 'unit') || 'km')
  }

  const act = healthActivity(attr(tag, 'workoutActivityType'))
  return {
    ms: when.ms, end: endAt ? endAt.ms : when.ms, d: when.d,
    min: min > 0 ? min : 0, km: km > 0 ? km : 0,
    exId: act.exerciseId, name: act.name, title: act.title,
    hr: [],
  }
}

/** The span containing this instant, by binary search on starts. Null outside all of them. */
function spanAt(spans, ms) {
  let lo = 0, hi = spans.length - 1, found = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (spans[mid].ms <= ms) { found = spans[mid]; lo = mid + 1 } else hi = mid - 1
  }
  return found && ms <= found.end ? found : null
}

// The same rounding and the same conversion the CSV path uses, in one place so the two
// cannot drift into disagreeing about what 185 lb is.
const convertWeight = (w, from, to) =>
  !from || from === to ? Math.round(w * 10) / 10
    : from === 'lb' ? Math.round(w * LB_TO_KG * 10) / 10 : Math.round(w / LB_TO_KG * 10) / 10

/* ------------------------------------------------------ Health Connect ---- */

/**
 * Sessions read off Health Connect, in the shape `mergeImport` already takes.
 *
 * docs/WEARABLES.md M4. On Android the hub is part of the OS from 14 onwards, so this reaches
 * Zepp, Samsung Health, Mi Fitness, Garmin Connect, Polar Flow and Fitbit without a line of
 * vendor code, an account, or a network call — it is a local system read, which is the only
 * kind the native build is allowed to make.
 *
 * The plugin hands back what Health Connect stores: seconds and metres, a type in upper snake,
 * and — the part that matters — every heart-rate sample taken inside the session. Those become
 * the same four numbers `parseAppleHealth` produces and migration 012 stores, so a run that
 * arrived through a hub, a file, or a shortcut is one row of one shape by the time anything
 * downstream sees it.
 *
 * Pure, and here rather than in the client, so it can be tested without an Android device
 * anywhere near it — which is just as well, because there is not one.
 */
export function healthConnectImport(workouts, { unit = 'kg' } = {}) {
  const created = new Map()
  const unmatched = new Set()
  const out = []

  for (const w of workouts || []) {
    const start = Date.parse(w?.startDate)
    if (!isFinite(start)) continue
    const end = Date.parse(w?.endDate)
    const act = healthActivity(w.workoutType)

    let id = act.exerciseId
    if (!id) {
      let c = created.get(act.name)
      if (!c) {
        c = { id: 'im' + uid(), n: act.name, custom: true, eq: 'custom', tg: '', desc: '', bp: 'cardio' }
        created.set(act.name, c)
        unmatched.add(act.name)
      }
      id = c.id
    }

    // Seconds and metres in, minutes and km/h out — the units the rest of the app logs cardio
    // in. `duration` is the session's own, which excludes any gap between its segments, so it
    // is preferred to the wall clock for the same reason Apple's is.
    const secs = Number(w.duration)
    const min = isFinite(secs) && secs > 0
      ? Math.round(secs / 60 * 10) / 10
      : isFinite(end) ? Math.round((end - start) / 60000 * 10) / 10 : 0
    const km = isFinite(Number(w.distance)) ? Number(w.distance) / 1000 : 0

    const set = { min, speed: min > 0 && km > 0 ? Math.round(km / (min / 60) * 10) / 10 : 0, done: true }
    const hr = hrStats((w.heartRate || []).map(h => ({ t: Date.parse(h?.timestamp), bpm: h?.bpm })))
    const d = isoLocal(start)

    const row = {
      id: 'iw' + uid(), d, start, end: isFinite(end) && end > start ? end : start,
      routineId: null, name: act.title, entries: [{ id, sets: [set], topW: null }], prs: [], vol: 0,
      // Health Connect's own id for the session. `mergeImport` dedupes on it, which is what
      // makes this safe to run every time the app opens: a session already taken is skipped by
      // its id rather than by its day, so a run in the morning and a session logged here in the
      // evening can both exist on one date.
      ext: typeof w.id === 'string' && w.id ? w.id : null
    }
    if (hr) row.hr = hr
    out.push(row)
  }

  out.sort((a, b) => a.start - b.start)
  return {
    kind: 'health', source: 'Health Connect',
    workouts: out, bodyweight: [], customEx: [...created.values()],
    matched: new Set(out.map(w => w.entries[0].id).filter(id => EXIDX[id])).size,
    created: created.size, unmatchedNames: [...unmatched].sort(),
    sets: out.length, fileUnit: '', converted: false, mixedUnits: false,
    hrSamples: (workouts || []).reduce((n, w) => n + (w.heartRate?.length || 0), 0),
    hrWorkouts: out.filter(w => w.hr).length,
    // Health Connect exposes no body-mass read through this plugin and no resting figure at
    // all, so neither is invented here — see docs/WEARABLES.md for what that costs.
    resting: [],
    from: out.length ? out[0].d : null, to: out.length ? out[out.length - 1].d : null,
  }
}

/* The local calendar day of an instant, which is the key every dated thing in the state uses.
 * A UTC day would slide the whole history by one for anyone east of London, and Tehran is
 * +03:30 — the same trap `appleDate` avoids by reading the offset out of the timestamp. */
const isoLocal = ms => {
  const dt = new Date(ms)
  return `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`
}

/** Sniff the file and parse it as whatever it is. */
export function parseImport(text, opts) {
  const s = String(text)
  if (s.includes('HKQuantityTypeIdentifier') || /^\s*</.test(s)) return parseAppleHealth(s, opts)
  const asWorkouts = parseWorkoutCSV(s, opts)
  if (!asWorkouts.error) return asWorkouts
  const asWeights = parseBodyweight(s, opts)
  return asWeights.error ? asWorkouts : asWeights
}

/* --------------------------------------------------------------- merge ---- */

/** Weigh-ins into state. A day already weighed stands — this never overwrites a number. */
function mergeBodyweight(S, rows) {
  const have = new Set(S.bodyweight.map(b => b.d))
  const fresh = rows.filter(b => !have.has(b.d))
  S.bodyweight = [...S.bodyweight, ...fresh].sort((a, b) => (a.d < b.d ? -1 : 1))
  return { added: fresh.length, skipped: rows.length - fresh.length }
}

/** A day's resting heart rate. A day that already has one keeps it, as with a weigh-in: a
 *  figure somebody measured or imported first is not overwritten by a later file. */
function mergeResting(S, rows) {
  const have = new Set((S.resting || []).map(r => r.d))
  const fresh = rows.filter(r => !have.has(r.d))
  S.resting = [...(S.resting || []), ...fresh].sort((a, b) => (a.d < b.d ? -1 : 1))
  return { added: fresh.length }
}

/** Merge into state. Existing days win — importing twice never duplicates a workout. */
export function mergeImport(S, parsed) {
  if (parsed.kind === 'bodyweight') return mergeBodyweight(S, parsed.bodyweight)
  // An Apple Health export is several things at once, and the weigh-ins in it are the same
  // records the weights-only path has always read.
  const health = parsed.kind === 'health'
  const weighIns = health && parsed.bodyweight ? mergeBodyweight(S, parsed.bodyweight).added : null
  const resting = health && parsed.resting ? mergeResting(S, parsed.resting).added : null
  const have = new Set(S.workouts.map(w => w.d))
  /* A source that gives its sessions stable ids is deduped on those instead of on the day.
   *
   * "Existing days win" is the right rule for a file somebody hands over once: it is the only
   * thing a CSV of a year's training offers, and it makes a second import of the same file
   * harmless. It is the wrong rule for a hub read every time the app opens — a run at seven and
   * a session logged here at seven in the evening are both real, and the day rule would keep
   * whichever arrived first and silently refuse the other for ever after. */
  const haveExt = new Set(S.workouts.map(w => w.ext).filter(Boolean))
  const fresh = parsed.workouts.filter(w => (w.ext ? !haveExt.has(w.ext) : !have.has(w.d)))
  const used = new Set(fresh.flatMap(w => w.entries.map(e => e.id)))
  const customs = parsed.customEx.filter(c => used.has(c.id) && !EXIDX[c.id])
  S.customEx = [...(S.customEx || []), ...customs]
  S.workouts = [...S.workouts, ...fresh].sort((a, b) => (a.d < b.d ? -1 : 1))
  // seed the weight suggestions from the newest imported set of each lift
  fresh.forEach(w => w.entries.forEach(e => {
    const mx = Math.max(0, ...e.sets.map(s => s.w || 0), e.topW || 0)
    if (mx > 0) { const cur = S.exWeights[e.id]; if (!cur || w.d >= cur.d) S.exWeights[e.id] = { w: mx, d: w.d } }
  }))
  const out = { added: fresh.length, skipped: parsed.workouts.length - fresh.length }
  if (weighIns != null) out.weighIns = weighIns
  if (resting != null) out.resting = resting
  return out
}
