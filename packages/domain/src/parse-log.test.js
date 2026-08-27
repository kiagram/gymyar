import { describe, it, expect } from 'vitest'
import { parseLog, matchExercise, describeParse } from './parse-log.js'
import * as domain from './index.js'
import { EXIDX } from './exercises.js'

const one = text => parseLog(text).entries[0]
const name = entry => EXIDX[entry.id]?.n

describe('naming a lift', () => {
  it('reads the shorthand people actually type', () => {
    expect(matchExercise('bench').n).toBe('barbell bench press')
    expect(matchExercise('squat').n).toBe('barbell full squat')
    expect(matchExercise('deadlift').n).toBe('barbell deadlift')
    expect(matchExercise('ohp').n).toBe('barbell standing wide military press')
    expect(matchExercise('rdl').n).toBe('dumbbell romanian deadlift')
  })

  it('does not let a shorter name win over the obvious one', () => {
    // "bench pull-ups" is a real library entry, shorter than "barbell bench press" and
    // containing the word — a plain name search picks it every time, and it is never what
    // somebody typing "bench 5x5" meant
    expect(matchExercise('bench').n).not.toMatch(/pull/i)
  })

  it('lets a longer phrase beat a shorter one', () => {
    expect(matchExercise('incline bench').n).toMatch(/incline/i)
    expect(matchExercise('front squat').n).toMatch(/front squat/i)
  })

  it('prefers a person\'s own exercise over the library', () => {
    const custom = [{ id: 'c1', n: 'Sled push', custom: true }]
    expect(matchExercise('sled push', { custom }).id).toBe('c1')
  })

  it('returns nothing for something that is not an exercise', () => {
    expect(matchExercise('flurbulator')).toBeNull()
    expect(matchExercise('')).toBeNull()
    expect(matchExercise('   ')).toBeNull()
  })
})

describe('reading sets', () => {
  it('reads the common shape', () => {
    const e = one('bench 5x5 at 80')
    expect(name(e)).toBe('barbell bench press')
    expect(e.sets).toHaveLength(5)
    expect(e.sets[0]).toMatchObject({ w: 80, r: 5, done: true })
  })

  it('reads a weight written before the reps', () => {
    // "deadlift 100x5" is one set of five at a hundred — not a hundred sets
    const e = one('deadlift 100x5')
    expect(e.sets).toHaveLength(1)
    expect(e.sets[0]).toMatchObject({ w: 100, r: 5 })
  })

  it('still reads 5x5 as five sets', () => {
    expect(one('squat 5x5 100').sets).toHaveLength(5)
  })

  it('finds a weight that is not next to the reps', () => {
    expect(one('did 5x5 on bench at 80 today').sets[0].w).toBe(80)
  })

  it('reads a hold as seconds, not reps', () => {
    const e = one('plank 3x45s')
    expect(e.sets[0]).toMatchObject({ sec: 45 })
    expect(e.sets[0].r).toBeUndefined()
    expect(e.target.mode).toBe('time')
  })

  it('reads cardio as duration and speed', () => {
    const e = one('run 30 min at 12')
    expect(e.sets[0]).toMatchObject({ min: 30, speed: 12 })
    expect(e.target.mode).toBe('cardio')
  })

  it('reads a decimal weight', () => {
    expect(one('bench 3x5 @ 82.5 kg').sets[0].w).toBe(82.5)
  })

  it('carries effort through, in the scale it was given', () => {
    expect(one('bench 5x5 80 rpe 8').sets[0]).toMatchObject({ rpe: 8 })
    expect(one('bench 5x5 80 rir 2').sets[0]).toMatchObject({ rir: 2 })
    expect(one('bench 5x5 80, 2 reps left').sets[0]).toMatchObject({ rir: 2 })
    expect(one('bench 5x5 80, felt like an 8').sets[0]).toMatchObject({ rpe: 8 })
  })

  it('does not invent effort that was not given', () => {
    const set = one('bench 5x5 80').sets[0]
    expect(set.rir).toBeUndefined()
    expect(set.rpe).toBeUndefined()
  })

  it('reads several exercises at once', () => {
    const r = parseLog('bench 4x8 60\nbarbell curl 3x12 25')
    expect(r.entries).toHaveLength(2)
    expect(name(r.entries[0])).toMatch(/bench/i)
    expect(name(r.entries[1])).toMatch(/curl/i)
  })

  it('splits on "and" as well as on lines', () => {
    expect(parseLog('squat 5x5 100 and bench 5x5 80').entries).toHaveLength(2)
  })
})

describe('refusing to guess', () => {
  it('never invents an exercise', () => {
    const r = parseLog('flurbulator 5x5 at 80')
    expect(r.entries).toHaveLength(0)
    expect(r.unresolved[0].reason).toMatch(/no exercise/i)
  })

  it('says so when there are no numbers in it', () => {
    const r = parseLog('had a good session today')
    expect(r.entries).toHaveLength(0)
    expect(r.unresolved[0].reason).toMatch(/no sets/i)
  })

  it('keeps the good lines when one is bad', () => {
    const r = parseLog('bench 5x5 80\nflurbulator 3x10')
    expect(r.entries).toHaveLength(1)
    expect(r.unresolved).toHaveLength(1)
  })

  it('only ever returns ids that exist', () => {
    for (const text of ['bench 5x5 80', 'squat 3x8 100', 'plank 3x45s', 'run 20 min at 10']) {
      for (const e of parseLog(text).entries) expect(EXIDX[e.id]).toBeTruthy()
    }
  })

  it('refuses to log a typo as four hundred sets', () => {
    expect(one('bench 400x5 at 80').sets.length).toBeLessThanOrEqual(20)
  })

  it('survives junk without throwing', () => {
    for (const text of ['', null, undefined, '5x5', '@@@@', '\n\n\n']) {
      expect(() => parseLog(text)).not.toThrow()
    }
  })
})

describe('showing what was understood', () => {
  it('describes each entry in one line', () => {
    const r = parseLog('bench 5x5 80\nplank 3x40s')
    expect(describeParse(r)).toEqual([
      'barbell bench press — 5 × 5 @ 80',
      'power point plank — 3 × 40s'
    ])
  })
})

/* The package root is what everything outside the domain imports from, and a star export with
 * two of the same name resolves to neither. This one was `undefined` there for a while — the
 * build said so in a NAMESPACE_CONFLICT line nobody reads, and nothing failed because the only
 * caller imported straight from the file. */
describe('reaching it from the package root', () => {
  it("is exported, and is the parser’s matcher rather than the importer’s", () => {
    expect(typeof domain.matchExercise).toBe('function')
    expect(domain.matchExercise('bench').n).toBe('barbell bench press')
  })

  it("does not collide with the importer’s, which answers a different question", () => {
    // A phrase somebody typed against a name from somebody else's export — same input, and
    // deliberately different rules about when to guess.
    expect(typeof domain.matchImportedName).toBe('function')
    expect(domain.matchImportedName).not.toBe(domain.matchExercise)
  })
})
