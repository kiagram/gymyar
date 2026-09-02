// Heart rate as a statistic: samples in, one number or five buckets out.
//
// Every source we will ever read hands us the same thing — a time and a bpm — whether it
// came out of Apple Health's `export.xml`, off Health Connect, or over a Bluetooth
// characteristic during a working set. So this module knows nothing about where a sample
// came from, and the three importers do not each grow their own copy of the zone maths.
//
// Nothing here stores anything. A sample is `{ t, bpm }` with `t` in epoch milliseconds,
// which is the shape a workout already dates itself in.

/**
 * Maximum heart rate from age, when the profile has not measured its own.
 *
 * 211 − 0.64 × age, not the 220 − age everybody quotes. The famous one was never a study:
 * it is a line drawn through other people's data in 1970 and it runs high for anyone under
 * about 40 and low for anyone over about 55, which is exactly the range where a zone that
 * is one bucket wrong changes what somebody does in a session. This one is from a measured
 * cohort (Nes et al., 2013) and is the same shape of estimate, just a better fit.
 *
 * It is still an estimate: the spread around it is roughly ±10 bpm either way, which is
 * most of a zone. Anyone who has actually seen their own maximum should set it, and
 * `hrMax` prefers that over this.
 */
export const maxHrForAge = age => {
  const a = Number(age)
  if (!isFinite(a) || a < 10 || a > 100) return null
  return Math.round(211 - 0.64 * a)
}

/** The profile's own measured maximum, else one estimated from its age, else null. */
export function hrMax(S) {
  const m = Number(S && S.hrMax)
  if (isFinite(m) && m >= 120 && m <= 230) return Math.round(m)
  return maxHrForAge(S && S.age)
}

/**
 * The five zones, as fractions of maximum heart rate.
 *
 * The boundaries are the ordinary 50/60/70/80/90% ones. There is no authority to appeal to
 * here — every vendor draws them slightly differently and each is defensible — so the
 * argument for these is that they are what a Garmin, a Polar and an Apple Watch all show,
 * and a number that disagrees with the watch it came off is a number the user does not
 * believe.
 *
 * `key` rather than a translated name: this file is runtime-agnostic and the client owns
 * what a zone is called in Persian.
 */
export const ZONES = [
  { z: 1, key: 'z1', from: 0.50, to: 0.60 },
  { z: 2, key: 'z2', from: 0.60, to: 0.70 },
  { z: 3, key: 'z3', from: 0.70, to: 0.80 },
  { z: 4, key: 'z4', from: 0.80, to: 0.90 },
  { z: 5, key: 'z5', from: 0.90, to: Infinity },
]

/**
 * Which zone a reading falls in, or 0 for anything under the bottom of zone 1.
 *
 * 0 is a real answer and not a missing one: most of a lifting session is spent below 50% of
 * maximum — that is what resting between sets is — and folding it into zone 1 would make
 * every session look like an hour of easy cardio.
 */
export function zoneOf(bpm, max) {
  // Not `Number(bpm)` on its own: Number(null) and Number('') are both 0, and 0 is under the
  // floor of zone 1, so a missing reading would come back as the real answer "resting"
  // rather than as no answer at all.
  const b = bpm == null || bpm === '' ? NaN : Number(bpm)
  const m = max == null || max === '' ? NaN : Number(max)
  if (!isFinite(b) || !isFinite(m) || m <= 0) return null
  const pct = b / m
  if (pct < ZONES[0].from) return 0
  for (const z of ZONES) if (pct < z.to) return z.z
  return 5
}

// A bpm we will believe. Health exports carry occasional garbage — a watch reading through a
// sleeve, a strap making contact for the first time — and one 0 or one 255 moves an average
// and owns a maximum outright. The window is wide enough to keep a genuine resting 33 from a
// trained heart and a genuine 210 from a sprint.
const ok = b => isFinite(b) && b >= 25 && b <= 240

/** Count, mean, floor and ceiling of a set of samples. Null when nothing is believable. */
export function hrStats(samples) {
  let n = 0, sum = 0, min = Infinity, max = -Infinity
  for (const s of samples || []) {
    const b = Number(s && s.bpm)
    if (!ok(b)) continue
    n++; sum += b
    if (b < min) min = b
    if (b > max) max = b
  }
  return n ? { n, avg: Math.round(sum / n), min: Math.round(min), max: Math.round(max) } : null
}

/**
 * The samples inside a time span, by binary search on a sorted array.
 *
 * Sorted is a precondition rather than something checked, because the callers are the
 * importers and they sort once for a whole file. A year of Apple Watch heart rate is on the
 * order of a hundred thousand samples and a few hundred workouts; scanning the array per
 * workout is the difference between an import that finishes and one that appears to hang.
 */
export function samplesIn(samples, from, to) {
  const a = samples || []
  if (!a.length || !(to >= from)) return []
  let lo = 0, hi = a.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid].t < from) lo = mid + 1; else hi = mid }
  const out = []
  for (let i = lo; i < a.length && a[i].t <= to; i++) out.push(a[i])
  return out
}

/** What a span's heart rate amounted to: the stats, plus the zone the average sat in. */
export function hrForSpan(samples, from, to, max) {
  const st = hrStats(samplesIn(samples, from, to))
  if (!st) return null
  return max ? { ...st, zone: zoneOf(st.avg, max) } : st
}

// How long one sample is allowed to speak for. Apple writes a reading every few seconds
// during a workout and then one every few minutes for the rest of the day, so weighting each
// sample by the gap to the next one — which is the only way to get minutes out of samples —
// would otherwise let a single reading before bed count the whole night as zone 1.
export const SAMPLE_SPAN_CAP_MS = 60000

/**
 * Minutes spent in each zone, from samples alone.
 *
 * Every sample stands for the interval between it and the next one, capped. That is an
 * approximation and it is the honest one available: the alternative is to assume a fixed
 * sampling rate, which is wrong on every device in a different direction and wrong on the
 * same device between a workout and the rest of the day.
 *
 * Index 0 is the time below zone 1 and is returned rather than dropped — for a lifting
 * session it is most of the hour, and a chart that hides it claims the session was harder
 * than it was.
 */
export function zoneMinutes(samples, max, { cap = SAMPLE_SPAN_CAP_MS } = {}) {
  const mins = [0, 0, 0, 0, 0, 0]
  const a = (samples || []).filter(s => ok(Number(s && s.bpm)))
  if (!a.length || !max) return mins
  for (let i = 0; i < a.length; i++) {
    const next = a[i + 1]
    const span = next ? Math.min(Math.max(0, next.t - a[i].t), cap) : cap
    const z = zoneOf(a[i].bpm, max)
    if (z != null) mins[z] += span / 60000
  }
  return mins.map(m => Math.round(m * 10) / 10)
}

// How many of a day's lowest readings a resting figure is the mean of.
//
// A count and not a percentile, which is the one design decision in this file that is made
// for the importer rather than for the statistic. A percentile cannot be computed without
// holding a whole day of samples, and holding a whole day of samples for a year of Apple
// Watch data is hundreds of thousands of objects in a phone browser; the lowest ten can be
// kept in ten numbers per day as the file streams past. It is also steadier than the single
// minimum, which measures one artefact — the reading taken as the watch lost contact, or the
// one at the bottom of a breath — where the mean of ten moves with fitness and not with a
// strap slipping.
export const RESTING_LOWEST = 10

/** Resting heart rate for a day: the mean of its ten lowest readings, or null under ten. */
export function restingHr(samples, { lowest = RESTING_LOWEST } = {}) {
  const bs = (samples || []).map(s => Number(s && s.bpm)).filter(ok).sort((a, b) => a - b)
  if (bs.length < lowest) return null
  let sum = 0
  for (let i = 0; i < lowest; i++) sum += bs[i]
  return Math.round(sum / lowest)
}

/**
 * A daily resting series, oldest first, for the chart body weight already has one of.
 *
 * Keyed by the local ISO date of each sample, which is how every other dated thing in the
 * state is keyed — a UTC day would slide the whole series by one for anyone east of London,
 * and Tehran is +3:30.
 */
export function restingSeries(samples, isoOf) {
  const byDay = new Map()
  for (const s of samples || []) {
    if (!ok(Number(s && s.bpm))) continue
    const d = isoOf(new Date(s.t))
    let a = byDay.get(d)
    if (!a) byDay.set(d, a = [])
    a.push(s)
  }
  return [...byDay.keys()].sort().map(d => ({ d, bpm: restingHr(byDay.get(d)) }))
    .filter(x => x.bpm != null)
}
