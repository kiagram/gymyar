import { describe, it, expect } from 'vitest'
import { parseAppleHealth, parseImport, mergeImport, appleDate } from './import-csv.js'

// Apple's export, written the way Apple writes it: local time with the offset spelled out,
// `<Record>` elements first and `<Workout>` elements last. Tehran is +0330, which is where
// this project's users are and the offset most likely to catch a date bug.
const TZ = '+0330'
const rec = (type, value, when, unit) =>
  `<Record type="HKQuantityTypeIdentifier${type}"${unit ? ` unit="${unit}"` : ''} startDate="${when} ${TZ}" endDate="${when} ${TZ}" value="${value}"/>`
const hr = (value, when) => rec('HeartRate', value, when, 'count/min')
const bodyMass = (value, when, unit = 'kg') => rec('BodyMass', value, when, unit)
const workout = (type, start, end, attrs = '', inner = null) =>
  `<Workout workoutActivityType="HKWorkoutActivityType${type}" startDate="${start} ${TZ}" endDate="${end} ${TZ}"${attrs}` +
  (inner == null ? '/>' : `>${inner}</Workout>`)
const file = (...parts) => `<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_IR">\n${parts.join('\n')}\n</HealthData>\n`

// Ten readings a minute apart, which is the fewest that can produce a resting figure.
const restingDay = (day, from) =>
  Array.from({ length: 10 }, (_, i) => hr(from + i, `2026-01-${day} 04:${String(10 + i).padStart(2, '0')}:00`))

describe('reading an Apple Health export', () => {
  it('turns a run into a workout on the dataset run, with its speed', () => {
    const p = parseAppleHealth(file(workout(
      'Running', '2026-01-10 18:00:00', '2026-01-10 18:30:00',
      ' duration="30" durationUnit="min" totalDistance="7.5" totalDistanceUnit="km"')))
    expect(p.kind).toBe('health')
    expect(p.source).toBe('Apple Health')
    expect(p.workouts).toHaveLength(1)
    const w = p.workouts[0]
    expect(w.d).toBe('2026-01-10')
    expect(w.name).toBe('Running')
    expect(w.entries[0].id).toBe('0685')          // 'run' in the library, matched not invented
    expect(w.entries[0].sets[0]).toMatchObject({ min: 30, speed: 15, done: true })
    expect(p.created).toBe(0)
  })

  it('invents an exercise for an activity the library has no honest match for', () => {
    // There is no plain "walk" in the dataset — the nearest names are treadmills — and
    // filing an outdoor walk under a treadmill would be inventing equipment.
    const p = parseAppleHealth(file(
      workout('Walking', '2026-01-10 08:00:00', '2026-01-10 08:40:00', ' duration="40" durationUnit="min"'),
      workout('TraditionalStrengthTraining', '2026-01-11 18:00:00', '2026-01-11 19:00:00', ' duration="60" durationUnit="min"')))
    expect(p.created).toBe(2)
    expect(p.unmatchedNames).toEqual(['traditional strength training', 'walking'])
    expect(p.customEx.every(c => c.custom && c.bp === 'cardio')).toBe(true)
    expect(p.workouts.map(w => w.name)).toEqual(['Walking', 'Traditional strength training'])
  })

  it('reads a distance out of WorkoutStatistics, which is where iOS 16 puts it', () => {
    const p = parseAppleHealth(file(workout(
      'Running', '2026-01-10 18:00:00', '2026-01-10 18:30:00', ' duration="30" durationUnit="min"',
      '<MetadataEntry key="HKIndoorWorkout" value="0"/>' +
      '<WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="5" unit="km"/>' +
      '<WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="400" unit="kcal"/>')))
    expect(p.workouts[0].entries[0].sets[0].speed).toBe(10)
  })

  it('does not read a WorkoutStatistics child as a workout of its own', () => {
    const p = parseAppleHealth(file(workout(
      'Running', '2026-01-10 18:00:00', '2026-01-10 18:30:00', ' duration="30" durationUnit="min"',
      '<WorkoutEvent type="HKWorkoutEventTypePause" date="2026-01-10 18:10:00 +0330"/>' +
      '<WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="150"/>')))
    expect(p.workouts).toHaveLength(1)
  })

  it('takes the duration Apple reports over the wall clock, because it excludes pauses', () => {
    const p = parseAppleHealth(file(workout(
      'Running', '2026-01-10 18:00:00', '2026-01-10 19:00:00', ' duration="42" durationUnit="min"')))
    expect(p.workouts[0].entries[0].sets[0].min).toBe(42)
  })

  it('falls back to the wall clock when there is no duration attribute', () => {
    const p = parseAppleHealth(file(workout('Running', '2026-01-10 18:00:00', '2026-01-10 18:25:00')))
    expect(p.workouts[0].entries[0].sets[0].min).toBe(25)
  })
})

describe('the day a session belongs to', () => {
  it('is the day it was on the phone, not the day it was in UTC', () => {
    // 01:00 in Tehran is 21:30 the previous day in UTC. A session at that hour belongs to
    // the day the person who trained would call it.
    const p = parseAppleHealth(file(workout(
      'Running', '2026-01-10 01:00:00', '2026-01-10 01:30:00', ' duration="30" durationUnit="min"')))
    expect(p.workouts[0].d).toBe('2026-01-10')
    expect(new Date(p.workouts[0].start).toISOString().slice(0, 10)).toBe('2026-01-09')
  })

  it('reads the offset rather than trusting the runtime to parse Apple s format', () => {
    expect(appleDate('2026-01-10 01:00:00 +0330')).toEqual({
      d: '2026-01-10', t: 3600000, ms: Date.UTC(2026, 0, 9, 21, 30, 0),
    })
    // Negative offsets, and a colon in the offset, both occur in real exports
    expect(appleDate('2026-01-10 01:00:00 -0500').ms).toBe(Date.UTC(2026, 0, 10, 6, 0, 0))
    expect(appleDate('2026-01-10 01:00:00 +03:30').ms).toBe(Date.UTC(2026, 0, 9, 21, 30, 0))
    expect(appleDate('nonsense')).toBeNull()
  })
})

describe('heart rate', () => {
  const withHr = file(
    hr(48, '2026-01-10 12:00:00'),                       // in the day, outside any session
    hr(150, '2026-01-10 18:05:00'),
    hr(170, '2026-01-10 18:10:00'),
    hr(0, '2026-01-10 18:15:00'),                        // a watch reading through a sleeve
    hr(160, '2026-01-10 18:20:00'),
    hr(55, '2026-01-10 19:30:00'),                       // after it ended
    workout('Running', '2026-01-10 18:00:00', '2026-01-10 18:30:00', ' duration="30" durationUnit="min"'))

  it('aggregates the samples inside a session onto it', () => {
    const p = parseAppleHealth(withHr)
    expect(p.workouts[0].hr).toEqual({ n: 3, avg: 160, min: 150, max: 170 })
    expect(p.hrWorkouts).toBe(1)
  })

  it('counts every believable sample in the file, including the ones outside a session', () => {
    const p = parseAppleHealth(withHr)
    expect(p.hrSamples).toBe(5)                          // the 0 is not one of them
  })

  it('leaves a session with no readings without an hr rather than with an empty one', () => {
    const p = parseAppleHealth(file(
      hr(150, '2026-01-10 18:05:00'),
      workout('Running', '2026-01-12 18:00:00', '2026-01-12 18:30:00', ' duration="30" durationUnit="min"')))
    expect(p.workouts[0].hr).toBeUndefined()
    expect(p.hrWorkouts).toBe(0)
  })

  it('gives a resting figure per day, from the ten lowest readings of that day', () => {
    const p = parseAppleHealth(file(
      ...restingDay('10', 50),                           // 50..59 -> 54.5
      ...restingDay('11', 60),                           // 60..69 -> 64.5
      hr(180, '2026-01-11 18:00:00'),                    // a hard session does not move it
      workout('Running', '2026-01-11 18:00:00', '2026-01-11 18:30:00', ' duration="30" durationUnit="min"')))
    expect(p.resting).toEqual([
      { d: '2026-01-10', bpm: 55 },
      { d: '2026-01-11', bpm: 65 },
    ])
  })

  it('is carried into the profile with the session it belongs to', () => {
    const p = parseAppleHealth(withHr)
    const S = state()
    mergeImport(S, p)
    expect(S.workouts[0].hr).toEqual({ n: 3, avg: 160, min: 150, max: 170 })
  })
})

describe('weigh-ins in the same file', () => {
  it('reads them alongside the sessions', () => {
    const p = parseAppleHealth(file(
      bodyMass(78.4, '2026-01-10 07:30:00'),
      bodyMass(78.1, '2026-01-12 07:30:00'),
      workout('Running', '2026-01-11 18:00:00', '2026-01-11 18:30:00', ' duration="30" durationUnit="min"')))
    expect(p.bodyweight).toEqual([
      { d: '2026-01-10', w: 78.4, t: Date.UTC(2026, 0, 10, 4, 0, 0) },
      { d: '2026-01-12', w: 78.1, t: Date.UTC(2026, 0, 12, 4, 0, 0) },
    ])
    // The range covers both kinds of record, not only the sessions
    expect(p.from).toBe('2026-01-10')
    expect(p.to).toBe('2026-01-12')
  })

  it('converts pounds to the profile s unit', () => {
    const p = parseAppleHealth(file(
      bodyMass(180, '2026-01-10 07:30:00', 'lb'),
      workout('Running', '2026-01-11 18:00:00', '2026-01-11 18:30:00')), { unit: 'kg' })
    expect(p.converted).toBe(true)
    expect(p.fileUnit).toBe('lb')
    expect(p.bodyweight[0].w).toBe(81.6)
  })

  it('still returns the old shape for an export that holds nothing but weights', () => {
    // This is the file the importer could already read, and the path it took must not
    // change under it just because the parser learned to read more.
    const p = parseImport(file(bodyMass(78.4, '2026-01-10 07:30:00')), { unit: 'kg' })
    expect(p.kind).toBe('bodyweight')
    expect(p.workouts).toBeUndefined()
    expect(p.bodyweight).toHaveLength(1)
  })

  it('says it cannot read a file with none of the three in it', () => {
    expect(parseAppleHealth(file('<Record type="HKQuantityTypeIdentifierStepCount" value="812"/>')).error)
      .toBe('unrecognised')
  })
})

const state = () => ({ workouts: [], bodyweight: [], customEx: [], exWeights: {} })

describe('merging one into a profile', () => {
  const p = () => parseAppleHealth(file(
    bodyMass(78.4, '2026-01-10 07:30:00'),
    workout('Running', '2026-01-10 18:00:00', '2026-01-10 18:30:00', ' duration="30" durationUnit="min" totalDistance="7.5" totalDistanceUnit="km"'),
    workout('Walking', '2026-01-11 08:00:00', '2026-01-11 08:40:00', ' duration="40" durationUnit="min"')))

  it('takes the sessions and the weigh-ins together', () => {
    const S = state()
    const res = mergeImport(S, p())
    expect(res).toEqual({ added: 2, skipped: 0, weighIns: 1 })
    expect(S.workouts.map(w => w.d)).toEqual(['2026-01-10', '2026-01-11'])
    expect(S.bodyweight).toHaveLength(1)
    expect(S.customEx).toHaveLength(1)             // the walk; the run was in the library
  })

  it('adds nothing the second time, the way every other import does not', () => {
    const S = state()
    mergeImport(S, p())
    const again = mergeImport(S, p())
    expect(again).toEqual({ added: 0, skipped: 2, weighIns: 0 })
    expect(S.workouts).toHaveLength(2)
    expect(S.bodyweight).toHaveLength(1)
    expect(S.customEx).toHaveLength(1)
  })

  it('leaves a day that already holds a session alone', () => {
    const S = state()
    S.workouts.push({ id: 'w1', d: '2026-01-10', entries: [], prs: [] })
    const res = mergeImport(S, p())
    expect(res.added).toBe(1)
    expect(S.workouts.filter(w => w.d === '2026-01-10')).toHaveLength(1)
  })

  it('does not let a cardio session seed a weight suggestion', () => {
    const S = state()
    mergeImport(S, p())
    expect(S.exWeights).toEqual({})
  })
})
