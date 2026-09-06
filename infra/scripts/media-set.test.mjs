/* The name matcher, pinned to the two rules it is allowed to have, and the denominators the
 * coverage report measures against.
 *
 * The header of media-set.mjs says why the matching is deliberately stupid: a generous matcher
 * on this data pairs `archer push up` with `push up`, and a confidently wrong picture is worse
 * than no picture. These tests are that argument made checkable, so that the next person who
 * finds the coverage number disappointing and reaches for token-subset matching has to delete
 * a test that names the exact failure it would bring back.
 *
 * No network. `load()` is never called here; the adapters are exercised by hand through
 * `npm run media:coverage`, which is a measurement rather than a test.
 */
import { describe, it, expect } from 'vitest'
import { EXDB, EXIDX, plannerReach } from '@gymyar/domain'
import { match, measure, SOURCES } from './scripts/media-set.mjs'

const entry = (name, extra = {}) => ({ name, img: `https://x/${name.replace(/\s+/g, '_')}.png`, gif: null, ...extra })

describe('the matcher', () => {
  it('matches an identical name, ignoring case and punctuation', () => {
    const m = match([entry('Barbell Bench Press')], [EXIDX['0025']])
    expect(m.exact.map(e => e.id)).toEqual(['0025'])
    expect(m.media['0025'].img).toMatch(/Barbell_Bench_Press/)
  })

  it('matches the same words in a different order, and reports it separately', () => {
    const m = match([entry('bench press, barbell')], [EXIDX['0025']])
    expect(m.exact).toEqual([])
    expect(m.reordered.map(e => e.id)).toEqual(['0025'])
  })

  it('refuses a name that is merely contained in ours — the archer push-up problem', () => {
    const archer = EXDB.find(e => e.n === 'archer push up')
    expect(archer).toBeTruthy()
    const m = match([entry('push up')], [archer])
    expect(m.uncovered).toEqual([archer])
    expect(m.media).toEqual({})
  })

  it('refuses a name that merely contains ours — the curl-up problem', () => {
    const curlUp = EXDB.find(e => e.n === 'curl-up')
    expect(curlUp).toBeTruthy()
    const m = match([entry('palms up barbell wrist curl over a bench')], [curlUp])
    expect(m.uncovered).toEqual([curlUp])
  })

  it('lets the first of two ambiguous source names win, never the later one', () => {
    const first = entry('press bench barbell'), second = entry('barbell press bench')
    const m = match([first, second], [EXIDX['0025']])
    expect(m.media['0025'].img).toBe(first.img)
  })

  it('carries a record\'s author, licence and video into the set, and omits them when absent', () => {
    const rich = entry('barbell bench press', { by: 'someone', licence: 'CC-BY-SA 4.0', video: 'https://x/v.mov' })
    expect(match([rich], [EXIDX['0025']]).media['0025']).toEqual({
      img: rich.img, gif: null, video: 'https://x/v.mov', by: 'someone', licence: 'CC-BY-SA 4.0'
    })
    expect(Object.keys(match([entry('barbell bench press')], [EXIDX['0025']]).media['0025'])).toEqual(['img', 'gif'])
  })

  it('never puts a still frame in the animation slot', () => {
    // A source with no animation says so with `gif: null`, and the set says the same.
    expect(match([entry('barbell bench press')], [EXIDX['0025']]).media['0025'].gif).toBeNull()
  })
})

describe('the denominators', () => {
  it('measures the same source against the library and against the planner', () => {
    const reach = plannerReach()
    const r = measure(reach.picks.map(e => entry(e.n)))
    expect(r.library.n).toBe(EXDB.length)
    expect(r.picks.n).toBe(reach.picks.length)
    expect(r.candidates.n).toBe(reach.candidates.length)
    // Every pick was supplied, so the planner column is full and the library column is not.
    expect(r.picks.covered).toBe(reach.picks.length)
    expect(r.picks.uncovered).toEqual([])
    expect(r.library.covered).toBeLessThan(EXDB.length)
  })

  it('reports the uncovered planner picks by name, because that is a list a person acts on', () => {
    const r = measure([])
    expect(r.picks.uncovered.length).toBe(r.picks.n)
    expect(r.picks.uncovered.every(e => typeof e.n === 'string')).toBe(true)
  })
})

describe('the adapters', () => {
  it('each owe the same shape', () => {
    for (const src of Object.values(SOURCES)) {
      expect(typeof src.id).toBe('string')
      expect(typeof src.name).toBe('string')
      expect(src.url).toMatch(/^https:\/\//)
      expect(typeof src.licence).toBe('string')
      expect(typeof src.commercial).toBe('boolean')
      expect(typeof src.attribution).toBe('string')
      expect(typeof src.load).toBe('function')
    }
  })

  it('do not claim the photographs of unknown ownership may be sold', () => {
    // The finding recorded on the adapters: the "Unlicense" covers the JSON, not the pictures,
    // and the maintainer said so. A future edit that flips this needs a new fact, not a wish.
    expect(SOURCES['free-exercise-db'].commercial).toBe(false)
    expect(SOURCES['wrkout-exercises-json'].commercial).toBe(false)
  })
})
