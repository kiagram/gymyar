/* The exercise library, and the one column in it that is a promise about a file.
 *
 * `image_url` and `animation_url` are not derived by the client — they are stored, so that
 * replacing the Gym visual artwork is an UPDATE rather than a release. That makes them the
 * only rows in this project that can be wrong in a way no query notices: a URL is a string,
 * every string inserts, and the picture is simply missing on screen.
 *
 * They were wrong. The seeder built `<id>.jpg` from the exercise id, and the dataset's files
 * are named `<id>-<hash>.jpg` — so all 1,324 images and animations 404'd on every hosted
 * instance, while the mobile build was fine because the client reads `ex.img` directly. What
 * follows is the assertion that had been missing: the stored filename is the dataset's
 * filename, not something reconstructed from a neighbouring column.
 */
import { describe, it, expect } from 'vitest'
import { EXDB } from '@gymyar/domain'
import { libraryRows, MEDIA_BASES } from './seed-exercises.js'

const rows = libraryRows()
const byKey = Object.fromEntries(rows.map(r => [r.library_key, r]))
// Read rather than hardcoded: an instance pointing at replacement artwork sets these, and a
// test that assumed `/img/` would fail there for a reason that is not a bug.
const { img: IMG, gif: GIF } = MEDIA_BASES

describe('library media URLs', () => {
  it('names the file the dataset actually ships, for every row', () => {
    const wrong = EXDB.filter(e =>
      byKey[e.id]?.image_url !== `${IMG}${e.img}` ||
      byKey[e.id]?.animation_url !== `${GIF}${e.gif}`)
    // Reported as a count and one example rather than 1,324 failures.
    expect({ count: wrong.length, first: wrong[0] && byKey[wrong[0].id].image_url })
      .toEqual({ count: 0, first: undefined })
  })

  it('does not build the filename out of the id', () => {
    // The specific mistake, stated so a future refactor cannot quietly reintroduce it. No
    // exercise in the dataset is named after its bare id, so any row shaped that way is
    // derived rather than read.
    const derived = rows.filter(r => r.image_url === `${IMG}${r.library_key}.jpg`)
    expect(derived).toEqual([])
  })

  it('carries a filename for all 1,324 of them', () => {
    expect(rows).toHaveLength(EXDB.length)
    expect(rows.filter(r => r.image_url === IMG || r.animation_url === GIF ||
      /undefined/.test(r.image_url + r.animation_url))).toEqual([])
  })

  it('follows the media bases, so a replacement set is configuration', () => {
    // Both URLs are base + filename and nothing else. This is what makes swapping the
    // artwork an environment variable rather than a code change — see the module comment
    // in seed-exercises.js.
    const one = byKey[EXDB[0].id]
    expect(one.image_url).toBe(IMG + EXDB[0].img)
    expect(one.animation_url).toBe(GIF + EXDB[0].gif)
  })
})
