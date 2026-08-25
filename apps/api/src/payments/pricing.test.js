/* Pricing is arithmetic on environment variables, and the arithmetic is the part that can lose
 * a factor of ten. That is what these check.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  amountFor, catalogue, tierCatalogue, billingEnabled, billingConfig, isTerm,
  isSellableTier, capForTier, ENTRY_TIER, gatewayFromEnv
} from './pricing.js'

const KEYS = ['ZARINPAL_MERCHANT_ID', 'ZARINPAL_SANDBOX', 'BILLING_CURRENCY', 'PAYMENT_GATEWAY',
  'PRICE_1M', 'PRICE_3M', 'PRICE_12M',
  ...['SOLO', 'STUDIO', 'PRO'].flatMap(t => [1, 3, 12].map(m => `PRICE_${t}_${m}M`))]
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

describe('billing is off until it is configured', () => {
  it('is off with no merchant id — which is what a self-hosted instance looks like', () => {
    expect(billingEnabled()).toBe(false)
    expect(gatewayFromEnv()).toBeNull()
  })

  it('is on once a merchant id is set', () => {
    process.env.ZARINPAL_MERCHANT_ID = 'abc'
    expect(billingEnabled()).toBe(true)
    expect(gatewayFromEnv().name).toBe('zarinpal')
  })

  it('is off for a gateway name nobody implemented', () => {
    process.env.ZARINPAL_MERCHANT_ID = 'abc'
    process.env.PAYMENT_GATEWAY = 'stripe'
    expect(billingEnabled()).toBe(false)
  })

  it('reads the environment on every call, not once at import', () => {
    expect(billingEnabled()).toBe(false)
    process.env.ZARINPAL_MERCHANT_ID = 'abc'
    expect(billingEnabled()).toBe(true)
  })

  it('passes the sandbox flag through to the gateway', () => {
    process.env.ZARINPAL_MERCHANT_ID = 'abc'
    process.env.ZARINPAL_SANDBOX = '1'
    expect(gatewayFromEnv().sandbox).toBe(true)
  })
})

describe('amounts', () => {
  it('converts Toman prices to Rials — ten to one', () => {
    process.env.PRICE_1M = '149000'
    expect(amountFor(1)).toBe(1_490_000)
  })

  it('sends Toman untouched when the terminal is configured in Toman', () => {
    process.env.BILLING_CURRENCY = 'IRT'
    process.env.PRICE_1M = '149000'
    expect(amountFor(1)).toBe(149_000)
  })

  it('is always an integer — a gateway handed a float rounds it out of sight', () => {
    process.env.PRICE_1M = '149000.7'
    expect(Number.isInteger(amountFor(1))).toBe(true)
  })

  it('has a default for every offered term', () => {
    for (const { months } of catalogue()) expect(amountFor(months)).toBeGreaterThan(0)
  })

  it('refuses a term it has no price for', () => {
    expect(() => amountFor(7)).toThrow(/no price configured/)
  })

  it('refuses a price that was set to nonsense rather than charging it', () => {
    process.env.PRICE_1M = 'free'
    expect(() => amountFor(1)).toThrow(/no price configured/)
  })
})

describe('the catalogue', () => {
  it('offers exactly the terms the domain will credit', () => {
    expect(catalogue().map(t => t.months)).toEqual([1, 3, 12])
  })

  it('gets cheaper per month as the term gets longer', () => {
    const [one, three, year] = catalogue()
    expect(three.perMonthToman).toBeLessThan(one.perMonthToman)
    expect(year.perMonthToman).toBeLessThan(three.perMonthToman)
  })

  it('quotes Toman and sends minor units, and says which currency', () => {
    process.env.PRICE_1M = '100000'
    const [one] = catalogue()
    expect(one.toman).toBe(100_000)
    expect(one.amount).toBe(1_000_000)
    expect(one.currency).toBe('IRR')
  })

  it('follows a price override rather than the default', () => {
    process.env.PRICE_12M = '999000'
    expect(catalogue().find(t => t.months === 12).toman).toBe(999_000)
  })
})

describe('isTerm', () => {
  it('accepts the offered terms and nothing else', () => {
    expect(isTerm(1)).toBe(true)
    expect(isTerm(12)).toBe(true)
    expect(isTerm(2)).toBe(false)
    expect(isTerm(0)).toBe(false)
    expect(isTerm(-1)).toBe(false)
  })

  it('accepts the string a JSON body actually carries', () => {
    expect(isTerm('3')).toBe(true)
  })
})

describe('billingConfig', () => {
  it('defaults to Zarinpal in Rials, live, unconfigured', () => {
    expect(billingConfig()).toEqual({
      gateway: 'zarinpal', merchantId: null, sandbox: false, currency: 'IRR'
    })
  })

  it('upper-cases a currency given in lower case', () => {
    process.env.BILLING_CURRENCY = 'irt'
    expect(billingConfig().currency).toBe('IRT')
  })
})

describe('tiers', () => {
  it('sells the three tiers and refuses the one that is not for sale', () => {
    expect(tierCatalogue().map(t => t.tier)).toEqual(['solo', 'studio', 'pro'])
    expect(isSellableTier('solo')).toBe(true)
    // `legacy` is a real tier — it is just not one anybody can buy.
    expect(isSellableTier('legacy')).toBe(false)
    expect(isSellableTier('enterprise')).toBe(false)
    expect(isSellableTier(undefined)).toBe(false)
  })

  it('entry tier is the smallest thing on sale', () => {
    expect(ENTRY_TIER).toBe('solo')
  })

  it('quotes the cap from the domain, so the card and the enforcement cannot disagree', () => {
    expect(tierCatalogue().map(t => t.clientCap)).toEqual([5, 25, 100])
    expect(capForTier('studio')).toBe(25)
  })

  it('prices every tier at every term', () => {
    for (const { tier, terms } of tierCatalogue()) {
      expect(terms.map(t => t.months)).toEqual([1, 3, 12])
      for (const { months } of terms) expect(amountFor(months, tier)).toBeGreaterThan(0)
    }
  })

  it('gets cheaper per month as the term gets longer, in every tier', () => {
    for (const { terms } of tierCatalogue()) {
      const [one, three, year] = terms
      expect(three.perMonthToman).toBeLessThan(one.perMonthToman)
      expect(year.perMonthToman).toBeLessThan(three.perMonthToman)
    }
  })

  it('gets cheaper per client as the tier gets bigger', () => {
    // Otherwise the coach with eighty clients goes back to a spreadsheet, and is right to.
    const perClient = tierCatalogue().map(t => t.terms[0].toman / t.clientCap)
    expect(perClient[1]).toBeLessThan(perClient[0])
    expect(perClient[2]).toBeLessThan(perClient[1])
  })

  it('costs more in total as the tier gets bigger', () => {
    const monthly = tierCatalogue().map(t => t.terms[0].toman)
    expect(monthly[0]).toBeLessThan(monthly[1])
    expect(monthly[1]).toBeLessThan(monthly[2])
  })

  it('refuses a tier it has no price for rather than charging nothing', () => {
    expect(() => amountFor(1, 'legacy')).toThrow(/no price configured for legacy/)
    expect(() => amountFor(1, 'enterprise')).toThrow(/no price configured/)
  })

  it('follows a tier-specific override', () => {
    process.env.PRICE_STUDIO_3M = '888000'
    expect(catalogue('studio').find(t => t.months === 3).toman).toBe(888_000)
    // …and leaves the other tiers alone.
    expect(catalogue('pro').find(t => t.months === 3).toman).toBe(1_999_000)
  })

  it('still honours the flat price a pre-tier deployment already has set', () => {
    process.env.PRICE_1M = '111000'
    expect(amountFor(1)).toBe(1_110_000)
    expect(amountFor(1, 'solo')).toBe(1_110_000)
  })

  it('does not let that flat price leak into the tiers it never meant', () => {
    process.env.PRICE_1M = '111000'
    expect(catalogue('studio').find(t => t.months === 1).toman).toBe(349_000)
    expect(catalogue('pro').find(t => t.months === 1).toman).toBe(749_000)
  })

  it('prefers the tier-specific name when both are set', () => {
    process.env.PRICE_1M = '111000'
    process.env.PRICE_SOLO_1M = '222000'
    expect(catalogue('solo').find(t => t.months === 1).toman).toBe(222_000)
  })

  it('defaults to the entry tier when nobody says which', () => {
    expect(catalogue().every(t => t.tier === 'solo')).toBe(true)
  })
})
