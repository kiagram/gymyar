/* Turning "bench 5x5 at 80, last set felt like an 8" into sets.
 *
 * Deterministic, and deliberately so. This is the fallback when no model is configured, but it
 * handles the shorthand people actually type in a gym — which is terse and regular, because they
 * are typing it between sets with one hand. A model earns its place on the messy end of the
 * range ("did five across on bench, felt heavy, about eighty kilos"), not on "bench 5x5 at 80".
 *
 * Nothing here invents an exercise. A phrase that does not match the library comes back as an
 * unresolved line the caller can show, rather than a confident guess at the wrong lift.
 */
import { EXDB, EXIDX } from './exercises.js'

/* Words people put between the numbers and the weight, which carry no meaning of their own. */
const FILLER = /\b(at|for|x|by|of|with|reps?|rep|sets?|set|kg|kgs|lb|lbs|pounds?|kilos?|left|in|the|tank|reserve|felt|like|an?|did|today|then|some|a)\b/gi

/* What people actually type, and what they mean by it.
 *
 * A general name search cannot do this: "bench" scores "bench pull-ups" over "barbell bench
 * press" on every reasonable metric, because it is a shorter name containing the word. But
 * nobody typing "bench 5x5" means bench pull-ups. These are the lifts common enough that
 * guessing wrong is worse than not guessing at all, pinned to library ids.
 *
 * Checked longest-first, so "incline bench" beats "bench".
 */
const ALIASES = {
  'incline bench': '0314', 'close grip bench': '0033', 'front squat': '0042',
  'romanian deadlift': '1459', 'sumo deadlift': '0894', 'overhead press': '1457',
  'shoulder press': '1457', 'military press': '1457', 'bench press': '0025',
  'lateral raise': '0334', 'lat pulldown': '0203', 'bent over row': '0027',
  'barbell row': '0027', 'dumbbell row': '0293', 'seated row': '0861',
  'leg press': '0739', 'leg curl': '0585', 'leg extension': '0586',
  'calf raise': '0605', 'tricep pushdown': '0201', 'triceps pushdown': '0201',
  'pushdown': '0201', 'hammer curl': '0313', 'bicep curl': '0294', 'biceps curl': '0294',
  'pull up': '0652', 'pull-up': '0652', 'pullup': '0652',
  'chin up': '1326', 'chin-up': '1326', 'chinup': '1326',
  'push up': '0662', 'push-up': '0662', 'pushup': '0662',
  'rdl': '1459', 'sldl': '1459', 'bss': '0417',
  'ohp': '1457', 'bench': '0025', 'squat': '0043', 'deadlift': '0032',
  'row': '0027', 'curl': '0294', 'dip': '0251', 'plank': '3665',
  'run': '0685', 'running': '0685', 'jog': '0685', 'treadmill': '0685',
  'bike': '2331', 'cycling': '2331', 'jump rope': '2612', 'burpee': '1160'
}
const ALIAS_KEYS = Object.keys(ALIASES).sort((a, b) => b.length - a.length)

/* Effort is said in half a dozen ways and none of them name an exercise. Stripped before the
 * name match, or "3x5 45, 2 reps left" searches the library for "left". */
const EFFORT_PHRASES = /\b(rir|rpe)\s*\d+(?:\.\d)?|\bfelt like (?:an?\s*)?\d+(?:\.\d)?|\b\d+(?:\.\d)?\s*(?:reps?\s*)?(?:left|in reserve|in the tank)/gi

/** Everything that is not part of naming the exercise. */
const stripNumbers = s => s
  .replace(EFFORT_PHRASES, ' ')
  .replace(/\d+(?:\.\d+)?\s*(?:kg|kgs|lb|lbs|kilos?|pounds?|s|sec|secs|seconds|min|mins|minutes)?/gi, ' ')
  .replace(/[×x@,.]/gi, ' ')
  .replace(FILLER, ' ')
  .replace(/\s+/g, ' ')
  .trim()

/**
 * Find the library exercise a phrase means.
 *
 * Scored rather than fuzzy-matched: every word of the phrase must appear in the name, and the
 * shortest name that satisfies that wins. "bench" finds "barbell bench press" rather than
 * "dumbbell decline bench press", and "incline bench" finds the incline one.
 */
export function matchExercise(phrase, { custom = [] } = {}) {
  const cleaned = stripNumbers(String(phrase || '')).toLowerCase()
  const words = cleaned.split(' ').filter(w => w.length > 1)
  if (!words.length) return null

  const pool = [...custom, ...EXDB]

  // Somebody's own exercise beats the library — they named it, they meant it.
  const own = pool.find(ex => ex.custom && (ex.n || '').toLowerCase() === cleaned)
  if (own) return own

  // Then the shorthand people actually use, longest phrase first.
  for (const alias of ALIAS_KEYS) {
    if (cleaned.includes(alias) && EXIDX[ALIASES[alias]]) return EXIDX[ALIASES[alias]]
  }
  let best = null
  for (const ex of pool) {
    const name = (ex.n || '').toLowerCase()
    if (!words.every(w => name.includes(w))) continue
    // Prefer the plainest match: fewest extra words, then shortest, then stable by id.
    const extra = name.split(/\s+/).length - words.length
    const key = [extra, name.length, String(ex.id)]
    if (!best || key < best.key) best = { ex, key }
  }
  return best ? best.ex : null
}

/* Each pattern reads one shape of shorthand. Order matters: the more specific ones first, so
 * "3x45s" is read as a hold rather than as three sets of forty-five reps. */
const SHAPES = [
  // 3x45s · 3 x 45 sec — a timed hold
  {
    kind: 'time',
    re: /(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)\b/i,
    read: m => ({ sets: +m[1], sec: +m[2] })
  },
  // 30 min at 12 · 30min @ 12kmh — cardio
  {
    kind: 'cardio',
    re: /(\d+(?:\.\d+)?)\s*(?:min|mins|minutes)\b(?:\s*(?:at|@)\s*(\d+(?:\.\d+)?))?/i,
    read: m => ({ sets: 1, min: +m[1], speed: m[2] ? +m[2] : 0 })
  },
  // 5x5 at 80 · 5 x 5 @ 80kg · 5x5 80 — and "100x5", which means one set of five at a hundred.
  //
  // The two readings are told apart the way a lifter tells them apart: nobody does 100 sets, and
  // a first number above 12 is a weight. Without this, "deadlift 100x5" logs a hundred sets.
  {
    kind: 'reps',
    re: /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+)\s*(?:(?:at|@)\s*)?(\d+(?:\.\d+)?)?\s*(?:kg|lb|lbs|kilos?)?/i,
    read: m => {
      const a = +m[1]; const b = +m[2]; const third = m[3] != null ? +m[3] : null
      if (third == null && a > 12 && b <= 12) return { sets: 1, reps: b, w: a }
      return { sets: a, reps: b, w: third ?? 0 }
    }
  }
]

const EFFORT = [
  { re: /\brir\s*(\d+(?:\.\d)?)/i, as: m => ({ rir: +m[1] }) },
  { re: /\brpe\s*(\d+(?:\.\d)?)/i, as: m => ({ rpe: +m[1] }) },
  { re: /\bfelt like (?:an?\s*)?(\d+(?:\.\d)?)/i, as: m => ({ rpe: +m[1] }) },
  { re: /\b(\d+(?:\.\d)?)\s*(?:reps?)?\s*(?:left|in reserve|in the tank)/i, as: m => ({ rir: +m[1] }) }
]

/**
 * Parse one or more logged exercises out of free text.
 *
 * Returns `{ entries, unresolved }`. `entries` are in the app's own workout-entry shape, so they
 * drop straight into a session. `unresolved` is every line that named something the library does
 * not have — surfaced rather than swallowed, because silently dropping a set somebody typed is
 * worse than telling them it did not land.
 */
export function parseLog(text, { custom = [], unit = 'kg' } = {}) {
  const entries = []
  const unresolved = []

  // One exercise per line, or per "and"/";" when it is all on one line.
  const lines = String(text || '')
    .split(/[\n;]+|\band\b/i)
    .map(l => l.trim())
    .filter(Boolean)

  for (const line of lines) {
    let shape = null
    for (const s of SHAPES) {
      const m = line.match(s.re)
      if (m) { shape = { kind: s.kind, matched: m[0], ...s.read(m) }; break }
    }
    if (!shape) { unresolved.push({ line, reason: 'no sets and reps in it' }); continue }

    const ex = matchExercise(line, { custom })
    if (!ex) { unresolved.push({ line, reason: 'no exercise by that name' }); continue }

    // "did 5x5 on bench at 80" puts words between the reps and the load, so the weight is not
    // adjacent to the match. Sweep the rest of the line for it rather than logging a set at zero
    // — a silently wrong weight is worse than a line that comes back unread.
    if (shape.kind === 'reps' && !shape.w) {
      const rest = line.replace(shape.matched, ' ').replace(EFFORT_PHRASES, ' ')
      const found = rest.match(/(?:at|@)\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:kg|lb|lbs|kilos?)\b/i)
      if (found) shape.w = Number(found[1] ?? found[2])
    }

    let effort = null
    for (const e of EFFORT) {
      const m = line.match(e.re)
      if (m) { effort = e.as(m); break }
    }

    const count = Math.min(20, Math.max(1, shape.sets))   // nobody logs 400 sets; a typo should not try
    const sets = Array.from({ length: count }, () => {
      const set = { done: true }
      if (shape.kind === 'time') set.sec = shape.sec
      else if (shape.kind === 'cardio') { set.min = shape.min; set.speed = shape.speed }
      else { set.w = shape.w; set.r = shape.reps }
      // Effort applies to the working sets as logged; it is a judgement about the exercise, and
      // spreading one rating across the sets is what the app does when you type it in by hand.
      return effort ? { ...set, ...effort } : set
    })

    const entry = { id: ex.id, sets }
    if (shape.kind === 'time') entry.target = { sets: count, sec: shape.sec, mode: 'time' }
    else if (shape.kind === 'cardio') entry.target = { sets: count, min: shape.min, speed: shape.speed, mode: 'cardio' }
    else entry.target = { sets: count, reps: shape.reps }
    entries.push(entry)
  }

  return { entries, unresolved, unit }
}

/** A one-line summary of what was understood, for confirming before it is saved. */
export function describeParse(result) {
  return result.entries.map(e => {
    const ex = EXIDX[e.id]?.n || e.id
    const first = e.sets[0] || {}
    if (first.sec != null) return `${ex} — ${e.sets.length} × ${first.sec}s`
    if (first.min != null) return `${ex} — ${first.min} min${first.speed ? ` @ ${first.speed}` : ''}`
    return `${ex} — ${e.sets.length} × ${first.r}${first.w ? ` @ ${first.w}` : ''}`
  })
}
