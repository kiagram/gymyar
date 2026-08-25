/* Who has paid for what, expressed as rules rather than as checks scattered through routes.
 *
 * The product's shape: **training alone is free, and stays free.** Everything openGym did — log
 * a set, follow a programme, watch a number go up — costs nothing and is not gated here or
 * anywhere. What is paid for is *coaching*: having a roster, proposing programmes to it, and
 * talking to it.
 *
 * ## Only the coach is charged
 *
 * A coach is running a business on this; their clients are not. So a client is never gated —
 * not to accept a proposal, not to read a thread, not to share a scope. A person being coached
 * pays nothing and notices nothing, which also means a coach whose subscription lapses cannot
 * take their clients' training away. It was never the coach's to take: a client's rows are the
 * client's own, written through their own sync, and they keep working whatever this file says.
 *
 * ## A paid-through date, not a recurring state machine
 *
 * Iranian gateways do not do card-on-file recurring billing — there is no subscription object
 * upstream that flips itself to `past_due`, and no webhook to hear it from. What there is: a
 * person pays for some number of months, and that buys a date. Every rule here is a comparison
 * against `paid_through`, and renewing stacks onto whatever is left rather than burning it, so
 * paying early is never punished.
 *
 * That also makes the whole thing testable with a clock and nothing else, which is why these
 * rules live in the domain and the gateway lives at the edge.
 */

/** A new coach gets this long to find out whether the thing works before paying for it. */
export const TRIAL_DAYS = 14

/**
 * After a subscription runs out, this long where nothing changes.
 *
 * A card that failed at 3am should not be indistinguishable from a decision to stop. The grace
 * window is what makes "I forgot" and "I quit" different outcomes, and it costs a week.
 */
export const GRACE_DAYS = 7

const DAY = 86400000

/** The terms on offer. Longer terms are cheaper per month; the prices themselves are config. */
export const TERMS = [1, 3, 12]

/**
 * The sizes a coaching subscription comes in.
 *
 * A seat is worth roughly what the book behind it is worth, and a coach with four clients and
 * a coach with eighty are not running the same business. One flat price charges them the same
 * thing, which means the small coach is priced out and the large one is underpriced — and it
 * also means revenue cannot grow with a coach's practice, which is the part that matters to
 * whoever is paying for the servers.
 *
 * `clientCap` is data on the tier rather than a number written into a check somewhere, so the
 * thing offered and the thing enforced cannot drift apart. Same reason `TERMS` lives here and
 * not in the pricing module: the catalogue and the credit have to agree, and the only way to
 * guarantee that is for there to be one of them.
 *
 * **`legacy` is not for sale.** It is what everybody who bought before tiers existed keeps —
 * unlimited, because unlimited is what they were sold. A trialling coach who has never bought
 * anything is on it too: there is no purchase to name a tier after, and capping a trial at the
 * smallest tier would make the trial a worse product than the thing it is advertising.
 *
 * A null `clientCap` is unlimited, and is deliberately not spelled `Infinity` — this value is
 * written to a nullable integer column and read back from one, and a sentinel that survives
 * that round trip beats one that turns into `null` on the way through anyway.
 */
export const TIERS = [
  { id: 'legacy', clientCap: null, purchasable: false },
  { id: 'solo',   clientCap: 5,    purchasable: true },
  { id: 'studio', clientCap: 25,   purchasable: true },
  { id: 'pro',    clientCap: 100,  purchasable: true }
]

/**
 * What an unnamed tier means.
 *
 * Used where a tier is structurally absent rather than unknown — a subscription row created by
 * starting a trial, an instance with no gateway at all. Both of those are uncapped, and both
 * would be misrepresented by naming a tier nobody bought.
 */
export const DEFAULT_TIER = 'legacy'

/** The tiers a person can actually buy, in the order the billing screen should show them. */
export const PURCHASABLE_TIERS = TIERS.filter(t => t.purchasable)

export const isTier = id => TIERS.some(t => t.id === id)

export const isPurchasableTier = id => PURCHASABLE_TIERS.some(t => t.id === id)

/** The tier row, or null. Callers that need a definite answer should say which default they want. */
export const tierFor = id => TIERS.find(t => t.id === id) ?? null

/**
 * How many clients this tier permits — null for unlimited.
 *
 * An unknown tier is unlimited rather than zero. That direction is chosen on purpose: a tier
 * name this build does not recognise means a row written by a newer version or a value nobody
 * anticipated, and the failure mode of guessing generously is a coach who takes on a client
 * they should have paid for. The failure mode of guessing meanly is a paying coach locked out
 * of their own business by a deploy. Only one of those is worth having.
 */
export const capFor = id => (tierFor(id)?.clientCap ?? null)

/** The next tier up, for an error that wants to offer a way out rather than just a wall. */
export function nextTierAfter(id) {
  const cap = capFor(id)
  if (cap == null) return null            // already unlimited — there is nothing above it
  return PURCHASABLE_TIERS.find(t => t.clientCap != null && t.clientCap > cap) ?? null
}

/**
 * How much room a subscription has left, given how many clients it is already carrying.
 *
 * The cap is read off the subscription row rather than looked up from the tier, because the
 * row is where the promise lives — see migration 003. A null cap is unlimited, which covers
 * three real cases and not one of them is an error: a coach who bought before tiers existed,
 * a coach still in their trial, and an instance with no gateway configured at all.
 *
 * This is separate from `CAN` on purpose. Whether a coach may take clients *at all* is a
 * property of their subscription state and nothing else, which is what makes `CAN` a plain
 * lookup table. How many they may take is a property of the state *and* a count that has to
 * be gone and fetched. Folding the second into the first would mean every capability check
 * anywhere paid for a `count(*)` it did not need.
 */
export function capacity(sub, used = 0) {
  const cap = sub?.client_cap ?? null
  const unlimited = cap == null
  return {
    cap,
    used,
    tier: sub?.tier ?? DEFAULT_TIER,
    remaining: unlimited ? null : Math.max(0, cap - used),
    /* At the cap counts as full, not over it. A coach holding exactly their five may not take
     * a sixth — and `>=` rather than `===` is what keeps that true for somebody who is over
     * the line already, which is what a downgrade leaves behind. */
    full: !unlimited && used >= cap
  }
}

const ms = v => (v == null ? null : v instanceof Date ? v.getTime() : new Date(v).getTime())
const latest = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b))

/**
 * Add whole calendar months, clamping rather than overflowing.
 *
 * Paying on the 31st buys you the 28th of a short month, not the 3rd of the month after. The
 * naive `setMonth` does the latter silently, which reads as a rounding bug to whoever notices
 * and as a free extra week to whoever does not.
 */
export function addMonths(from, months) {
  const d = new Date(from)
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + months)
  d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())))
  return d
}

const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate()

/**
 * What a successful payment for `months` moves the paid-through date to.
 *
 * Stacked on whatever is left, so renewing with three weeks in hand keeps the three weeks. A
 * date already in the past is not something to stack on — that time is gone — so the term
 * starts from now instead.
 */
export const extend = (paidThrough, months, now = Date.now()) =>
  addMonths(Math.max(now, ms(paidThrough) ?? 0), months)

/**
 * Read a subscription row into the state the rest of the app reasons about.
 *
 * `sub` is `{ trial_ends_at, paid_through }` or nothing at all — a user who has never coached
 * has no row, and that is `none` rather than an error.
 */
export function entitlement(sub, now = Date.now()) {
  const trial = ms(sub?.trial_ends_at)
  const paid = ms(sub?.paid_through)
  const ends = latest(trial, paid)

  let state, until
  if (paid != null && paid > now) { state = 'active'; until = paid }
  else if (trial != null && trial > now) { state = 'trial'; until = trial }
  else if (ends == null) { state = 'none'; until = null }
  else if (now < ends + GRACE_DAYS * DAY) { state = 'grace'; until = ends + GRACE_DAYS * DAY }
  else { state = 'expired'; until = null }

  return {
    state,
    until: until == null ? null : new Date(until),
    // Rounded up: a subscription with six hours left has one day left, not zero.
    daysLeft: until == null ? null : Math.max(0, Math.ceil((until - now) / DAY)),
    everPaid: paid != null,
    can: CAN[state]
  }
}

/**
 * What each state permits on the coach side.
 *
 * Reading survives everything. A coach who stopped paying can still open the roster they built
 * and the conversations they had — locking someone out of their own history is a way to make
 * them angry, not a way to make them pay. What stops is *growth and authorship*: no new
 * clients, and no new programmes pushed at the ones they have.
 *
 * Grace keeps messaging on, because the alternative is a coach who cannot answer "why can't I
 * see my new programme?" during the exact week they most need to.
 */
const ALL = { readRoster: true, message: true, propose: true, takeClients: true }
const CAN = {
  active: ALL,
  trial: ALL,
  grace: { readRoster: true, message: true, propose: false, takeClients: false },
  expired: { readRoster: true, message: false, propose: false, takeClients: false },
  none: { readRoster: true, message: false, propose: false, takeClients: false }
}

/** The capability names, so a caller cannot gate on a typo that silently reads as `undefined`. */
export const CAPABILITIES = Object.keys(ALL)

/** Does this subscription permit `capability` right now? */
export function allows(sub, capability, now = Date.now()) {
  if (!CAPABILITIES.includes(capability)) throw new Error(`unknown capability: ${capability}`)
  return entitlement(sub, now).can[capability] === true
}

/** When a trial should end for someone starting one now. */
export const trialEnd = (now = Date.now()) => new Date(now + TRIAL_DAYS * DAY)
