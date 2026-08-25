#!/usr/bin/env node
// Guards two things about src/locales/: that every locale carries the same key set, and
// that the key set covers every string the UI can actually render.
//
// English is the source language and has no locale file, so both gaps fail the same
// silent way — the string renders in English, mid-sentence, with nothing erroring
// anywhere. The coaching UI shipped like that for a whole phase: 204 strings called
// `t()` correctly and had no entry in any of the twelve locale files, so Farsi drew a
// mirrored layout around English text. Nothing could have caught it but reading.
//
//   node scripts/check-locales.mjs
//
// The reference for the first check is the union of all locales, not one blessed file:
// a key added to a single locale then flags the other eleven instead of passing
// unnoticed. The reference for the second is the source itself.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const localesDir = join(srcDir, 'locales')
const files = readdirSync(localesDir).filter(f => f.endsWith('.js')).sort()

if (!files.length) {
  console.error(`No locale files found in ${localesDir}`)
  process.exit(1)
}

const locales = new Map()
const dicts = new Map()
for (const file of files) {
  const { default: dict } = await import(pathToFileURL(join(localesDir, file)).href)
  if (!dict || typeof dict !== 'object') {
    console.error(`${file}: no default-exported object`)
    process.exit(1)
  }
  const lang = file.replace(/\.js$/, '')
  locales.set(lang, new Set(Object.keys(dict)))
  dicts.set(lang, dict)
}

// How many locales carry each key — 1 means the key was added to a single file only,
// which is the usual shape of the bug and worth naming separately from plain gaps.
const seen = new Map()
for (const keys of locales.values()) for (const k of keys) seen.set(k, (seen.get(k) || 0) + 1)
const union = [...seen.keys()]

let failed = false
for (const [lang, keys] of locales) {
  const missing = union.filter(k => !keys.has(k))
  const orphans = union.filter(k => keys.has(k) && seen.get(k) === 1)
  if (missing.length || orphans.length) {
    failed = true
    console.error(`\n${lang}.js: ${keys.size}/${union.length} keys`)
    for (const k of missing) console.error(`  missing:   ${JSON.stringify(k)}`)
    for (const k of orphans) console.error(`  only here: ${JSON.stringify(k)}`)
  }
}

if (failed) {
  console.error('\nLocale key sets differ. Every locale must carry the same keys.')
  process.exit(1)
}

/* Plural forms.
 *
 * A locale whose noun takes more than one plural shape writes an object keyed by CLDR
 * category instead of a string — see the note on `pickForm` in lib/i18n.js. Getting one of
 * those subtly wrong fails the same silent way everything else in this file does: a missing
 * category falls through to `other`, which reads as "5 подход" to everyone but the person
 * who wrote it. So the shape is checked here rather than trusted.
 */
const CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other']
const placeholders = s => [...s.matchAll(/\{(\d)\}/g)].map(m => m[1]).sort().join(',')

for (const [lang, dict] of dicts) {
  const required = new Intl.PluralRules(lang).resolvedOptions().pluralCategories
  const problems = []
  for (const [key, value] of Object.entries(dict)) {
    if (typeof value === 'string') continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`${JSON.stringify(key)}: value is neither a string nor a plural object`)
      continue
    }
    const forms = Object.keys(value).filter(k => k !== 'n')
    const unknown = forms.filter(f => !CATEGORIES.includes(f))
    const absent = required.filter(f => !forms.includes(f))
    if (unknown.length) problems.push(`${JSON.stringify(key)}: not a plural category: ${unknown.join(', ')}`)
    // Every category this language distinguishes, or the missing one silently reads as `other`.
    if (absent.length) problems.push(`${JSON.stringify(key)}: missing ${absent.join(', ')} — ${lang} needs ${required.join('/')}`)
    if (required.length === 1) problems.push(`${JSON.stringify(key)}: ${lang} has one plural form, so this should be a plain string`)

    const index = value.n ?? 0
    if (!Number.isInteger(index) || index < 0) problems.push(`${JSON.stringify(key)}: n must be an argument index`)
    else if (!key.includes(`{${index}}`)) problems.push(`${JSON.stringify(key)}: agrees with {${index}}, which the key does not have`)

    // Interpolation happens after the form is picked, so a form that drops {0} drops the number.
    for (const form of forms) {
      if (typeof value[form] !== 'string') { problems.push(`${JSON.stringify(key)}: ${form} is not a string`); continue }
      if (placeholders(value[form]) !== placeholders(key)) {
        problems.push(`${JSON.stringify(key)}: ${form} does not carry the same placeholders`)
      }
    }
  }
  if (problems.length) {
    failed = true
    console.error(`\n${lang}.js`)
    for (const p of problems) console.error(`  ${p}`)
  }
}

if (failed) {
  console.error('\nPlural forms are malformed. See lib/i18n.js for the shape.')
  process.exit(1)
}

/* Every `t('…')` the client can render, by file.
 *
 * Single-line string literals only, which is how every call in the tree is written. A key
 * built at runtime — `t(label)`, a template literal — is invisible here and always was;
 * this catches the ordinary case, which is the one that goes wrong. */
const T_CALL = /\bt\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g
const sources = []
const walk = dir => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      // instr/ and names/ are generated packs, not UI; locales/ is what we are checking against.
      if (!['locales', 'instr', 'names'].includes(entry)) walk(path)
    } else if (/\.jsx?$/.test(entry) && !/\.test\./.test(entry)) sources.push(path)
  }
}
walk(srcDir)

const known = new Set(union)
let untranslated = 0
for (const path of sources.sort()) {
  const gaps = new Set()
  for (const [, , literal] of readFileSync(path, 'utf8').matchAll(T_CALL)) {
    const key = literal.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n')
    if (!known.has(key)) gaps.add(key)
  }
  if (!gaps.size) continue
  untranslated += gaps.size
  console.error(`\n${path.slice(srcDir.length + 1).replace(/\\/g, '/')}: ${gaps.size} untranslated`)
  for (const key of gaps) console.error(`  ${JSON.stringify(key)}`)
}

if (untranslated) {
  const s = untranslated === 1 ? 'string the UI renders has' : 'strings the UI renders have'
  console.error(`\n${untranslated} ${s} no entry in any locale — they fall back to`)
  console.error('English in all twelve languages. Add them to every locale file.')
  process.exit(1)
}

console.log(`${locales.size} locales, ${union.length} keys each — in sync.`)
console.log(`${sources.length} source files scanned, every t() string translated.`)
