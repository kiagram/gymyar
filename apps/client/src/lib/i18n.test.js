/* Switching to Farsi, and everything that has to follow from it.
 *
 * The interesting part is not the dictionary lookup — it is that one call has to move four
 * separate things at once: the document's direction, the date locale the shared domain package
 * formats with, which weekday a week starts on, and the strings themselves. Each of those lives
 * somewhere else, and a language that changes three of the four is worse than one that changes
 * none, because it looks translated and reads wrong.
 *
 * `document` is faked the way wakelock.test.js does it — a plain global, no jsdom. All the
 * module touches is documentElement's two attributes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setLang, getLang, dateLocale, weekStartsOn, isRTL, t, exName, exSearchText, LANGS, RTL_LANGS, NAME_LANGS } from './i18n.js'
import { fmtDate, startOfWeek, isoOf, EXIDX } from '@gymbuddy/domain'

const realDocument = globalThis.document

beforeAll(() => {
  Object.defineProperty(globalThis, 'document', {
    value: { documentElement: { lang: 'en', dir: 'ltr' } },
    configurable: true, writable: true
  })
})
afterAll(async () => {
  await setLang('en')
  Object.defineProperty(globalThis, 'document', {
    value: realDocument, configurable: true, writable: true
  })
})

describe('Farsi is a language the app offers', () => {
  it('appears in the picker under its own name', () => {
    expect(LANGS.fa).toBe('فارسی')
  })

  it('is the only right-to-left language so far', () => {
    expect([...RTL_LANGS]).toEqual(['fa'])
  })
})

describe('switching to Farsi', () => {
  it('turns the document right to left', async () => {
    await setLang('fa')
    expect(document.documentElement.dir).toBe('rtl')
    expect(document.documentElement.lang).toBe('fa')
    expect(isRTL()).toBe(true)
    expect(getLang()).toBe('fa')
  })

  it('translates the strings', async () => {
    await setLang('fa')
    expect(t('Settings')).toBe('تنظیمات')
    expect(t('Start workout')).toBe('شروع تمرین')
    // Interpolation still has to work after the swap — the arg is spliced into Persian text.
    expect(t('{0} week streak', 3)).toBe('3 هفته پیاپی')
  })

  it('starts the week on Saturday', async () => {
    await setLang('fa')
    expect(weekStartsOn()).toBe(6)
    // Through the shared domain package, not just the local getter: this is the seam that was
    // hardcoded to Monday, and Saturday 22 August must now open its own week rather than close
    // the previous one.
    expect(isoOf(startOfWeek('2026-08-26'))).toBe('2026-08-22')
  })

  it('renders dates in the Jalali calendar', async () => {
    await setLang('fa')
    expect(dateLocale()).toBe('fa-IR')
    // 23 August 2026 is 1 Shahrivar 1405. No date library involved — fa-IR resolves to the
    // Persian calendar in Intl, and the domain formats through the registered locale.
    const out = fmtDate('2026-08-23')
    expect(out).toContain('شهریور')
    expect(out).not.toMatch(/Aug|August/)
  })
})

describe('switching back', () => {
  it('returns the document to left to right', async () => {
    await setLang('fa')
    await setLang('en')
    expect(document.documentElement.dir).toBe('ltr')
    expect(document.documentElement.lang).toBe('en')
    expect(isRTL()).toBe(false)
  })

  it('restores Monday and the Gregorian calendar', async () => {
    await setLang('fa')
    await setLang('en')
    expect(weekStartsOn()).toBe(1)
    expect(isoOf(startOfWeek('2026-08-26'))).toBe('2026-08-24')
    expect(fmtDate('2026-08-23')).toMatch(/Aug/)
  })

  it('leaves every other language on Monday', async () => {
    for (const lang of ['de', 'tr', 'ru', 'zh']) {
      await setLang(lang)
      expect(weekStartsOn()).toBe(1)
      expect(document.documentElement.dir).toBe('ltr')
    }
  })
})

describe('exercise names', () => {
  // 0025 is barbell bench press — the planner reaches it for almost every strength brief.
  const bench = EXIDX['0025']

  it('translates what a generated programme can prescribe', async () => {
    await setLang('fa')
    expect(NAME_LANGS).toContain('fa')
    expect(exName(bench)).toBe('پرس سینه هالتر')
  })

  it('falls back per exercise, not per language', async () => {
    await setLang('fa')
    // 0001 (3/4 sit-up) is in the library but outside the planner's reach, so it is untranslated
    // — and must still render its English name rather than nothing.
    expect(exName(EXIDX['0001'])).toBe(EXIDX['0001'].n)
  })

  it('never renames an exercise somebody wrote themselves', async () => {
    await setLang('fa')
    const mine = { id: '0025', n: 'My own press', custom: true }
    expect(exName(mine)).toBe('My own press')
  })

  it('is the English name again in English', async () => {
    await setLang('en')
    expect(exName(bench)).toBe('barbell bench press')
  })

  it('finds an exercise by either name', async () => {
    await setLang('fa')
    const text = exSearchText(bench)
    expect(text).toContain('پرس سینه')
    // Someone who knows the lift as "bench press" must still find it in a Farsi UI.
    expect(text).toContain('bench press')
  })

  it('searches only the English name when there is no translation', async () => {
    await setLang('en')
    expect(exSearchText(bench)).toBe('barbell bench press')
  })
})
