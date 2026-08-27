import { describe, it, expect, afterEach } from 'vitest'
import { setI18n } from './i18n-adapter.js'
import {
  MAX_ACTIVE, normaliseHabit, tickIndex, isTicked, datesFor,
  weekProgress, habitStreakWeeks, currentRunDays, weekAdherence
} from './habits.js'

afterEach(() => setI18n(null))

// Monday 17 August 2026 through Sunday the 23rd is one week under the default Monday start.
const MON = '2026-08-17'
const daily = { id: 'h1', title: 'Walk', target: 7 }
const thrice = { id: 'h2', title: 'Stretch', target: 3 }

const ticksOn = (habitId, dates) => dates.map(d => ({ h: habitId, d }))

describe('what a habit is', () => {
  it('is nothing without a title', () => {
    expect(normaliseHabit({ title: '   ', target: 7 })).toBeNull()
    expect(normaliseHabit(null)).toBeNull()
  })

  it('defaults to every day, and clamps a target into a week', () => {
    expect(normaliseHabit({ title: 'Walk' }).target).toBe(7)
    expect(normaliseHabit({ title: 'Walk', target: 99 }).target).toBe(7)
    expect(normaliseHabit({ title: 'Walk', target: 0 }).target).toBe(1)
    expect(normaliseHabit({ title: 'Walk', target: '3' }).target).toBe(3)
  })

  it('reads the column name as well as the state one', () => {
    expect(normaliseHabit({ title: 'Walk', target_per_week: 4 }).target).toBe(4)
  })

  it('caps a list at something a person will actually tick', () => {
    expect(MAX_ACTIVE).toBeLessThanOrEqual(10)
  })
})

describe('a tick', () => {
  it('is looked up by habit and day together', () => {
    const idx = tickIndex([{ h: 'h1', d: MON }, { h: 'h2', d: MON }])
    expect(isTicked(idx, 'h1', MON)).toBe(true)
    expect(isTicked(idx, 'h1', '2026-08-18')).toBe(false)
  })

  it('belongs to one habit and does not leak into another', () => {
    const ticks = [...ticksOn('h1', [MON]), ...ticksOn('h2', ['2026-08-18'])]
    expect(datesFor(ticks, 'h1')).toEqual([MON])
    expect(datesFor(ticks, 'h2')).toEqual(['2026-08-18'])
  })
})

describe('how the week is going', () => {
  it('counts only the days inside the week being asked about', () => {
    const dates = ['2026-08-16', MON, '2026-08-18']   // the 16th is the previous week
    expect(weekProgress(thrice, dates, MON)).toEqual({ done: 2, target: 3, met: false, left: 1 })
  })

  it('is met when the target is reached, and does not go over', () => {
    const dates = [MON, '2026-08-18', '2026-08-19', '2026-08-20']
    expect(weekProgress(thrice, dates, MON)).toMatchObject({ done: 4, met: true, left: 0 })
  })

  it("follows the locale’s week, not a fixed Monday", () => {
    setI18n({ dateLocale: () => 'fa-IR', weekStartsOn: () => 6 })
    // Under a Saturday start, the 15th (a Saturday) and the 17th are the same week; under
    // Monday they are not.
    expect(weekProgress(thrice, ['2026-08-15', MON], MON).done).toBe(2)
    setI18n(null)
    expect(weekProgress(thrice, ['2026-08-15', MON], MON).done).toBe(1)
  })
})

describe('a streak of weeks', () => {
  const weeksBack = n => {
    const d = new Date(MON + 'T12:00:00')
    d.setDate(d.getDate() - n * 7)
    return d.toISOString().slice(0, 10)
  }

  it('counts consecutive weeks that hit the target', () => {
    const dates = [0, 1, 2].flatMap(n => {
      const start = new Date(weeksBack(n) + 'T12:00:00')
      return [0, 1, 2].map(i => {
        const d = new Date(start); d.setDate(start.getDate() + i)
        return d.toISOString().slice(0, 10)
      })
    })
    expect(habitStreakWeeks(thrice, dates, MON)).toBe(3)
  })

  it('does not punish an unfinished current week', () => {
    // Two of three done this week, three done last week: mid-week, not broken.
    const dates = [MON, '2026-08-18', weeksBack(1), '2026-08-11', '2026-08-12']
    expect(habitStreakWeeks(thrice, dates, MON)).toBe(1)
  })

  it('stops at the first finished week that missed', () => {
    const dates = [weeksBack(1), '2026-08-11', '2026-08-12']   // last week met, this week empty
    expect(habitStreakWeeks(thrice, dates, MON)).toBe(1)
    expect(habitStreakWeeks(thrice, [], MON)).toBe(0)
  })
})

describe('a run of days', () => {
  it('counts back from today for a daily habit', () => {
    expect(currentRunDays(daily, ['2026-08-15', '2026-08-16', MON], MON)).toBe(3)
  })

  it('does not break because today is not ticked yet', () => {
    // The day is not over. A counter that resets every midnight is a counter nobody trusts.
    expect(currentRunDays(daily, ['2026-08-15', '2026-08-16'], MON)).toBe(2)
  })

  it('breaks on a day that was actually missed', () => {
    expect(currentRunDays(daily, ['2026-08-14', '2026-08-16'], MON)).toBe(1)
  })

  it('says nothing at all for a habit that is not daily', () => {
    // A run of days is meaningless against a target of three — it would render as a number
    // that looks like a verdict and is not one.
    expect(currentRunDays(thrice, [MON], MON)).toBeNull()
  })
})

describe('adherence across every habit', () => {
  const habits = [daily, thrice]

  it('is measured in days asked for, not habits completed', () => {
    // Seven of seven on one habit and none of three on the other is 7/10, not 50%.
    const ticks = ticksOn('h1', ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20',
      '2026-08-21', '2026-08-22', '2026-08-23'])
    expect(weekAdherence(habits, ticks, MON)).toBeCloseTo(0.7, 5)
  })

  it('does not let one over-done habit cover for another', () => {
    const ticks = ticksOn('h2', ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21'])
    // Five ticks against a target of three counts as three, not five.
    expect(weekAdherence(habits, ticks, MON)).toBeCloseTo(0.3, 5)
  })

  it('says nothing rather than zero when there are no habits', () => {
    expect(weekAdherence([], [], MON)).toBeNull()
    expect(weekAdherence([{ ...daily, arch: true }], [], MON)).toBeNull()
  })

  it('ignores an archived habit, whose days are no longer being asked for', () => {
    const ticks = ticksOn('h2', ['2026-08-17', '2026-08-18', '2026-08-19'])
    expect(weekAdherence([{ ...daily, arch: true }, thrice], ticks, MON)).toBe(1)
  })
})
