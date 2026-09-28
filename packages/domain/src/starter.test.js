import { describe, it, expect } from 'vitest'
import { kiaSplitRoutines, starterRoutines } from './starter.js'
import { EXIDX, isCardio } from './exercises.js'
import { supersetUnits } from './history.js'

describe("Kia's 3-day split", () => {
  const rs = kiaSplitRoutines()

  it('has three named days', () => {
    expect(rs.map(r => r.name)).toEqual(['Back + Triceps', 'Chest + Biceps', 'Shoulders + Legs'])
  })

  it('uses only exercises that exist in the catalog', () => {
    rs.forEach(r => r.ex.forEach(e => expect(EXIDX[e.id], e.id).toBeTruthy()))
  })

  it('opens with 10 min of bike and ends with 20 min of treadmill', () => {
    rs.forEach(r => {
      const first = r.ex[0], last = r.ex[r.ex.length - 1]
      expect(isCardio(first.id)).toBe(true)
      expect(first.min).toBe(10)
      expect(isCardio(last.id)).toBe(true)
      expect(last.min).toBe(20)
    })
  })

  it('prescribes 3 sets of every lift', () => {
    rs.forEach(r => r.ex.filter(e => !isCardio(e.id)).forEach(e => {
      expect(e.sets).toBe(3)
      expect(e.reps).toBeGreaterThan(0)
    }))
  })

  it('matches the lift counts of the written plan', () => {
    const lifts = rs.map(r => r.ex.filter(e => !isCardio(e.id)).length)
    expect(lifts).toEqual([13, 14, 12])
  })

  it('links supersets as adjacent pairs', () => {
    const pairs = rs.map(r => supersetUnits(r.ex).filter(u => u.length > 1).length)
    expect(pairs).toEqual([1, 4, 2])
    rs.forEach(r => supersetUnits(r.ex).forEach(u => expect(u.length).toBeLessThanOrEqual(2)))
  })

  it('gives each load fresh routine and superset ids', () => {
    const again = kiaSplitRoutines()
    expect(again[0].id).not.toBe(rs[0].id)
    const sg = r => r.ex.find(e => e.sg).sg
    expect(sg(again[1])).not.toBe(sg(rs[1]))
  })

  it('leaves the PPL starter alone', () => {
    expect(starterRoutines().map(r => r.name)).toEqual(['Push Day', 'Pull Day', 'Leg Day'])
  })
})
