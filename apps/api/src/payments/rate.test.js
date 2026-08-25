/* The price index. Arithmetic on two environment variables and a date, which sounds harmless
 * until you notice that getting it wrong either gives a year of service away or charges
 * somebody fifty times what they agreed to.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { priceIndex, indexed, offeredTerms, maxAgeDays } from './rate.js'

const KEYS = ['TOMAN_PER_USD', 'TOMAN_PER_USD_AT', 'PRICE_BASELINE_TOMAN_PER_USD', 'RATE_MAX_AGE_DAYS']
let saved

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const DAY = 86400000
/** A rate read `days` ago, with the list written at `baseline`. */
const configure = ({ toman, baseline = 200_000, days = 0 }) => {
  if (toman != null) process.env.TOMAN_PER_USD = String(toman)
  if (baseline != null) process.env.PRICE_BASELINE_TOMAN_PER_USD = String(baseline)
  process.env.TOMAN_PER_USD_AT = new Date(Date.now() - days * DAY).toISOString()
}

describe('an instance that has never configured a rate', () => {
  it('is not indexed, and not stale either', () => {
    const ix = priceIndex()
    expect(ix.indexed).toBe(false)
    // Never having made the claim is not the same as having made it and let it rot.
    expect(ix.stale).toBe(false)
    expect(ix.multiplier).toBe(1)
  })

  it('leaves every price exactly as written', () => {
    expect(indexed(149_000)).toBe(149_000)
    expect(indexed(1_290_000)).toBe(1_290_000)
  })

  it('still sells every term', () => {
    expect(offeredTerms([1, 3, 12])).toEqual([1, 3, 12])
  })

  it('needs both halves before it indexes anything', () => {
    process.env.TOMAN_PER_USD = '400000'
    expect(priceIndex().multiplier).toBe(1)
    delete process.env.TOMAN_PER_USD
    process.env.PRICE_BASELINE_TOMAN_PER_USD = '200000'
    expect(priceIndex().multiplier).toBe(1)
  })
})

describe('a rate that is doing its job', () => {
  it('moves prices by the ratio of today to when the list was written', () => {
    configure({ toman: 220_000, baseline: 200_000 })
    const ix = priceIndex()
    expect(ix.usable).toBe(true)
    expect(ix.multiplier).toBeCloseTo(1.1, 6)
    expect(indexed(149_000)).toBe(164_000)   // 163,900 → nearest thousand
  })

  it('rounds to something a person would recognise', () => {
    configure({ toman: 203_200, baseline: 186_500 })
    // Never a price with three digits of noise on the end of it.
    expect(indexed(1_290_000) % 1000).toBe(0)
    expect(indexed(149_000) % 1000).toBe(0)
  })

  it('moves prices down when the currency strengthens', () => {
    configure({ toman: 150_000, baseline: 200_000 })
    expect(indexed(200_000)).toBe(150_000)
  })

  it('never rounds a price down to nothing', () => {
    configure({ toman: 60_000, baseline: 200_000 })
    expect(indexed(1_000)).toBeGreaterThanOrEqual(1000)
  })

  it('reports the rate and its age for the screens that show them', () => {
    configure({ toman: 203_200, baseline: 200_000, days: 3 })
    const ix = priceIndex()
    expect(ix.toman).toBe(203_200)
    expect(ix.ageDays).toBe(3)
    expect(ix.at).toBeInstanceOf(Date)
  })
})

describe('a rate nobody has updated', () => {
  it('goes stale past the bound', () => {
    configure({ toman: 220_000, days: 30 })
    const ix = priceIndex()
    expect(ix.stale).toBe(true)
    expect(ix.usable).toBe(false)
  })

  it('withdraws every term but the shortest', () => {
    configure({ toman: 220_000, days: 30 })
    // A year sold at a month-old rate cannot be undone. A month can.
    expect(offeredTerms([1, 3, 12])).toEqual([1])
  })

  it('keeps applying the last known rate rather than reverting', () => {
    configure({ toman: 220_000, baseline: 200_000, days: 30 })
    // Stale is closer to the truth than pretending the currency never moved.
    expect(priceIndex().multiplier).toBeCloseTo(1.1, 6)
    expect(indexed(200_000)).toBe(220_000)
  })

  it('honours a bound the operator widened', () => {
    process.env.RATE_MAX_AGE_DAYS = '90'
    configure({ toman: 220_000, days: 30 })
    expect(maxAgeDays()).toBe(90)
    expect(priceIndex().stale).toBe(false)
  })

  it('is stale the moment it is set with no date on it', () => {
    process.env.TOMAN_PER_USD = '220000'
    process.env.PRICE_BASELINE_TOMAN_PER_USD = '200000'
    // "We have a rate but will not say when it was true" is not a stronger claim than none.
    expect(priceIndex().stale).toBe(true)
    expect(offeredTerms([1, 3, 12])).toEqual([1])
  })

  it('treats a date it cannot read as no date', () => {
    process.env.TOMAN_PER_USD = '220000'
    process.env.PRICE_BASELINE_TOMAN_PER_USD = '200000'
    process.env.TOMAN_PER_USD_AT = 'last tuesday'
    expect(priceIndex().stale).toBe(true)
  })
})

describe('a rate somebody fat-fingered', () => {
  it('refuses to charge fifty times on the strength of a typo', () => {
    configure({ toman: 200_000_000, baseline: 200_000 })   // an extra three zeros
    const ix = priceIndex()
    expect(ix.implausible).toBe(true)
    expect(ix.multiplier).toBe(1)
    expect(indexed(149_000)).toBe(149_000)
  })

  it('refuses the same in the other direction', () => {
    configure({ toman: 2_000, baseline: 200_000 })
    expect(priceIndex().implausible).toBe(true)
    expect(priceIndex().multiplier).toBe(1)
  })

  it('restricts the terms too, because it does not know what its prices are worth', () => {
    configure({ toman: 200_000_000, baseline: 200_000 })
    expect(offeredTerms([1, 3, 12])).toEqual([1])
  })

  it('ignores a rate that is not a number, or is zero or negative', () => {
    for (const bad of ['free', '0', '-1', '']) {
      process.env.TOMAN_PER_USD = bad
      process.env.PRICE_BASELINE_TOMAN_PER_USD = '200000'
      expect(priceIndex().indexed).toBe(false)
      expect(priceIndex().multiplier).toBe(1)
    }
  })
})

describe('reading the environment', () => {
  it('reads on every call, because the rate changes under a running server', () => {
    expect(priceIndex().indexed).toBe(false)
    configure({ toman: 220_000 })
    expect(priceIndex().indexed).toBe(true)
  })
})
