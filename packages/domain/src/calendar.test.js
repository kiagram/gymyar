/* Reading a Gregorian date in a Persian calendar.
 *
 * Every date here is the same instant in both calendars — the test is never about what is
 * stored, only about what is read. 23 August 2026 is 1 Shahrivar 1405, and the day the app
 * writes to the database is '2026-08-23' either way.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { setI18n } from './i18n-adapter.js'
import { fmtInt } from './format.js'
import {
  calendarOf, dateParts, monthKey, sameMonth, startOfMonth, daysInMonth, monthDays,
  stepMonth, monthLabel, monthYearLabel, dayNum
} from './calendar.js'

const asPersian = () => setI18n({ dateLocale: () => 'fa-IR', weekStartsOn: () => 6 })
const asEnglish = () => setI18n(null)

afterEach(() => setI18n(null))

describe('which calendar a reader is in', () => {
  it('is Persian under fa-IR and Gregorian everywhere else', () => {
    asPersian()
    expect(calendarOf()).toBe('persian')
    asEnglish()
    expect(calendarOf()).toBe('gregory')
  })
})

describe('reading a stored date', () => {
  it('reads 2026-08-23 as 1 Shahrivar 1405', () => {
    asPersian()
    expect(dateParts('2026-08-23')).toEqual({ year: 1405, month: 6, day: 1 })
  })

  it('reads the same day as August in English', () => {
    expect(dateParts('2026-08-23')).toEqual({ year: 2026, month: 8, day: 23 })
  })

  it('parses the digits back as numbers rather than as NaN', () => {
    asPersian()
    // fa-IR formats 1405 as '۱۴۰۵'. Anything that does not force Latin digits for its own
    // arithmetic gets NaN here, and NaN compares false against every month there is.
    const { year, month, day } = dateParts('2026-08-23')
    for (const n of [year, month, day]) expect(Number.isNaN(n)).toBe(false)
  })

  it('survives a full timestamp and a Date, like the other date helpers', () => {
    asPersian()
    expect(dateParts('2026-08-23T18:28:00.000Z').month).toBe(6)
    expect(dateParts(new Date('2026-08-23T12:00:00')).month).toBe(6)
  })
})

describe('the month a day belongs to', () => {
  it('puts the two sides of a Gregorian month boundary in one Persian month', () => {
    asPersian()
    // 31 August and 1 September are both Shahrivar. The old `slice(0, 7)` split them.
    expect(sameMonth('2026-08-31', '2026-09-01')).toBe(true)
    expect(monthKey('2026-08-31')).toBe('1405-06')
  })

  it('splits a single Gregorian month where the Persian one ends', () => {
    asPersian()
    // 22 September is the last of Shahrivar; the 23rd is Mehr.
    expect(sameMonth('2026-09-22', '2026-09-23')).toBe(false)
  })

  it('is the Gregorian month again in English', () => {
    expect(sameMonth('2026-08-31', '2026-09-01')).toBe(false)
    expect(monthKey('2026-08-31')).toBe('2026-08')
  })
})

describe('laying out a month grid', () => {
  it('finds the first of the Persian month', () => {
    asPersian()
    // 10 Shahrivar 1405 is 1 September 2026; its month starts on 23 August.
    expect(startOfMonth('2026-09-01').toISOString().slice(0, 10)).toBe('2026-08-23')
    expect(dateParts(startOfMonth('2026-09-01')).day).toBe(1)
  })

  it('counts 31 days in the first six months and 30 in the next five', () => {
    asPersian()
    expect(daysInMonth('2026-08-23')).toBe(31)   // Shahrivar
    expect(daysInMonth('2026-12-21')).toBe(30)   // Azar
  })

  it('counts the leap year that gives Esfand a thirtieth day', () => {
    asPersian()
    // 1403 is a leap year: 20 March 2025 is 30 Esfand 1403, a day 1404 does not have.
    expect(daysInMonth('2025-03-01')).toBe(30)
    expect(daysInMonth('2026-03-01')).toBe(29)
  })

  it('counts February the same way in English', () => {
    expect(daysInMonth('2026-02-10')).toBe(28)
    expect(daysInMonth('2024-02-10')).toBe(29)
  })

  it('steps to the next month and back to the same one', () => {
    asPersian()
    const shahrivar = startOfMonth('2026-09-01')
    const mehr = stepMonth(shahrivar, 1)
    expect(dateParts(mehr)).toMatchObject({ month: 7, day: 1 })
    expect(stepMonth(mehr, -1).getTime()).toBe(shahrivar.getTime())
  })

  it('steps across the new year without arithmetic of its own', () => {
    asPersian()
    // Esfand → Farvardin is a year boundary, and 1 Farvardin is Nowruz.
    const esfand = startOfMonth('2026-03-10')
    expect(dateParts(esfand).month).toBe(12)
    expect(dateParts(stepMonth(esfand, 1))).toMatchObject({ year: 1405, month: 1, day: 1 })
  })
})

describe('what a person reads', () => {
  it('names the Persian month', () => {
    asPersian()
    expect(monthLabel('2026-08-23')).toBe('شهریور')
  })

  it('writes the month before the year, which ICU does not', () => {
    asPersian()
    // Intl's own fa pattern for month+year is '۱۴۰۵ شهریور'. Nobody writes it that way.
    expect(monthYearLabel('2026-08-23')).toBe('شهریور ۱۴۰۵')
  })

  it('gives a year Persian digits and no thousands separator', () => {
    asPersian()
    expect(fmtInt(1405)).toBe('۱۴۰۵')
    expect(dayNum('2026-08-23')).toBe('۱')
  })

  it('is plain Latin digits in English', () => {
    expect(fmtInt(1405)).toBe('1405')
    expect(monthLabel('2026-08-23')).toBe('August')
  })

  it('answers a Gregorian locale from the app\'s own translations, not from Intl', () => {
    // Intl's en-GB short month is 'Sept'; this app's table says 'Sep', and twelve languages
    // are translated against that table. Fixing Persian must not restyle any of them.
    setI18n({ dateLocale: () => 'en-GB' })
    expect(monthLabel('2026-09-15', { long: false })).toBe('Sep')
    expect(monthYearLabel('2026-09-15')).toBe('September 2026')
  })
})

describe('the cells of a month grid', () => {
  it('hands back every day of the Persian month, in order', () => {
    asPersian()
    const days = monthDays('2026-09-01')
    expect(days).toHaveLength(31)
    expect(days[0].toISOString().slice(0, 10)).toBe('2026-08-23')
    expect(dateParts(days[30])).toMatchObject({ month: 6, day: 31 })
  })

  it('spans exactly one month, with no day repeated or skipped', () => {
    asPersian()
    const days = monthDays('2026-12-15')
    const months = new Set(days.map(d => dateParts(d).month))
    expect(months.size).toBe(1)
    expect(new Set(days.map(d => +d)).size).toBe(days.length)
  })
})
