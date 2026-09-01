import { describe, it, expect } from 'vitest'
import { normalizePhone, isIranianMobile, formatPhone, maskPhone, latinDigits } from './phone.js'

const CANON = '+989123456789'

describe('normalizePhone', () => {
  it('reads every spelling of the same number', () => {
    for (const spelling of [
      '09123456789',
      '9123456789',
      '+989123456789',
      '989123456789',
      '00989123456789',
      '+98 912 345 6789',
      '0912-345-6789',
      '0912 345 6789',
      '(0912) 345 6789',
      '0098-912-345-6789'
    ]) expect(normalizePhone(spelling), spelling).toBe(CANON)
  })

  it('reads Persian and Arabic-Indic digits', () => {
    // What an Iranian phone's own keyboard produces, with no effort from its owner.
    expect(normalizePhone('۰۹۱۲۳۴۵۶۷۸۹')).toBe(CANON)
    expect(normalizePhone('٠٩١٢٣٤٥٦٧٨٩')).toBe(CANON)
    expect(normalizePhone('+۹۸ ۹۱۲ ۳۴۵ ۶۷۸۹')).toBe(CANON)
  })

  it('survives the invisible characters a Persian keyboard leaves behind', () => {
    expect(normalizePhone('۰۹۱۲‌۳۴۵‏۶۷۸۹')).toBe(CANON)
  })

  it('refuses what cannot receive an SMS', () => {
    for (const no of [
      '02112345678',    // a Tehran landline
      '+982112345678',
      '0912345678',     // one digit short
      '091234567890',   // one too many
      '+19123456789',   // not Iran
      '8123456789',     // national numbers start with 9
      'not a number',
      '',
      null,
      undefined
    ]) expect(normalizePhone(no), String(no)).toBe(null)
  })

  it('accepts a range that has not been allocated yet', () => {
    // Deliberate: operator prefixes have grown every few years, and an allowlist rejects a
    // real number the day a new one is issued.
    expect(normalizePhone('09991234567')).toBe('+989991234567')
  })

  it('answers the same thing through isIranianMobile', () => {
    expect(isIranianMobile('۰۹۱۲۳۴۵۶۷۸۹')).toBe(true)
    expect(isIranianMobile('02112345678')).toBe(false)
  })
})

describe('latinDigits', () => {
  it('converts a code typed on a Persian keyboard', () => {
    expect(latinDigits('۱۲۳۴۵۶')).toBe('123456')
    expect(latinDigits('٤٥٦')).toBe('456')
    expect(latinDigits('123456')).toBe('123456')
  })
})

describe('display', () => {
  it('shows a number the way it is read in Iran', () => {
    expect(formatPhone('+989123456789')).toBe('0912 345 6789')
    expect(formatPhone('۰۹۱۲۳۴۵۶۷۸۹')).toBe('0912 345 6789')
  })

  it('leaves something it cannot parse alone rather than mangling it', () => {
    expect(formatPhone('nonsense')).toBe('nonsense')
  })

  it('masks enough to recognise and not enough to dial', () => {
    expect(maskPhone('+989123456789')).toBe('0912•••6789')
    expect(maskPhone('nope')).toBe('')
  })
})
