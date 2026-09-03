/* Replacing the exercise artwork, which this project has claimed was easy since 001_init.sql.
 *
 * The claim was in four places — the migration, the seeder, the seeder's test and README.md —
 * and it was false in the same way in all four: `image_url` and `animation_url` are stored,
 * and nothing that draws a picture reads them. `Media.jsx` calls `imgSrc`/`gifSrc`, which
 * resolved `IMG_BASE + ex.img` against filenames compiled into the bundle. Updating the
 * columns changed a string in Postgres and nothing a person could see.
 *
 * These tests are the claim, made checkable. Each one fails against the code as it stood.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { EXIDX, EXDB, imgSrc, gifSrc, mediaUrls, setMediaSet, mediaSet, setMediaBases } from './exercises.js'
import { MEDIA_SET } from './media-set.js'

const bench = EXIDX['0025']
// Restoring both, because a set left active leaks into every later test file in the worker —
// and the symptom would be a picture missing somewhere unrelated.
afterEach(() => { setMediaSet(null); setMediaBases({ img: 'img/', gif: 'gif/' }) })

describe('with no set, the dataset answers for itself', () => {
  it('is the base and the dataset\'s own filename, as it has always been', () => {
    expect(imgSrc(bench)).toBe('img/' + bench.img)
    expect(gifSrc(bench)).toBe('gif/' + bench.gif)
  })

  it('follows the bases a build points somewhere else', () => {
    setMediaBases({ img: 'https://cdn.example/i/', gif: 'https://cdn.example/g/' })
    expect(imgSrc(bench)).toBe('https://cdn.example/i/' + bench.img)
  })

  it('has artwork for every one of the 1,324', () => {
    expect(EXDB.filter(e => !imgSrc(e) || !gifSrc(e))).toEqual([])
  })
})

describe('a replacement set', () => {
  it('is what the screen renders — the point of the whole exercise', () => {
    setMediaSet({ id: 'other', attribution: 'A', media: { '0025': { img: 'bench.png', gif: 'bench.webp' } } })
    expect(imgSrc(bench)).toBe('img/bench.png')
    expect(gifSrc(bench)).toBe('gif/bench.webp')
  })

  it('may name a whole URL, which does not ride on the base', () => {
    // Artwork hosted by whoever licensed it to us has nothing to do with our img/ directory.
    setMediaSet({ id: 'other', attribution: 'A', media: { '0025': { img: 'https://cdn.example/b.png', gif: '//cdn.example/b.gif' } } })
    expect(imgSrc(bench)).toBe('https://cdn.example/b.png')
    expect(gifSrc(bench)).toBe('//cdn.example/b.gif')
  })

  it('leaves an exercise it does not cover with no picture, rather than the old one', () => {
    /* The load-bearing assertion. A fallback to `ex.img` would make a swap look complete
     * while every uncovered exercise carried on serving the artwork the swap was performed to
     * stop serving — which is the licence exposure surviving its own remedy, invisibly. */
    setMediaSet({ id: 'other', attribution: 'A', media: { '0025': { img: 'bench.png' } } })
    expect(imgSrc(EXIDX['0001'])).toBe(null)
    expect(gifSrc(EXIDX['0001'])).toBe(null)
    // Including a half-covered entry: a still with no animation is a still and no animation.
    expect(gifSrc(bench)).toBe(null)
  })

  it('never answers for an exercise somebody wrote themselves', () => {
    // A custom row's id is its own and can collide with a library key; the set is not about it.
    setMediaSet({ id: 'other', attribution: 'A', media: { '0025': { img: 'bench.png' } } })
    expect(imgSrc({ id: '0025', n: 'My own press', custom: true })).toBe(null)
  })

  it('is put back by setting no set at all', () => {
    setMediaSet({ id: 'other', attribution: 'A', media: {} })
    expect(imgSrc(bench)).toBe(null)
    setMediaSet(null)
    expect(mediaSet().id).toBe(MEDIA_SET.id)
    expect(imgSrc(bench)).toBe('img/' + bench.img)
  })
})

describe('the seeder and the screen cannot disagree', () => {
  it('resolves against explicit bases, which is how a row is built', () => {
    // packages/db/src/seed-exercises.js calls exactly this, so `image_url` in Postgres and the
    // `src` in the DOM come out of one function. They used to come out of two.
    setMediaSet({ id: 'other', attribution: 'A', media: { '0025': { img: 'b.png', gif: 'b.gif' } } })
    expect(mediaUrls(bench, { img: '/img/', gif: '/gif/' })).toEqual({ img: '/img/b.png', gif: '/gif/b.gif' })
    expect(mediaUrls(EXIDX['0001'], { img: '/img/', gif: '/gif/' })).toEqual({ img: null, gif: null })
  })
})

describe('the set that ships', () => {
  it('says out loud that it may not be sold', () => {
    /* The exercise-media launch blocker, as a value rather than a paragraph. If this ever
     * reads true, either a licence was obtained or somebody edited the wrong line — and the
     * second one should have to walk past this test to do it. */
    expect(MEDIA_SET.commercial).toBe(false)
    expect(MEDIA_SET.attribution).toMatch(/Gym visual/)
  })
})
