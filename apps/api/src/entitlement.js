/* The gate, as a route guard. The rules it enforces are in domain/entitlement.js.
 *
 * ## Billing off means everything is free
 *
 * This is the first check in every function here and it is not a convenience. GymBuddy is AGPL
 * and meant to be self-hosted; somebody running it on a machine in their flat for themselves
 * and four friends has no gateway configured, nobody to charge, and no business being told to
 * upgrade. With `ZARINPAL_MERCHANT_ID` unset the coach features are simply free, exactly as
 * they were before this file existed.
 *
 * So the paid tier is a property of *this deployment*, not of the software. That is also the
 * only honest reading of the licence: we can charge for hosting, not for the code.
 *
 * ## 402, not 403
 *
 * A refusal from here is "you have not paid for this", which is a different thing from "this is
 * not yours" and needs a different screen. 403 already means the second throughout the coaching
 * routes — asking about a client who is not yours — and collapsing the two would put a
 * pay-to-continue prompt in front of people who need an error message instead.
 */
import { entitlement } from '@gymbuddy/domain/entitlement.js'
import { subscriptionFor, ensureTrial } from '@gymbuddy/db/billing.js'
import { billingEnabled } from './payments/pricing.js'

/** Everything allowed, which is what an instance with no gateway hands out. */
const UNGATED = {
  state: 'unbilled',
  until: null,
  daysLeft: null,
  everPaid: false,
  can: { readRoster: true, message: true, propose: true, takeClients: true }
}

/** This user's entitlement, as the rest of the API sees it. */
export async function entitlementFor(userId) {
  if (!billingEnabled()) return UNGATED
  return entitlement(await subscriptionFor(userId))
}

/**
 * Route guard: throw unless this user may do `capability` right now.
 *
 * The thrown error carries `code: 'payment_required'` and the entitlement itself, so the client
 * can render the right prompt — a trial that ran out, a subscription in its grace week, and an
 * account that never paid want three different sentences and only one of them is urgent.
 *
 * `startTrial` is for the coach side, and it is what makes the trial begin the first time
 * somebody actually coaches rather than the day they signed up. A fortnight that elapsed while
 * the feature sat unopened is not a trial, it is a countdown they were never told about. The
 * write happens once, on the first coach action of that account's life, and never again.
 */
export async function requireCapability(userId, capability, { startTrial = false } = {}) {
  if (!billingEnabled()) return UNGATED

  let sub = await subscriptionFor(userId)
  if (!sub && startTrial) sub = await ensureTrial(userId)

  const ent = entitlement(sub)
  if (ent.can[capability] === true) return ent
  throw Object.assign(new Error('this needs an active coaching subscription'), {
    status: 402,
    code: 'payment_required',
    // Carried through by the error handler. Which state the refusal came from decides which
    // screen the client shows, and there is no way to work it out from a bare 402.
    details: { state: ent.state, until: ent.until, daysLeft: ent.daysLeft, capability }
  })
}

/** The coach-side guard: the same check, with the trial clock started on first use. */
export const requireCoach = (userId, capability) =>
  requireCapability(userId, capability, { startTrial: true })

export { UNGATED }
