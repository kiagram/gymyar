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
import { TERMS, PURCHASABLE_TIERS, isPurchasableTier, capFor } from '@gymyar/domain/entitlement.js'
import { zarinpal } from './zarinpal.js'
import { priceIndex, indexed, offeredTerms } from './rate.js'

const bool = v => /^(1|true|yes|on)$/i.test(v || '')

/**
 * The tier a price is for when nobody said.
 *
 * The smallest thing on sale, which is also what the single flat price in the previous version
 * of this file was — so a deployment that upgrades without touching its environment keeps
 * charging exactly what it charged yesterday, for the tier that most resembles what it was
 * selling. Note this is *not* the domain's `DEFAULT_TIER`: that one is `legacy`, which is what
 * an unbought subscription is, and an unbought subscription has no price by definition.
 */
export const ENTRY_TIER = PURCHASABLE_TIERS[0].id

/**
 * Placeholder monthly prices, in **Toman**, per tier and term.
 *
 * Iranian prices are quoted in Toman even though the gateway settles in Rials, so this is the
 * number a person would recognise; `amountFor` does the conversion once, at the edge.
 *
 * Two shapes are deliberate. Across a row, longer terms are cheaper per month, because the
 * same monthly rate for a year up front gives nobody a reason to commit. Down a column, a tier
 * costs less per client than the one below it, because a coach with eighty clients who is
 * charged twenty times the five-client price will go back to a spreadsheet and be right to.
 *
 * Still placeholders, and now placeholders in a currency that moved nine percent in the week
 * they were written. Set real ones before taking a real payment, and see T1.3 for why a number
 * frozen in Toman is a number that quietly becomes free.
 */
const DEFAULT_PRICES = {
  solo:   { 1: 149_000, 3: 399_000,   12: 1_290_000 },   // 5 clients
  studio: { 1: 349_000, 3: 939_000,   12: 2_990_000 },   // 25
  pro:    { 1: 749_000, 3: 1_999_000, 12: 6_490_000 }    // 100
}

/**
 * Look up one price, most specific environment variable first.
 *
 * `PRICE_SOLO_1M` is the tier-aware name. `PRICE_1M` is what deployments configured before
 * tiers existed already have set, and it still works — for the entry tier only, because that
 * is the only tier it could possibly have meant.
 */
const writtenPrice = (tier, months) => {
  const specific = process.env[`PRICE_${tier.toUpperCase()}_${months}M`]
  const inherited = tier === ENTRY_TIER ? process.env[`PRICE_${months}M`] : undefined
  return Number(specific || inherited || DEFAULT_PRICES[tier]?.[months])
}

/* The written price, moved by whatever the rial has done since it was written. With no index
 * configured this is the written price unchanged — see rate.js for why that is the default. */
const priceFor = (tier, months) => indexed(writtenPrice(tier, months))

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
export function amountFor(months, tier = ENTRY_TIER) {
  const toman = priceFor(tier, months)
  if (!Number.isFinite(toman) || toman <= 0) {
    throw new Error(`no price configured for ${tier} at ${months} months`)
  }
  return billingConfig().currency === 'IRT' ? Math.round(toman) : Math.round(toman) * RIALS_PER_TOMAN
}

/**
 * The terms on offer for one tier, priced — one row of the upgrade screen's grid.
 *
 * `offeredTerms` and not `TERMS`, because a stale rate withdraws the long ones. A term that is
 * not sellable must not be rendered as a price card: the refusal belongs at the point where
 * the list is built, not as an error after somebody has chosen.
 */
export const catalogue = (tier = ENTRY_TIER) => offeredTerms(TERMS).map(months => ({
  tier,
  months,
  toman: priceFor(tier, months),
  amount: amountFor(months, tier),
  currency: billingConfig().currency,
  perMonthToman: Math.round(priceFor(tier, months) / months)
}))

/**
 * Every tier a person can buy, each with its terms priced. The whole grid.
 *
 * `clientCap` rides along from the domain rather than being restated here, so the number shown
 * on the price card is the same number that will be written onto the subscription row and
 * later enforced. Three copies of that integer is two too many.
 */
export const tierCatalogue = () => PURCHASABLE_TIERS.map(t => ({
  tier: t.id,
  clientCap: t.clientCap,
  terms: catalogue(t.id)
}))

/** Is this one of the terms the domain will credit? Says nothing about whether we sell it. */
export const isTerm = months => TERMS.includes(Number(months))

/**
 * Is this a term this instance will sell *right now*?
 *
 * The gate at checkout, and deliberately narrower than `isTerm`. A stale rate takes the annual
 * term off the price list; without this it would still be buyable by anybody who posted
 * `months: 12` at the endpoint directly, which is the whole exposure the withdrawal exists to
 * close.
 */
export const isOfferedTerm = months => offeredTerms(TERMS).includes(Number(months))

/** What the price list is currently indexed at, for the billing screen and the admin one. */
export { priceIndex }

/** Can this instance sell `tier`? `legacy` is a tier and is not one of these. */
export const isSellableTier = tier => isPurchasableTier(String(tier || ''))

/** What a purchase of `tier` promises, copied onto the subscription at credit time. */
export const capForTier = tier => capFor(tier)

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
