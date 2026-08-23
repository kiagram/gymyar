/* Where a week begins, and everything downstream of that answer.
 *
 * This existed as a constant — Monday, hardcoded in five places that each rederived it. Iran's
 * week starts on Saturday, and the failure mode of getting it wrong is not an error: the grid
 * still renders, the streak still counts, and both are quietly shifted by two days. So these
 * pin the behaviour in both locales rather than trusting the arithmetic to read correctly.
 *
 * August 2026 as the fixture month:  Sat 22 · Sun 23 · Mon 24 · Tue 25 ... Fri 28 · Sat 29
 */
import { describe, it, expect, afterEach } from 'vitest'
import { setI18n } from './i18n-adapter.js'
import { startOfWeek, weekKey, weekdayOffset, weekdayLabels, isoOf, DAYS } from './format.js'
import { streakWeeks } from './history.js'

const startsOn = n => setI18n({ weekStartsOn: () => n })
const MONDAY = 1
const SATURDAY = 6

afterEach(() => setI18n(null))

describe('the default is what the app already did', () => {
  it('starts the week on Monday with nothing registered', () => {
    expect(isoOf(startOfWeek('2026-08-26'))).toBe('2026-08-24')
  })

  it('heads a grid Mo…Su, as the calendar was hardcoded to', () => {
    expect(weekdayLabels()).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'])
  })
})

describe('startOfWeek', () => {
  it('walks back to Monday for a Monday-start locale', () => {
    startsOn(MONDAY)
    for (const [day, expected] of [
      ['2026-08-24', '2026-08-24'],   // the Monday itself
      ['2026-08-26', '2026-08-24'],   // Wednesday
      ['2026-08-23', '2026-08-17'],   // Sunday belongs to the week that began six days earlier
      ['2026-08-22', '2026-08-17']    // Saturday, same week
    ]) expect(isoOf(startOfWeek(day))).toBe(expected)
  })

  it('walks back to Saturday for Iran', () => {
    startsOn(SATURDAY)
    for (const [day, expected] of [
      ['2026-08-22', '2026-08-22'],   // the Saturday itself
      ['2026-08-23', '2026-08-22'],   // Sunday now opens the same week, not closes the last one
      ['2026-08-26', '2026-08-22'],   // Wednesday
      ['2026-08-28', '2026-08-22'],   // Friday — the last day of an Iranian week
      ['2026-08-29', '2026-08-29']    // the next Saturday starts a new one
    ]) expect(isoOf(startOfWeek(day))).toBe(expected)
  })

  it('puts the two days that moved into different weeks in the two locales', () => {
    // This is the whole bug in one assertion: Saturday and Sunday change week when the anchor
    // moves, and nothing about a Monday-anchored grid says so.
    startsOn(MONDAY)
    const mondayWeek = weekKey('2026-08-22')
    startsOn(SATURDAY)
    expect(weekKey('2026-08-22')).not.toBe(mondayWeek)
  })

  it('accepts a calendar day, a timestamp or a Date alike', () => {
    startsOn(SATURDAY)
    const expected = '2026-08-22'
    expect(isoOf(startOfWeek('2026-08-26'))).toBe(expected)
    expect(isoOf(startOfWeek('2026-08-26T18:28:00.000Z'))).toBe(expected)
    expect(isoOf(startOfWeek(new Date(2026, 7, 26, 9, 30)))).toBe(expected)
  })

  it('does not mutate a Date it was handed', () => {
    startsOn(SATURDAY)
    const given = new Date(2026, 7, 26, 9, 30)
    startOfWeek(given)
    expect(given.getDate()).toBe(26)
  })

  it("lands on the locale's first weekday for every day of a year", () => {
    for (const start of [MONDAY, SATURDAY, 0]) {
      startsOn(start)
      const d = new Date(2026, 0, 1)
      for (let i = 0; i < 365; i++) {
        expect(startOfWeek(isoOf(d)).getDay()).toBe(start)
        d.setDate(d.getDate() + 1)
      }
    }
  })
})

describe('weekKey', () => {
  it('gives every day of one week the same key', () => {
    startsOn(SATURDAY)
    const days = ['2026-08-22', '2026-08-23', '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28']
    expect(new Set(days.map(weekKey)).size).toBe(1)
  })

  it('gives the next day a different one', () => {
    startsOn(SATURDAY)
    expect(weekKey('2026-08-29')).not.toBe(weekKey('2026-08-28'))
  })

  it('sorts chronologically, which the old year-week string did not across a year boundary', () => {
    startsOn(MONDAY)
    const keys = ['2025-12-29', '2026-01-05', '2026-01-12'].map(weekKey)
    expect([...keys].sort()).toEqual(keys)
  })
})

describe('weekdayOffset and weekdayLabels agree', () => {
  it('rotates the header to match the column a date lands in', () => {
    for (const start of [MONDAY, SATURDAY, 0]) {
      startsOn(start)
      const labels = weekdayLabels()
      // Walk a real week; the label at a date's offset must be that date's own weekday name.
      const d = startOfWeek('2026-08-26')
      for (let i = 0; i < 7; i++) {
        expect(labels[weekdayOffset(d)]).toBe(DAYS[d.getDay()])
        d.setDate(d.getDate() + 1)
      }
    }
  })

  it("starts the header on the locale's first day", () => {
    startsOn(SATURDAY)
    expect(weekdayLabels()[0]).toBe('Sa')
    expect(weekdayLabels()).toHaveLength(7)
  })
})

describe("a streak is counted in the locale's weeks", () => {
  const workoutsOn = days => ({ workouts: days.map(d => ({ d })) })

  it('counts consecutive weeks back from today', () => {
    startsOn(SATURDAY)
    const today = new Date()
    const thisWeek = isoOf(startOfWeek(today))
    const prev = startOfWeek(today); prev.setDate(prev.getDate() - 7)
    expect(streakWeeks(workoutsOn([thisWeek, isoOf(prev)]))).toBe(2)
  })

  it('breaks the streak on a week with nothing logged', () => {
    startsOn(SATURDAY)
    const today = new Date()
    const twoBack = startOfWeek(today); twoBack.setDate(twoBack.getDate() - 14)
    expect(streakWeeks(workoutsOn([isoOf(startOfWeek(today)), isoOf(twoBack)]))).toBe(1)
  })

  it('is zero with nothing logged at all', () => {
    expect(streakWeeks({ workouts: [] })).toBe(0)
  })
})
