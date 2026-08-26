/* Exercise names, in the languages that have them.
 *
 * ## Why these live in the domain and not in the client
 *
 * They started in `apps/client/src/names/`, which was right while the only thing that rendered
 * an exercise name was a screen. It stopped being right the moment the *server* started writing
 * sentences with exercise names in them: a coach drafts a change, the note is assembled on the
 * server in the client's language, and the client receives it as finished text with nothing
 * left to translate. A Persian note that says "lever leg extension" is the shape that bug takes.
 *
 * So the pack is here, where both sides can reach it, and there is one of it rather than two
 * that drift.
 *
 * ## Still lazy, on both sides
 *
 * `load()` is a dynamic import, so a bundler code-splits each pack and a browser that never
 * switches language never fetches one. The server caches what it has loaded, because it serves
 * a Farsi lifter and an English one in the same second and re-importing per request would be
 * silly — but it also cannot register a translator globally for the same reason. Hence a
 * function that takes a language rather than module state holding one.
 *
 * ## Scope
 *
 * Farsi only, and within Farsi only the 66 exercises the planner can actually emit — found by
 * sweeping `buildProgramme` across the brief space rather than by guessing which mattered.
 * Everything outside that set falls back to its English name per exercise, so a partly
 * translated library reads as partly translated rather than blank.
 */

/** Languages with a name pack. Separate from the instruction packs — see the note in i18n.js. */
export const NAME_LANGS = ['fa']

const LOADERS = {
  fa: () => import('./fa.js')
}

const cache = new Map()

/**
 * The name table for a language, or null when it has none.
 *
 * Null rather than an empty object on purpose: "this language has no pack" and "this language
 * has a pack with nothing in it" want the same fallback, and a caller that has to tell them
 * apart is a caller about to get it wrong.
 */
export async function loadNames(lang) {
  if (!NAME_LANGS.includes(lang)) return null
  if (!cache.has(lang)) cache.set(lang, LOADERS[lang]().then(m => m.default))
  return cache.get(lang)
}

/**
 * A `exName`-shaped function for `say()`, for whoever has already loaded a pack.
 *
 * An exercise somebody created themselves is never translated — the name is theirs, in whatever
 * language they typed it.
 */
export const namerFor = names => ex =>
  (ex && !ex.custom && names && names[ex.id]) || (ex ? ex.n : '')
