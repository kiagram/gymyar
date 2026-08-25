// Tiny dependency-free i18n. English source strings are the keys; locale files in
// src/locales/ map them to translations and are lazy-loaded (Vite code-splits each
// import.meta.glob entry), so the initial bundle stays English-only.
// Exercise instructions come from separately generated packs in src/instr/ (one per
// language, from the upstream dataset) — also lazy-loaded on language switch.
import { useSyncExternalStore } from 'react'
import { setI18n, setMediaBases, say as saySource } from '@gymbuddy/domain'

// UI languages. de/pt have no instruction pack upstream — instructions fall back to English.
export const LANGS = {
  en: 'English', de: 'Deutsch', es: 'Español', fr: 'Français', it: 'Italiano',
  pt: 'Português', pl: 'Polski', tr: 'Türkçe', ru: 'Русский', zh: '中文',
  ko: '한국어', hi: 'हिन्दी', fa: 'فارسی'
}
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
export const INSTR_LANGS = ['en', 'es', 'fr', 'it', 'tr', 'ru', 'zh', 'hi', 'pl', 'ko']
const DATE_LOCALES = {
  en: 'en-GB', de: 'de-DE', es: 'es-ES', fr: 'fr-FR', it: 'it-IT', pt: 'pt-PT',
  pl: 'pl-PL', tr: 'tr-TR', ru: 'ru-RU', zh: 'zh-CN', ko: 'ko-KR', hi: 'hi-IN',
  // fa-IR resolves to the Persian calendar in Intl by default, so every date the app already
  // formats becomes Jalali without a date library or a second code path. 1404, not 2026.
  fa: 'fa-IR'
}
/* Which weekday the week grid starts on, as a `getDay()` index.
 *
 * Only languages that differ from Monday are listed. Every language here was hardcoded to
 * Monday before this map existed, so leaving one out keeps exactly what it did — and the ones
 * that arguably want Sunday (hi, ko, zh) are left alone deliberately rather than changed as a
 * side effect of adding Farsi. */
const WEEK_STARTS = { fa: 6 }

const localePacks = import.meta.glob('../locales/*.js')
const instrPacks = import.meta.glob('../instr/*.js')
const namePacks = import.meta.glob('../names/*.js')

/* Languages with translated exercise names. Separate from the instruction packs because the
 * two are translated by different people at different times — a name is four words a coach
 * checks in a second, a set of instructions is a paragraph. */
export const NAME_LANGS = ['fa']

let lang = 'en'
let dict = {}
let instr = null            // { exId: [steps] } for the current language, null = English
let names = null            // { exId: name } for the current language, null = English
let version = 0
const subs = new Set()
const notify = () => { version++; subs.forEach(f => f()) }

export const getLang = () => lang
export const dateLocale = () => DATE_LOCALES[lang] || 'en-GB'
export const weekStartsOn = () => WEEK_STARTS[lang] ?? 1

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
function pickForm(forms, args) {
  const count = Number(args[forms.n ?? 0])
  // A non-number means the caller did not pass the count it promised. 'other' is the form
  // every locale has to define, so it is the one thing that cannot be missing.
  const category = Number.isFinite(count) ? categoryOf(count, lang) : 'other'
  return forms[category] ?? forms.other ?? ''
}

// Translate a source string; {0},{1}… are replaced with args (also on the English fallback).
export function t(s, ...args) {
  const entry = dict[s]
  let v = typeof entry === 'object' && entry ? pickForm(entry, args) : (entry || s)
  for (let i = 0; i < args.length; i++) v = v.replaceAll('{' + i + '}', args[i])
  return v
}
// Instructions for an exercise in the current language (English steps as fallback).
export const instrFor = ex => (instr && instr[ex.id]) || ex.st || []

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
    instr = l === 'en' || !INSTR_LANGS.includes(l) ? null : (await instrPacks['../instr/' + l + '.js']()).default
    names = NAME_LANGS.includes(l) ? (await namePacks['../names/' + l + '.js']()).default : null
  } catch (e) { dict = {}; instr = null; names = null }
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
