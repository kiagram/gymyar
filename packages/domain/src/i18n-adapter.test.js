import { describe, it, expect, afterEach } from 'vitest'
import { setI18n, t, dateLocale } from './i18n-adapter.js'
import { exCount } from './format.js'

afterEach(() => setI18n(null))

describe('i18n seam', () => {
  it('falls back to English with interpolation intact', () => {
    expect(t('{0} exercises', 3)).toBe('3 exercises')
    expect(dateLocale()).toBe('en-GB')
  })

  it('routes through a registered translator', () => {
    setI18n({
      t: (s, ...a) => ({ '{0} exercises': '{0} Übungen' }[s] || s).replaceAll('{0}', a[0]),
      dateLocale: () => 'de-DE'
    })
    expect(t('{0} exercises', 3)).toBe('3 Übungen')
    expect(dateLocale()).toBe('de-DE')
  })

  it('reaches modules that only call t at call time', () => {
    // exCount is defined at module scope but calls t lazily — the whole reason the seam works
    expect(exCount(2)).toBe('2 exercises')
    setI18n({ t: (s, ...a) => 'X'.repeat(a[0]) })
    expect(exCount(2)).toBe('XX')
  })

  it('a partial registration keeps the English default for the rest', () => {
    setI18n({ t: () => 'translated' })
    expect(dateLocale()).toBe('en-GB')
  })

  it('unregisters back to English', () => {
    setI18n({ t: () => 'translated' })
    setI18n(null)
    expect(t('{0} exercises', 1)).toBe('1 exercises')
  })
})
