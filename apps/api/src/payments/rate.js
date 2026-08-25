/* What a Toman is worth, and what that does to a price list.
 *
 * ## The problem this exists for
 *
 * Prices here are quoted in Toman, because that is the number an Iranian coach recognises. But
 * the costs behind them are not in Toman — model tokens, hosting, an exercise-media licence —
 * and the rial has been falling against all of them. In the week this file was written the
 * open-market dollar went from roughly 186,500 Toman to 203,200, about nine percent, and the
 * placeholder annual term in `pricing.js` was worth a little over six dollars for a year of
 * service at the end of it.
 *
 * A fixed Toman price is therefore not a price. It is a slow discount that nobody approved,
 * applied hardest to whoever commits longest — which is exactly backwards from what a longer
 * term is supposed to reward.
 *
 * ## What it does instead
 *
 * The price list stays in Toman and gains an index. Two numbers say what the list is worth:
 * the rate it was *written* at, and the rate *today*. Their ratio scales every price, so the
 * list holds its value in the currency the costs are in without anybody editing it.
 *
 * With neither number configured the multiplier is exactly 1 and every price is what it was
 * before this file existed. That is the supported state for a self-hosted instance with no
 * gateway, and it is what keeps an upgrade from silently repricing a running deployment.
 *
 * ## Why nothing here fetches anything
 *
 * A checkout that depends on an outbound HTTP call is a checkout that fails when a rate
 * service is down, blocked, or slow — and this one runs in a country where all three are
 * ordinary. So the rate is *configuration*: read from the environment, set by whoever is
 * running the instance, on whatever cadence they choose. A background job may write it later;
 * the shape here does not change if one does.
 *
 * ## Staleness is a real state, not a warning
 *
 * A rate nobody has updated in a month is not a rate. The dangerous thing to do with one is
 * sell a *year* at it — that locks in a stale number for twelve months and there is no way
 * back. Selling a *month* at it risks one month, which is recoverable.
 *
 * So a stale rate does not stop the sale and does not revert to the old prices, which would be
 * further from the truth rather than closer to it. It withdraws the long terms and leaves the
 * shortest one standing. The exposure becomes bounded instead of compounding, and it does so
 * on its own, without anybody noticing in time.
 */

const num = v => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** How old a rate may be before only the shortest term is offered. */
export const maxAgeDays = () => num(process.env.RATE_MAX_AGE_DAYS) ?? 7

/* A configured rate that implies the price list should move by more than this is a typo, not a
 * currency. Nothing legitimate moves a price list by fifty times, and charging somebody fifty
 * times is the kind of mistake that ends an instance's reputation whatever the refund policy
 * says. Outside these bounds the index is ignored — prices stay as written, and terms are
 * restricted the same way a stale rate restricts them, because in both cases the honest
 * statement is "this instance does not currently know what its prices are worth". */
const MULTIPLIER_MIN = 0.2
const MULTIPLIER_MAX = 50

const DAY = 86400000

/**
 * The price index, as everything downstream sees it.
 *
 * Read on every call rather than frozen at import, for the same reason `billingConfig()` is:
 * a rate changes under a running server, which is the entire point of it.
 *
 * - `multiplier` — what to scale a written price by. Always a positive number; 1 means "no
 *   index configured, or one that could not be trusted", and both of those mean the same thing
 *   to a caller.
 * - `stale` — the rate is indexed but nobody has said when it was true, or it was true too
 *   long ago. Callers restrict the terms they offer; they do not refuse the sale.
 * - `usable` — indexed, fresh, and plausible. The only state in which the index is doing the
 *   job it was added for.
 */
export function priceIndex(now = Date.now()) {
  const toman = num(process.env.TOMAN_PER_USD)
  const baseline = num(process.env.PRICE_BASELINE_TOMAN_PER_USD)
  const atRaw = process.env.TOMAN_PER_USD_AT
  const at = atRaw ? new Date(atRaw) : null
  const validAt = at && !Number.isNaN(at.getTime()) ? at : null

  const indexed = toman != null && baseline != null
  const raw = indexed ? toman / baseline : 1
  /* An implausible ratio is treated as no ratio rather than clamped. Clamping would charge a
   * number nobody chose and look deliberate doing it. */
  const plausible = raw >= MULTIPLIER_MIN && raw <= MULTIPLIER_MAX

  const ageDays = validAt ? Math.max(0, (now - validAt.getTime()) / DAY) : null
  /* No timestamp counts as stale. "We have a rate but will not say when it was true" is not a
   * stronger claim than having no rate at all. */
  const expired = indexed && (ageDays == null || ageDays > maxAgeDays())

  return {
    toman,
    baseline,
    at: validAt,
    ageDays: ageDays == null ? null : Math.floor(ageDays),
    indexed,
    implausible: indexed && !plausible,
    stale: expired || (indexed && !plausible),
    usable: indexed && plausible && !expired,
    multiplier: indexed && plausible ? raw : 1
  }
}

/**
 * Scale a written price and round it to something a person would recognise.
 *
 * To the nearest thousand Toman, and upward at the halfway point, because a price list that
 * rounds down by default is one that loses a little on every line for no reason anybody chose.
 * Below a thousand there is nothing to round to, so the floor is one thousand rather than zero
 * — a price of zero is a free subscription sold by a rounding rule.
 */
export function indexed(toman, now = Date.now()) {
  const { multiplier } = priceIndex(now)
  if (multiplier === 1) return toman
  return Math.max(1000, Math.round((toman * multiplier) / 1000) * 1000)
}

/**
 * Which of `terms` this instance is currently willing to sell.
 *
 * Everything, unless the index has gone stale — then the shortest term only. An instance that
 * has never configured an index is not stale; it has simply never made the claim, and it keeps
 * selling exactly what it sold yesterday.
 */
export function offeredTerms(terms, now = Date.now()) {
  if (!priceIndex(now).stale) return [...terms]
  return [Math.min(...terms)]
}
