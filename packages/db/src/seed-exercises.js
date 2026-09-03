/* Load the 1,324-exercise library into the exercises table.
 *
 * Media URLs are built from configurable bases and stored per row rather than derived in the
 * client. The comment that used to be here said this made replacing the © Gym visual artwork
 * "an UPDATE over this table instead of a code change", which was not true and had never been
 * true: nothing that draws a picture reads these columns. The client renders through
 * `imgSrc`/`gifSrc` against the filenames compiled into the dataset, so an UPDATE moved a
 * string in Postgres and left every screen showing exactly what it showed before.
 *
 * What makes the swap real is `media-set.js` in the domain, and the reason these rows now go
 * through `mediaUrls` is so that the column and the screen cannot disagree about which set is
 * active — one function answers both. The columns stay, because the API serves them and
 * because a hosted instance still needs to say where its artwork lives; they are simply no
 * longer where the decision is made.
 */
import { EXDB, mediaUrls, mediaSet } from '@gymyar/domain'
import { db } from './index.js'

const IMG_BASE = process.env.EXERCISE_IMG_BASE || '/img/'
const GIF_BASE = process.env.EXERCISE_GIF_BASE || '/gif/'
/** Where the artwork is being served from, for whoever needs to assert about it. */
export const MEDIA_BASES = { img: IMG_BASE, gif: GIF_BASE }
// The active set names its own attribution, so the two cannot be swapped independently and
// leave rows crediting whoever supplied the previous artwork. Still overridable, for an
// instance that licensed the same set under its own terms.
const ATTRIBUTION = process.env.EXERCISE_ATTRIBUTION || mediaSet().attribution

const BODYWEIGHT_EQUIP = new Set(['body weight', 'assisted'])
const CARDIO_PARTS = new Set(['cardio'])

export function libraryRows() {
  return EXDB.map(e => {
    const media = mediaUrls(e, MEDIA_BASES)
    return {
      id: `lib:${e.id}`,
      library_key: e.id,
      name: e.n,
      body_part: e.bp,
      target: e.tg || null,
      equipment: e.eq || null,
      secondary: e.sm || [],
      steps: e.st || [],
      is_cardio: CARDIO_PARTS.has(e.bp),
      is_bodyweight: BODYWEIGHT_EQUIP.has(e.eq),
      per_side: /each side|per side|single[- ]arm|single[- ]leg|one arm|one leg/i.test(e.n),
      /* Resolved, not built from the id. The dataset's files are named `<id>-<hash>.jpg` —
       * `0001-2gPfomN.jpg` — and the id alone names nothing, on disk or on the CDN. Deriving
       * the filename from the id put a URL in every one of these 1,324 rows that 404s, which
       * nothing noticed because no test had ever followed one.
       *
       * Null is now a legitimate value here: a media set that does not cover an exercise
       * leaves it without artwork, and a row saying so is the honest record of that. The
       * columns are nullable and the client already draws a placeholder. */
      image_url: media.img,
      animation_url: media.gif,
      attribution: ATTRIBUTION
    }
  })
}

export async function seedExercises({ log = () => {} } = {}) {
  const s = db()
  const rows = libraryRows()
  // One statement, not 1,324 round trips. Re-running updates in place so a media-base change
  // or a corrected name lands without wiping the ids that workout_sets point at.
  await s`
    insert into exercises ${s(rows, 'id', 'library_key', 'name', 'body_part', 'target',
      'equipment', 'secondary', 'steps', 'is_cardio', 'is_bodyweight', 'per_side',
      'image_url', 'animation_url', 'attribution')}
    on conflict (id) do update set
      name = excluded.name, body_part = excluded.body_part, target = excluded.target,
      equipment = excluded.equipment, secondary = excluded.secondary, steps = excluded.steps,
      is_cardio = excluded.is_cardio, is_bodyweight = excluded.is_bodyweight,
      per_side = excluded.per_side, image_url = excluded.image_url,
      animation_url = excluded.animation_url, attribution = excluded.attribution,
      updated_at = now()`
  log(`seeded ${rows.length} library exercises`)
  return rows.length
}
