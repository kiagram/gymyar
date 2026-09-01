/* Load the 1,324-exercise library into the exercises table.
 *
 * Media URLs are built from configurable bases and stored per row rather than derived in the
 * client. That is deliberate: the animations are © Gym visual and licensed separately from this
 * code, so the day that licence changes — or a replacement set arrives — swapping them is an
 * UPDATE over this table instead of a code change shipped to three app stores.
 */
import { EXDB } from '@gymyar/domain'
import { db, logChange } from './index.js'

const IMG_BASE = process.env.EXERCISE_IMG_BASE || '/img/'
const GIF_BASE = process.env.EXERCISE_GIF_BASE || '/gif/'
/** Where the artwork is being served from, for whoever needs to assert about it. */
export const MEDIA_BASES = { img: IMG_BASE, gif: GIF_BASE }
const ATTRIBUTION = process.env.EXERCISE_ATTRIBUTION || '© Gym visual — https://gymvisual.com/'

const BODYWEIGHT_EQUIP = new Set(['body weight', 'assisted'])
const CARDIO_PARTS = new Set(['cardio'])

export function libraryRows() {
  return EXDB.map(e => ({
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
    /* `e.img` and `e.gif`, not `${e.id}.jpg`. The dataset's files are named `<id>-<hash>.jpg`
     * — `0001-2gPfomN.jpg` — and the id alone names nothing, on disk or on the CDN. Deriving
     * the filename from the id put a URL in every one of these 1,324 rows that 404s, which
     * nothing noticed because no test had ever followed one. The client was always right:
     * `imgSrc` in packages/domain/src/exercises.js is `IMG_BASE + ex.img`, which is why the
     * mobile build's artwork worked while every hosted instance showed broken images. */
    image_url: `${IMG_BASE}${e.img}`,
    animation_url: `${GIF_BASE}${e.gif}`,
    attribution: ATTRIBUTION
  }))
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
