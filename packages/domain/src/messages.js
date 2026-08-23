/* Sentences the domain produces for a person to read, kept unrendered until something knows
 * what language they read in.
 *
 * The review runs on the server — the client never computes one locally — so a finding built as
 * a finished string arrives already committed to English, and the client cannot undo that. A
 * finding built as `{ msg, args }` arrives with the numbers worked out and the wording still
 * open, and whoever renders it supplies the translator.
 *
 * The English source string is the key, exactly as everywhere else in this codebase, so these
 * sentences live in the same locale packs as the rest of the UI and need no registry of their
 * own. `say()` with no options is the English identity, which is what the server wants for a
 * log line and what any caller gets by default.
 */
import { t as defaultT } from './i18n-adapter.js'
import { EXIDX } from './exercises.js'
import { MUSCLE_NAME } from './muscles.js'

/** A sentence and the values that go in it. `msg('{0} of {1} sessions', 3, 4)`. */
export const msg = (template, ...args) => ({ msg: template, args })

/** An argument naming an exercise, so a renderer can substitute a translated name. */
export const exArg = id => ({ ex: id })

/** An argument that is a list of muscle keys, each named in the reader's language. */
export const muscleList = (keys, limit = 4) => ({ muscles: keys.slice(0, limit) })

/**
 * Render a sentence.
 *
 * `t` is the translator — the client's, which has the locale packs. `exName` resolves an
 * exercise to the name that reader sees, so a Farsi finding names the lift in Farsi rather
 * than reaching past the translation the app already has.
 */
export function say(m, { t = defaultT, exName = null, listSep = ', ' } = {}) {
  if (m == null) return ''
  // A plain string is already rendered — a literal, or something that came back over the wire
  // from an older client. Passing it through unchanged keeps both readable.
  if (typeof m === 'string') return m

  const args = (m.args || []).map(a => {
    if (!a || typeof a !== 'object') return a
    if (a.ex) {
      const e = EXIDX[a.ex]
      return (exName ? exName(e) : e?.n) || a.ex
    }
    // Muscle names are locale keys already, so the list is named in the reader's language.
    // Whether it is truncated is the caller's business: it picks a template that says so.
    // Persian separates a list with ، and Chinese with 、 — the comma is part of the language,
    // not punctuation the domain can hardcode.
    if (a.muscles) return a.muscles.map(k => t(MUSCLE_NAME[k] || k).toLowerCase()).join(listSep)
    return a
  })
  return t(m.msg, ...args)
}

/** Every sentence in an object, rendered — for a caller that wants plain strings back. */
export const sayAll = (o, opts) => {
  if (!o || typeof o !== 'object') return o
  const out = Array.isArray(o) ? [] : {}
  for (const [k, v] of Object.entries(o)) {
    out[k] = v && typeof v === 'object' && typeof v.msg === 'string' ? say(v, opts) : v
  }
  return out
}
