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
