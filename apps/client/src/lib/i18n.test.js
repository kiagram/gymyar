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
import { setLang, getLang, dateLocale, weekStartsOn, isRTL, t, exName, exSearchText, detectLang, LANGS, RTL_LANGS, NAME_LANGS } from './i18n.js'
import { fmtDate, startOfWeek, isoOf, EXIDX } from '@gymyar/domain'

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
    // Interpolation still has to work after the swap — the arg is spliced into Persian text,
    // and a number is spliced in that language's digits. One Latin numeral in a Persian
    // sentence, two lines under a `fmtNum` that already wrote ۵٬۲۰۰, reads as a bug.
    expect(t('{0} week streak', 3)).toBe('۳ هفته پیاپی')
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

  it('lands a profile on English if it had chosen a language that no longer ships', async () => {
    /* Eleven locales were removed. Somebody whose saved profile still says `de` must open on
     * English — left to right, Monday, Gregorian — rather than on a half-applied state where
     * the dictionary is English and the direction is not. */
    for (const gone of ['de', 'tr', 'ru', 'zh']) {
      await setLang(gone)
      expect(getLang()).toBe('en')
      expect(weekStartsOn()).toBe(1)
      expect(document.documentElement.dir).toBe('ltr')
      expect(t('Settings')).toBe('Settings')
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

/* The coaching UI, in a language that is not English.
 *
 * These strings called `t()` correctly from the day they were written and had no entry in
 * any locale file, so every one of the twelve languages rendered them in English — worst in
 * Farsi, where the layout mirrors around them. The gap was invisible to the locale checker
 * of the time, which only compared locales against each other, and invisible to the app,
 * which falls back by design. A few of the load-bearing ones are pinned here; the rest are
 * covered by scripts/check-locales.mjs, which now reads the source too.
 */
describe('the coaching UI speaks the reader\'s language', () => {
  it('translates what a coach sees', async () => {
    await setLang('fa')
    expect(t('Clients')).toBe('شاگردان')
    expect(t('Propose a change')).toBe('پیشنهاد تغییر')
    expect(t('Send proposal')).toBe('فرستادن پیشنهاد')
  })

  it('translates what a client sees, including the sentence that says what accepting does', async () => {
    await setLang('fa')
    expect(t('Coaching')).toBe('مربی‌گری')
    expect(t('Your plan is unchanged until you accept.')).toBe('تا نپذیرید، برنامه‌تان دست‌نخورده می‌ماند.')
  })

  it('keeps the placeholder through the translation', async () => {
    await setLang('fa')
    // A locale that drops {0} loses the coach's name and reads as a sentence about nobody.
    // A string argument is passed through exactly as given — it has usually been through
    // `fmtNum` or `fmtVol` already, and formatting a formatted number eats its unit.
    expect(t('{0} wants to coach you', 'سارا')).toBe('سارا می‌خواهد مربی شما باشد')
    expect(t('{0} of {1} sessions', 3, 5)).toBe('۳ از ۵ جلسه')
  })

  it('is English again in English', async () => {
    await setLang('en')
    expect(t('Propose a change')).toBe('Propose a change')
  })
})

/* Plural forms, where "the plural" is more than one form.
 *
 * Call sites pick their key the English way — singular for 1, plural for everything else — so
 * Russian and Polish were being handed 2, 5 and 21 with a single translated string to cover
 * them all. It reads as "5 подход" to a native speaker and as nothing at all to everyone else,
 * which is why it survived twelve locales and a locale checker.
 */
describe('numbers inside a sentence', () => {
  /* This block used to test Russian and Polish plural categories, which were the reason
   * `pickForm` exists. Those packs are gone with the other eleven languages, and Persian does
   * not inflect a noun after a numeral — `fa.js` has no plural objects at all.
   *
   * `pickForm` is kept anyway and is deliberately not tested through a fixture: it is the
   * mechanism any future pack would need, and its `other` fallback is what stops a missing form
   * rendering as a blank. What is tested here is what actually ships. */
  it('is the English source string in English', async () => {
    await setLang('en')
    expect(t('{0} sets', 5)).toBe('5 sets')
  })

  it('is Persian, with the number in Persian digits', async () => {
    await setLang('fa')
    expect(t('{0} sets', 5)).toBe('۵ ست')
  })

  it('substitutes two arguments in the order the sentence wants them', async () => {
    await setLang('fa')
    expect(t('{0} of {1} sessions', 3, 5)).toBe('۳ از ۵ جلسه')
  })

  it('renders a sentence whose count is not a number rather than a blank', async () => {
    // A caller slipping must never produce an empty string or a bare category name.
    await setLang('fa')
    expect(t('{0} sets')).toBe('{0} ست')
    expect(t('{0} sets', 'many')).toBe('many ست')
  })
})

/* The language a first run opens in.
 *
 * The bug this exists for is not visible in any screenshot: the app shipped with `lang: 'en'`
 * as a hard default, so an Iranian user installing the APK on a Persian phone got an English
 * app — a fully translated product hiding behind a settings screen they had no reason to open.
 *
 * `navigator` is faked here the way `document` is above.
 */
describe('the language the device asks for', () => {
  const realNavigator = globalThis.navigator
  const asDevice = value => Object.defineProperty(globalThis, 'navigator', {
    value, configurable: true, writable: true
  })
  afterAll(() => asDevice(realNavigator))

  it('opens in Persian on a Persian phone', () => {
    asDevice({ languages: ['fa-IR'] })
    expect(detectLang()).toBe('fa')
  })

  it('takes the first language it ships, in the order the user ranked them', () => {
    // Not "the first tag" — a Farsi speaker who also reads Swedish must not get English.
    asDevice({ languages: ['sv-SE', 'fa-IR', 'en-US'] })
    expect(detectLang()).toBe('fa')
    // A language that no longer ships is skipped over rather than matched.
    asDevice({ languages: ['de-AT', 'fa-IR'] })
    expect(detectLang()).toBe('fa')
  })

  it('matches on the base subtag, whatever region or script rides along', () => {
    for (const [tag, want] of [['fa-IR', 'fa'], ['FA-ir', 'fa'], ['en-AU', 'en'],
      // Regions of languages that no longer ship fall through to English like any other miss.
      ['pt-BR', 'en'], ['zh-Hans-CN', 'en']]) {
      asDevice({ languages: [tag] })
      expect(detectLang()).toBe(want)
    }
  })

  it('falls back to the single `language` when there is no list', () => {
    // Older WebViews, and every environment that fakes one attribute and not the other.
    asDevice({ languages: [], language: 'fa' })
    expect(detectLang()).toBe('fa')
    asDevice({ language: 'fa-IR' })
    expect(detectLang()).toBe('fa')
  })

  it('is English when nothing matches, or when there is nothing to ask', () => {
    asDevice({ languages: ['sv-SE', 'nl'] })
    expect(detectLang()).toBe('en')
    asDevice({ languages: [undefined, null, ''] })
    expect(detectLang()).toBe('en')
    asDevice(undefined)   // node, where the store is imported by tests like this one
    expect(detectLang()).toBe('en')
  })

  it('can reach every language the picker offers', () => {
    // A language in LANGS that detection can never return is one no device can land in.
    for (const lang of Object.keys(LANGS)) {
      asDevice({ languages: [lang] })
      expect(detectLang()).toBe(lang)
    }
  })
})

/* The languages the app offers, and the languages the server will accept.
 *
 * Two lists in two packages, and they have to be the same one. `LANGS` is what a person picks
 * from; `LOCALES` in the domain is what `PATCH /api/me` validates against, because the server
 * cannot import a React module to find out. A language added to the picker and not to the
 * domain is a language the server refuses to record — and the only symptom is that the notes it
 * writes stay in English, which nobody would trace back to a list.
 */
describe('the language list', () => {
  it('is the same on both sides', async () => {
    const { LANGS } = await import('./i18n.js')
    const { LOCALES } = await import('@gymyar/domain')
    expect([...LOCALES].sort()).toEqual(Object.keys(LANGS).sort())
  })

  it('recognises what it lists, and nothing else', async () => {
    const { isLocale } = await import('@gymyar/domain')
    expect(isLocale('fa')).toBe(true)
    expect(isLocale('en')).toBe(true)
    expect(isLocale('xx')).toBe(false)
    expect(isLocale('')).toBe(false)
    expect(isLocale(null)).toBe(false)
    // Region subtags are not locales here: the packs are keyed by the base language.
    expect(isLocale('fa-IR')).toBe(false)
  })
})
