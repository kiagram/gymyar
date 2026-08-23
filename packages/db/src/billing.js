/* Subscriptions and payments. The rules are in domain/entitlement.js; this is the storage.
 *
 * The one thing worth reading before changing anything here: **crediting a payment must be
 * idempotent, and the guarantee comes from the unique index on `ref_id`, not from checking
 * first.** Zarinpal has no webhooks, so a payment is confirmed by the browser coming back to
 * a callback URL — and browsers come back twice. A refresh, a retry, a link opened on the
 * phone and again on the laptop. Every one of those runs the same verify, and Zarinpal answers
 * the second with 101 ("already verified") and the same ref_id rather than an error.
 *
 * A read-then-write check loses that race under concurrency; the index cannot. So `credit()`
 * writes first and treats the unique violation as the success it is.
 */
import { db } from './index.js'
import { extend, trialEnd } from '@gymbuddy/domain/entitlement.js'

/** Postgres' unique_violation. The only error `credit()` is allowed to swallow. */
const UNIQUE_VIOLATION = '23505'

export const subscriptionFor = (userId, s = db()) =>
  s`select * from subscriptions where user_id = ${userId}`.then(r => r[0] || null)

/** Subscriptions for several users at once, as a Map — the roster needs one query, not N. */
export async function subscriptionsFor(userIds, s = db()) {
  if (!userIds.length) return new Map()
  const rows = await s`select * from subscriptions where user_id = any(${userIds})`
  return new Map(rows.map(r => [r.user_id, r]))
}

/**
 * Start this user's trial, if they have never had one.
 *
 * Called when somebody first acts as a coach rather than when they sign up: a trial that
 * expires before you have opened the feature is not a trial, it is a countdown you lost. Doing
 * nothing to an existing row is the point — this runs on every invite, and a second call must
 * not hand out a second trial.
 */
export async function ensureTrial(userId, s = db(), now = Date.now()) {
  const [row] = await s`
    insert into subscriptions (user_id, trial_ends_at)
    values (${userId}, ${trialEnd(now)})
    on conflict (user_id) do nothing
    returning *`
  // `do nothing` returns nothing on conflict, which is the point — the existing row is not
  // touched, so this stays a read for everyone who already has one.
  return row || await subscriptionFor(userId, s)
}

/**
 * Record an attempt, before the person is sent to the gateway.
 *
 * Written first and deliberately: the row is what a callback is matched against, and a payment
 * we have no record of asking for is one we cannot safely credit.
 */
export async function startPayment({ userId, gateway, amount, currency, months }, s = db()) {
  const [row] = await s`
    insert into payments (user_id, gateway, amount, currency, months)
    values (${userId}, ${gateway}, ${amount}, ${currency}, ${months})
    returning *`
  return row
}

/** The gateway's handle for the attempt, once it has minted one. */
export async function attachAuthority(paymentId, authority, s = db()) {
  const [row] = await s`
    update payments set authority = ${authority} where id = ${paymentId} returning *`
  return row
}

export const paymentByAuthority = (gateway, authority, s = db()) =>
  s`select * from payments where gateway = ${gateway} and authority = ${authority}`
    .then(r => r[0] || null)

export const paymentsFor = (userId, limit = 20, s = db()) =>
  s`select * from payments where user_id = ${userId} order by created_at desc limit ${limit}`

/**
 * Credit a verified payment: mark it paid and push the subscription's date out.
 *
 * Returns `{ credited, payment, subscription }`. `credited: false` means this receipt had
 * already been applied — not a failure, and the caller should show the same success it would
 * have shown the first time. Anything else and the person sees an error for money that left
 * their account.
 *
 * One transaction, because a payment marked paid without the months attached is worse than
 * either half alone: it looks settled to us and looks stolen to them.
 */
export async function credit({ paymentId, refId, detail = null, now = Date.now() }, s = db()) {
  try {
    return await s.begin(async tx => {
      const [payment] = await tx`
        update payments
        set status = 'paid', ref_id = ${refId}, settled_at = now(), detail = ${tx.json(detail)}
        where id = ${paymentId} and status <> 'paid'
        returning *`
      // Already paid — same receipt arriving twice, or two callbacks racing. Not an error.
      if (!payment) return { credited: false, payment: await byId(paymentId, tx), subscription: null }

      const current = await tx`
        select paid_through from subscriptions where user_id = ${payment.user_id} for update`
      const paidThrough = extend(current[0]?.paid_through ?? null, payment.months, now)

      const [subscription] = await tx`
        insert into subscriptions (user_id, paid_through)
        values (${payment.user_id}, ${paidThrough})
        on conflict (user_id) do update
          set paid_through = ${paidThrough}, updated_at = now()
        returning *`
      return { credited: true, payment, subscription }
    })
  } catch (err) {
    // The ref_id index fired: this receipt is already on another row. Whoever got there first
    // did the crediting, and doing it again would be the bug the index exists to prevent.
    if (err.code === UNIQUE_VIOLATION) {
      return { credited: false, payment: await byId(paymentId), subscription: null }
    }
    throw err
  }
}

const byId = (id, s = db()) =>
  s`select * from payments where id = ${id}`.then(r => r[0] || null)

/** The attempt did not become money. `status` separates "they said no" from "nobody came back". */
export async function settleUnpaid(paymentId, status, detail = null, s = db()) {
  if (status !== 'failed' && status !== 'abandoned') throw new Error(`not an unpaid status: ${status}`)
  const [row] = await s`
    update payments
    set status = ${status}, settled_at = now(), detail = ${s.json(detail)}
    where id = ${paymentId} and status = 'pending'
    returning *`
  return row || null
}

/**
 * Attempts still pending after `minutes`, oldest first.
 *
 * These are the ones to reconcile against the gateway: with no webhook, a person who paid and
 * then closed the tab has money gone and nothing to show for it, and this query is the only
 * way anyone finds out. A gateway attempt does not stay live indefinitely, so anything much
 * older than the window is a candidate to mark abandoned rather than to chase.
 */
export const stalePayments = ({ minutes = 15, limit = 200 } = {}, s = db()) => s`
  select * from payments
  where status = 'pending' and created_at < now() - make_interval(mins => ${minutes})
  order by created_at asc
  limit ${limit}`

/** Admin-side: set a paid-through date directly. For refunds, comps and support fixes. */
export async function setPaidThrough(userId, paidThrough, s = db()) {
  const [row] = await s`
    insert into subscriptions (user_id, paid_through)
    values (${userId}, ${paidThrough})
    on conflict (user_id) do update set paid_through = ${paidThrough}, updated_at = now()
    returning *`
  return row
}
