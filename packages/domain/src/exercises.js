import { EXDB } from './exercises-data.js'
import { t } from './i18n-adapter.js'
import { MEDIA_SET } from './media-set.js'

export { EXDB }
export const EXIDX = {}
EXDB.forEach(e => { EXIDX[e.id] = e })
export const BODYPARTS = [...new Set(EXDB.map(e => e.bp))].sort()

// Equipment options present in a given list of exercises, most common first (issue #6).
// Deriving them from the *already filtered* list keeps the chip row short and means
// every body-part × equipment combination on screen has results behind it.
export function equipmentOf(list) {
  const c = {}
  list.forEach(e => { if (e.eq) c[e.eq] = (c[e.eq] || 0) + 1 })
  return Object.keys(c).sort((a, b) => c[b] - c[a] || (a < b ? -1 : 1))
}

// Custom (user-created) exercises live in synced state S.customEx (issue #11) and are
// merged into the id index here so every EXIDX[id] lookup keeps working unchanged.
let customIds = []
export function registerCustom(list) {
  customIds.forEach(id => delete EXIDX[id])
  customIds = (list || []).map(e => e.id)
  ;(list || []).forEach(e => { EXIDX[e.id] = e })
}
// Full searchable catalogue — customs first so your own exercises are easy to find.
export const allExercises = st => [...(st.customEx || []), ...EXDB]

// Media normally sits next to the app (img/ and gif/, mounted into the web container).
// A build can point them somewhere else — the mobile build pulls them off a CDN instead of
// shipping ~140 MB of images into the app bundle.
//
// Read through a setter rather than `import.meta.env`, which only exists under Vite: this
// module also runs in the API and the seeder, and a bare `import.meta.env` there is a
// TypeError on import, not a missing default. The client sets these at boot.
let IMG_BASE = 'img/'
let GIF_BASE = 'gif/'
export function setMediaBases({ img, gif } = {}) {
  if (img != null) IMG_BASE = img
  if (gif != null) GIF_BASE = gif
}
export const mediaBases = () => ({ img: IMG_BASE, gif: GIF_BASE })

// *Which* artwork, as opposed to where it is served from. The base is deployment; the set is
// the licence. See media-set.js for why the two are separate and why the second one had to
// exist before "replacing the media" could mean anything.
let SET = MEDIA_SET
export function setMediaSet(set) { SET = set || MEDIA_SET }
export const mediaSet = () => SET

// A set may name a file, which rides on the base, or a whole URL, which does not. Both are
// needed: artwork mounted next to the app is a filename, and a set hosted by whoever licensed
// it to us is a URL that has nothing to do with our own img/ directory.
const at = (base, name) => (/^(https?:)?\/\//.test(name) ? name : base + name)

// The dataset's own names when no set overrides them, and otherwise the set's — including its
// silences. `?? null` rather than a fallback to `ex.img`: a replacement set that does not
// cover an exercise means we have no artwork for it, and drawing the old one there would keep
// shipping the pictures the swap was performed to stop shipping.
//
// Custom exercises are somebody's own row and are never in a set, so they are answered from
// their own fields — which are empty, which is why a custom exercise has never had a picture.
const fileOf = (ex, field) =>
  (SET.media && !ex.custom ? SET.media[ex.id]?.[field] ?? null : ex[field] || null)

/** Both URLs for an exercise, against explicit bases — either may be null. */
export function mediaUrls(ex, bases = { img: IMG_BASE, gif: GIF_BASE }) {
  const img = fileOf(ex, 'img'), gif = fileOf(ex, 'gif')
  return { img: img && at(bases.img, img), gif: gif && at(bases.gif, gif) }
}
export const imgSrc = ex => mediaUrls(ex).img
export const gifSrc = ex => mediaUrls(ex).gif

// Cardio exercises log time + speed instead of weight × reps.
export const isCardio = idOrEx => (typeof idOrEx === 'string' ? EXIDX[idOrEx] : idOrEx)?.bp === 'cardio'

// Exercises the dataset already knows carry no external load (issue #32) — a quarter of the
// catalogue. This seeds the `bw` flag on a fresh config so a push-up never asks for a weight
// nobody was going to enter. It is only the default: the flag lives on the config, so a dip
// done with a belt can turn it off and a custom exercise can turn it on.
export const isBodyweightEq = idOrEx =>
  (typeof idOrEx === 'string' ? EXIDX[idOrEx] : idOrEx)?.eq === 'body weight'

// An id that resolves to nothing — a plan file built against a different exercise dataset,
// a custom exercise deleted on another device before the sync arrived — still has to
// render. A placeholder keeps it visible (and removable) instead of taking the whole view
// down on the first `ex.n`.
export const exOr = id => EXIDX[id] ||
  { id, n: t('Unknown exercise'), bp: '', tg: '', eq: '', sm: [], st: [], missing: true }
