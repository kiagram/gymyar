import { describe, it, expect } from 'vitest'
import {
  maxHrForAge, hrMax, zoneOf, hrStats, samplesIn, hrForSpan,
  zoneMinutes, restingHr, restingSeries, SAMPLE_SPAN_CAP_MS,
} from './heartrate.js'

const at = (min, bpm) => ({ t: Date.UTC(2026, 0, 10, 0, min, 0), bpm })

describe('maximum heart rate', () => {
  it('estimates from age, and not with 220 minus age', () => {
    // 211 − 0.64×30 = 191.8, against the folk formula's 190. The two only agree near 39.
    expect(maxHrForAge(30)).toBe(192)
    expect(maxHrForAge(60)).toBe(173)      // 220−age would say 160, a whole zone out
  })

  it('refuses an age it cannot mean', () => {
    expect(maxHrForAge(4)).toBeNull()
    expect(maxHrForAge('')).toBeNull()
    expect(maxHrForAge(undefined)).toBeNull()
  })

  it('prefers a measured maximum over an estimate', () => {
    expect(hrMax({ hrMax: 199, age: 30 })).toBe(199)
    expect(hrMax({ age: 30 })).toBe(192)
    // Out of the believable range, so it is treated as not set rather than as gospel
    expect(hrMax({ hrMax: 12, age: 30 })).toBe(192)
    expect(hrMax({})).toBeNull()
  })
})

describe('zones', () => {
  it('puts a reading in the zone the watch would', () => {
    const max = 200
    // A boundary belongs to the zone above it: 120 is exactly 60% of 200, and 60% is
    // where zone 2 starts. Watches draw it the same way.
    expect(zoneOf(119, max)).toBe(1)
    expect(zoneOf(120, max)).toBe(2)
    expect(zoneOf(150, max)).toBe(3)
    expect(zoneOf(170, max)).toBe(4)
    expect(zoneOf(185, max)).toBe(5)
    expect(zoneOf(240, max)).toBe(5)
  })

  it('calls anything under half of maximum zone 0, which is most of a lifting session', () => {
    expect(zoneOf(90, 200)).toBe(0)
    expect(zoneOf(100, 200)).toBe(1)
  })

  it('has no answer without a maximum', () => {
    expect(zoneOf(150, null)).toBeNull()
    expect(zoneOf(null, 200)).toBeNull()
  })
})

describe('aggregates', () => {
  it('summarises what it believes and drops what it does not', () => {
    // 0 and 255 are what a watch reads through a sleeve, and either one owns a maximum
    // or an average outright if it is let through.
    const s = hrStats([at(0, 0), at(1, 60), at(2, 80), at(3, 100), at(4, 255)])
    expect(s).toEqual({ n: 3, avg: 80, min: 60, max: 100 })
  })

  it('is null rather than zero when nothing is believable', () => {
    expect(hrStats([])).toBeNull()
    expect(hrStats([at(0, 0)])).toBeNull()
  })

  it('finds the samples inside a span without scanning the whole array', () => {
    const all = [at(0, 60), at(10, 70), at(20, 80), at(30, 90), at(40, 100)]
    const got = samplesIn(all, all[1].t, all[3].t)
    expect(got.map(s => s.bpm)).toEqual([70, 80, 90])
    expect(samplesIn(all, all[4].t + 1, all[4].t + 999)).toEqual([])
    expect(samplesIn([], 0, 1)).toEqual([])
  })

  it('labels a span with the zone its average sits in', () => {
    const all = [at(0, 40), at(10, 150), at(20, 170), at(30, 40)]
    expect(hrForSpan(all, all[1].t, all[2].t, 200)).toEqual({ n: 2, avg: 160, min: 150, max: 170, zone: 4 })
    // No maximum to compare against: the stats still stand, the zone does not appear
    expect(hrForSpan(all, all[1].t, all[2].t, null)).toEqual({ n: 2, avg: 160, min: 150, max: 170 })
    expect(hrForSpan(all, 0, 1, 200)).toBeNull()
  })
})

describe('time in zone', () => {
  it('weights each sample by the gap to the next one', () => {
    // Half a minute apart, so each of the first two stands for half a minute; the last has
    // nothing after it and stands for the cap.
    const half = t => ({ t: Date.UTC(2026, 0, 10, 0, 0, t), bpm: t === 60 ? 190 : 150 })
    const mins = zoneMinutes([half(0), half(30), half(60)], 200)
    expect(mins[3]).toBe(1)                       // 150/200 = 75% — zone 3, twice over
    expect(mins[5]).toBe(SAMPLE_SPAN_CAP_MS / 60000)
  })

  it('does not let one reading before bed count the whole night', () => {
    // Eight hours between two samples. Uncapped this would report 480 minutes in zone 0,
    // which is the entire point of the cap.
    const mins = zoneMinutes([at(0, 55), at(480, 55)], 200)
    expect(mins[0]).toBe(2)                       // one minute each, capped
  })

  it('needs a maximum to have anything to say', () => {
    expect(zoneMinutes([at(0, 150)], null)).toEqual([0, 0, 0, 0, 0, 0])
  })
})

describe('resting heart rate', () => {
  const day = bs => bs.map((b, i) => at(i, b))

  it('is the mean of the ten lowest readings of the day', () => {
    const bs = [70, 52, 51, 50, 50, 49, 48, 48, 47, 46, 45, 120, 130]
    // the ten lowest are 45..52 → mean 48.6
    expect(restingHr(day(bs))).toBe(49)
  })

  it('is not the single minimum, so one bad contact does not move it', () => {
    const good = [60, 59, 58, 57, 56, 55, 54, 53, 52, 51]
    const withArtefact = [26, ...good]
    expect(restingHr(day(good))).toBe(56)
    // The 26 displaces the 60 and moves the mean by four, where a minimum would report 26
    expect(restingHr(day(withArtefact))).toBe(52)
  })

  it('says nothing about a day with fewer than ten readings', () => {
    expect(restingHr(day([50, 51, 52]))).toBeNull()
  })

  it('keys a daily series by the local day, oldest first', () => {
    const isoOf = d => d.toISOString().slice(0, 10)
    const mk = (dayN, bs) => bs.map((b, i) => ({ t: Date.UTC(2026, 0, dayN, 3, i, 0), bpm: b }))
    const series = restingSeries([
      ...mk(11, [55, 54, 53, 52, 51, 50, 49, 48, 47, 46]),
      ...mk(10, [65, 64, 63, 62, 61, 60, 59, 58, 57, 56]),
      ...mk(12, [70, 71]),                       // too few to speak for a day
    ], isoOf)
    expect(series).toEqual([
      { d: '2026-01-10', bpm: 61 },
      { d: '2026-01-11', bpm: 51 },
    ])
  })
})
