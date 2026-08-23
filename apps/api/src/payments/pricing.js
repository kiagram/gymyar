/* What a coach subscription costs, and which gateway takes the money.
 *
 * Prices are environment, not code. They change for reasons that have nothing to do with this
 * repository — a competitor moves, the rial moves, someone runs a promotion — and a price in a
 * source file is a price that needs a deploy and a code review to change. The defaults below
 * are **placeholders**: plausible, round, and not a recommendation. Set real ones before taking
 * a real payment.
 *
 * The terms come from the domain (`TERMS`), so the thing offered and the thing credited cannot
 * drift apart. Longer terms are cheaper per month because the alternative — the same monthly
 * rate for a year up front — gives nobody a reason to commit.
 */
import { TERMS } from '@gymbuddy/domain/entitlement.js'
import { zarinpal } from './zarinpal.js'

const bool = v => /^(1|true|yes|on)$/i.test(v || '')

/**
 * Placeholder monthly prices, in **Toman**, per term.
 *
 * Iranian prices are quoted in Toman even though the gateway settles in Rials, so this is the
 * number a person would recognise; `amountFor` does the conversion once, at the edge.
 */
const DEFAULT_PRICES = {
  1: 149_000,     // one month
  3: 399_000,     // ~11% off
  12: 1_290_000   // ~28% off
}

const priceFor = months =>
  Number(process.env['PRICE_' + months + 'M'] || DEFAULT_PRICES[months])

/** Rials per Toman. Not a rate — a definition, and it has never been anything else. */
const RIALS_PER_TOMAN = 10

/**
 * Read on every call rather than frozen at import.
 *
 * Not a style choice: `config.js` snapshots its environment because a port cannot change under
 * a running server, but this is read by tests that need to stand up a billed instance and an
 * unbilled one in the same process, and by a deployment that gains a merchant id without
 * anybody thinking about module load order. A getter costs nothing here.
 */
export const billingConfig = () => ({
  gateway: (process.env.PAYMENT_GATEWAY || 'zarinpal').toLowerCase(),
  merchantId: process.env.ZARINPAL_MERCHANT_ID || null,
  sandbox: bool(process.env.ZARINPAL_SANDBOX),
  /* What the gateway is sent. IRR is what a Zarinpal terminal expects by default; if yours is
   * configured in Toman set this to IRT and the amounts stop being multiplied. */
  currency: (process.env.BILLING_CURRENCY || 'IRR').toUpperCase()
})

/** Is there enough configuration here to charge anybody? */
export function billingEnabled() {
  const c = billingConfig()
  return c.gateway === 'zarinpal' && !!c.merchantId
}

/**
 * The amount to send the gateway for `months`, in minor units of the configured currency.
 *
 * Integer by construction: a fractional Rial is not a thing, and a gateway handed a float
 * rounds it somewhere you cannot see.
 */
export function amountFor(months) {
  const toman = priceFor(months)
  if (!Number.isFinite(toman) || toman <= 0) throw new Error('no price configured for ' + months + ' months')
  return billingConfig().currency === 'IRT' ? Math.round(toman) : Math.round(toman) * RIALS_PER_TOMAN
}

/** The terms on offer, priced — this is what the upgrade screen renders. */
export const catalogue = () => TERMS.map(months => ({
  months,
  toman: priceFor(months),
  amount: amountFor(months),
  currency: billingConfig().currency,
  perMonthToman: Math.round(priceFor(months) / months)
}))

export const isTerm = months => TERMS.includes(Number(months))

/**
 * The configured gateway, or null when billing is off.
 *
 * Null is a supported state, not a broken one: a self-hosted instance has nobody to bill, and
 * the coaching features are simply free there. See `routes/billing.js` for what that means at
 * the door.
 */
export function gatewayFromEnv(overrides = {}) {
  if (!billingEnabled()) return null
  const c = billingConfig()
  return zarinpal({
    merchantId: c.merchantId,
    sandbox: c.sandbox,
    currency: c.currency,
    ...overrides
  })
}
