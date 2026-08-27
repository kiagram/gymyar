import { describe, it, expect } from 'vitest'
import { MAX_ACTIVE } from '@gymyar/domain'
import {
  activeHabits, hasRoom, toggledTicks, isTickedOn, addHabit, archiveHabit, removeHabit
} from './habits.js'

const state = () => ({
  habits: [
    { id: 'h1', title: 'Walk', target: 7, arch: null },
    { id: 'h2', title: 'Stretch', target: 3, arch: '2026-01-01T00:00:00.000Z' }
  ],
  habitTicks: [{ h: 'h1', d: '2026-08-24' }, { h: 'h2', d: '2026-08-24' }]
})

describe('which habits are being asked about', () => {
  it('leaves out the archived ones', () => {
    expect(activeHabits(state()).map(h => h.id)).toEqual(['h1'])
  })

  it('counts only the active ones against the cap', () => {
    const S = { habits: Array.from({ length: MAX_ACTIVE }, (_, i) => ({ id: 'h' + i, title: 'x' })) }
    expect(hasRoom(S)).toBe(false)
    S.habits[0].arch = '2026-01-01T00:00:00.000Z'
    expect(hasRoom(S)).toBe(true)
  })
})

describe('ticking', () => {
  it('adds a day that was not there', () => {
    const out = toggledTicks([], 'h1', '2026-08-25')
    expect(out).toEqual([{ h: 'h1', d: '2026-08-25' }])
  })

  it('removes one that was', () => {
    const S = state()
    expect(toggledTicks(S.habitTicks, 'h1', '2026-08-24')).toEqual([{ h: 'h2', d: '2026-08-24' }])
  })

  it('touches only the habit it names, on the day it names', () => {
    const S = state()
    const out = toggledTicks(S.habitTicks, 'h1', '2026-08-25')
    expect(out).toHaveLength(3)
    expect(isTickedOn({ habitTicks: out }, 'h2', '2026-08-24')).toBe(true)
  })

  it('does not mutate what it was given', () => {
    const S = state()
    toggledTicks(S.habitTicks, 'h1', '2026-08-24')
    expect(S.habitTicks).toHaveLength(2)
  })
})

describe('adding one', () => {
  it('returns the id it created and puts it on the list', () => {
    const S = { habits: [] }
    const id = addHabit(S, { title: '  Walk 10k  ', target: 5 })
    expect(id).toBeTruthy()
    expect(S.habits[0]).toMatchObject({ id, title: 'Walk 10k', target: 5 })
    // Nobody assigned it, which is what tells it apart from one a coach proposed.
    expect(S.habits[0].by).toBeNull()
  })

  it('refuses a blank title, and says so by returning null', () => {
    const S = { habits: [] }
    expect(addHabit(S, { title: '   ' })).toBeNull()
    expect(S.habits).toHaveLength(0)
  })

  it('refuses once the list is full', () => {
    const S = { habits: Array.from({ length: MAX_ACTIVE }, (_, i) => ({ id: 'h' + i, title: 'x' })) }
    expect(addHabit(S, { title: 'One more' })).toBeNull()
    expect(S.habits).toHaveLength(MAX_ACTIVE)
  })

  it('clamps a target into a week, like everywhere else', () => {
    const S = { habits: [] }
    addHabit(S, { title: 'Walk', target: 99 })
    expect(S.habits[0].target).toBe(7)
  })
})

describe('retiring one', () => {
  it('archives it and keeps every tick', () => {
    const S = state()
    archiveHabit(S, 'h1')
    expect(S.habits.find(h => h.id === 'h1').arch).toBeTruthy()
    expect(S.habitTicks).toHaveLength(2)
    expect(activeHabits(S)).toHaveLength(0)
  })

  it('deletes it and its ticks when that is what was asked', () => {
    const S = state()
    removeHabit(S, 'h1')
    expect(S.habits.map(h => h.id)).toEqual(['h2'])
    expect(S.habitTicks).toEqual([{ h: 'h2', d: '2026-08-24' }])
  })
})
