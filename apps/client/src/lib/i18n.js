// Tiny dependency-free i18n. English source strings are the keys; locale files in
// src/locales/ map them to translations and are lazy-loaded (Vite code-splits each
// import.meta.glob entry), so the initial bundle stays English-only.
//
// Two languages ship: English, which is the source, and Persian, which is the market. The
// other eleven were removed deliberately — see LANGS.
import { useSyncExternalStore } from 'react'
import { setI18n, setMediaBases, say as saySource, loadNames, weekStartsFor } from '@gymbuddy/domain'

/* UI languages: the source and the market, and nothing in between.
 *
 * This shipped with thirteen for a while. Twelve of them were a tax rather than a reach —
 * every user-facing string had to be written thirteen times before it could merge, which is
 * a real cost paid on every feature, against languages nobody using this product speaks. The
 * customer here is a Persian-speaking coach; English is the source strings and the fallback.
 *
 * A profile that had chosen one of the removed languages lands back on English through the
 * guard in `setLang` — the stored preference is simply no longer a language that ships. */
export const LANGS = { en: 'English', fa: 'فارسی' }
/* Languages written right to left. The whole layout mirrors for these — see the [dir="rtl"]
 * rules in index.css — so this set is the single switch, not a per-component decision. */
export const RTL_LANGS = new Set(['fa'])
export const isRTL = () => RTL_LANGS.has(lang)

/* The language the device is set to, for a profile that has not chosen one.
 *
 * A first-run default and nothing more: `DEF` is what saved state is overlaid *on* — local,
 * server pull and backup import all merge onto a clone of it — so a profile that has ever
 * chosen a language keeps that choice, and only a tree with no `lang` at all lands here.
 * (A reset comes back through here too, which is the same answer a fresh install gives.)
 *
 * `navigator.languages` is the user's own preference order, most wanted first, and its entries
 * carry region and script subtags this app has no separate packs for — `fa-IR`, `pt-BR`,
 * `zh-Hans-CN`. LANGS is keyed by the base subtag, so match on that and take the first one
 * that ships. Falls back to English when nothing matches, or when there is no `navigator`
 * at all: the store is imported by tests running in node, and this is evaluated at import.
 */
export function detectLang() {
  if (typeof navigator === 'undefined') return 'en'
  const prefs = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const tag of prefs) {
    const base = String(tag || '').toLowerCase().split('-')[0]
    if (LANGS[base]) return base
  }
  return 'en'
}
const DATE_LOCALES = {
  en: 'en-GB',
  // fa-IR resolves to the Persian calendar in Intl by default, so every date the app already
  // formats becomes Jalali without a date library or a second code path. 1404, not 2026.
  fa: 'fa-IR'
}
/* Which weekday the week grid starts on comes from the domain, which is also where the server
 * reads it from — see `weekStartsFor`. Two maps would disagree the day somebody added a locale
 * to one of them, and a coach and their client would be looking at different Saturdays. */

const localePacks = import.meta.glob('../locales/*.js')

/* Exercise names come from the domain package rather than from here.
 *
 * They moved when the server started writing sentences that contain them: a coach's drafted
 * note is assembled server-side in the reader's language and arrives as finished text, so the
 * name has to be translated before it is baked in. One pack, reachable from both sides — see
 * packages/domain/src/names/index.js. `loadNames` is still a dynamic import, so this is exactly
 * as lazy as the glob it replaced.
 */
export { NAME_LANGS } from '@gymbuddy/domain'

let lang = 'en'
let dict = {}
/* Exercise instructions are English for everybody.
 *
 * The upstream dataset ships translated instruction packs, and this app carried nine of them —
 * seven megabytes for languages it no longer offers, and none for Persian, which was never
 * among them. So the packs are gone and `instrFor` reads the English steps off the exercise
 * row. `ex.st` has always been the fallback; now it is the only path. */
let names = null            // { exId: name } for the current language, null = English
let version = 0
const subs = new Set()
const notify = () => { version++; subs.forEach(f => f()) }

export const getLang = () => lang
export const dateLocale = () => DATE_LOCALES[lang] || 'en-GB'
export const weekStartsOn = () => weekStartsFor(lang)

/* Which grammatical form a number takes, for the languages where "the plural" is not one form.
 *
 * Call sites choose their key the way English works — `t(n === 1 ? '{0} set' : '{0} sets', n)` —
 * so by the time a locale is asked, the plural key is carrying 0, 2, 5, 21 and everything else.
 * German and Spanish are content with that: one form covers all of them. Russian and Polish are
 * not — 2 подхода, 5 подходов, 21 подход — and no amount of translating a single string fixes
 * it, because the string is the wrong shape.
 *
 * So a locale may give an object keyed by CLDR plural category instead of a string, and this
 * picks the category the number actually falls in. Nothing changes at the call sites, and a
 * locale that needs only one form still writes a plain string.
 *
 * `n` names which argument the noun agrees with, because it is not always the first: in
 * "{0} of {1} sessions" the noun follows {1}. It defaults to 0, which is nearly always right.
 */
const pluralRules = new Map()
const categoryOf = (count, l) => {
  if (!pluralRules.has(l)) pluralRules.set(l, new Intl.PluralRules(l))
  return pluralRules.get(l).select(count)
}
/* Exported, and takes its locale rather than reading the module's.
 *
 * Neither language this app ships needs it: English plurals are two separate source strings and
 * Persian does not inflect a noun after a numeral, so `fa.js` contains no plural object at all.
 * It stays because it is eight lines wrapped around `Intl.PluralRules`, and because the
 * alternative to keeping it is rediscovering Slavic plural rules the day a locale returns.
 *
 * The locale is a parameter so that it can still be tested against languages the app no longer
 * ships — `Intl` knows the rules for every tag whether or not there is a translation file for
 * it, and a plural engine that can only be exercised through a shipped language is one that
 * quietly stops being exercised at all. */
export function pickForm(forms, args, l = lang) {
  const count = Number(args[forms.n ?? 0])
  // A non-number means the caller did not pass the count it promised. 'other' is the form
  // every locale has to define, so it is the one thing that cannot be missing.
  const category = Number.isFinite(count) ? categoryOf(count, l) : 'other'
  return forms[category] ?? forms.other ?? ''
}

/* A number substituted into a sentence, in the digits that language writes.
 *
 * Without this, `t('{0} week streak', 2)` renders "2 هفته پیاپی" — one Latin digit in a Persian
 * sentence, on a screen where `fmtNum` has already written ۵٬۲۰۰ two lines above. Doing it here
 * rather than at three hundred call sites is what makes it true everywhere instead of wherever
 * somebody remembered.
 *
 * Only actual numbers are touched. A string argument is passed through exactly as given: it has
 * usually been through `fmtNum` or `fmtVol` already, and formatting a formatted number strips
 * its unit or its decimal. Applied after the plural form is chosen, because `Intl.PluralRules`
 * needs the number and not its spelling.
 */
const localiseArg = a =>
  typeof a === 'number' && Number.isFinite(a) ? a.toLocaleString(dateLocale()) : a

// Translate a source string; {0},{1}… are replaced with args (also on the English fallback).
export function t(s, ...args) {
  const entry = dict[s]
  let v = typeof entry === 'object' && entry ? pickForm(entry, args) : (entry || s)
  for (let i = 0; i < args.length; i++) v = v.replaceAll('{' + i + '}', localiseArg(args[i]))
  return v
}
// Instructions for an exercise in the current language (English steps as fallback).
export const instrFor = ex => ex.st || []

/**
 * An exercise's name in the current language.
 *
 * Falls back to the English name per exercise rather than per language, so a partially
 * translated library reads as "translated, with some gaps" instead of failing to a blank.
 * Exercises somebody created themselves are never translated — the name is theirs.
 */
export const exName = ex => (ex && !ex.custom && names && names[ex.id]) || (ex ? ex.n : '')

/**
 * A sentence the domain built but did not render — a review finding, a coach's headline.
 *
 * The domain works out the numbers and leaves the wording open, because the review is computed
 * on the server and only this side knows what language the reader uses. Exercise names inside
 * one go through `exName`, so a Farsi finding names the lift in Farsi.
 */
export const say = m => saySource(m, { t, exName, listSep: listSeparator() })

/* How this language joins a list. Only the ones that differ from ", " are listed. */
const LIST_SEPARATORS = { fa: '، ', zh: '、', ko: ', ' }
export const listSeparator = () => LIST_SEPARATORS[lang] || ', '

/** Both names an exercise answers to, for search — people type either. */
export const exSearchText = ex => {
  const translated = names && names[ex.id]
  return translated ? (translated + ' ' + ex.n).toLowerCase() : (ex.n || '').toLowerCase()
}

export async function setLang(l) {
  if (!LANGS[l]) l = 'en'
  if (l === lang && version > 0) return
  lang = l
  /* The document's own direction and language, not a React prop: `dir` has to be on <html> for
   * form controls, scrollbars and text selection to mirror, and `lang` is what tells the
   * renderer to pick Persian glyph shapes and hyphenation. */
  if (typeof document !== 'undefined') {
    document.documentElement.lang = l
    document.documentElement.dir = RTL_LANGS.has(l) ? 'rtl' : 'ltr'
  }
  try {
    dict = l === 'en' ? {} : (await localePacks['../locales/' + l + '.js']()).default
    names = await loadNames(l)
  } catch (e) { dict = {}; names = null }
  notify()
}

// Re-renders the subscribing component (and its children) whenever the language changes.
export function useLang() {
  return useSyncExternalStore(fn => { subs.add(fn); return () => subs.delete(fn) }, () => version)
}

// Hand the shared domain package this runtime's translator. Until this runs it falls back
// to English, which is also what an untranslated key resolves to — so a domain string
// rendered before the first setLang() is correct, never a placeholder.
setI18n({ t, dateLocale, weekStartsOn })

// Same reason: `import.meta.env` is Vite-only, so the domain package reads its media bases
// through a setter and this — the client, the one runtime that has Vite — supplies them.
setMediaBases({ img: import.meta.env.VITE_IMG_BASE, gif: import.meta.env.VITE_GIF_BASE })
