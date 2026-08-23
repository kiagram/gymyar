/* Buying and renewing a coaching subscription.
 *
 * Three endpoints, and the interesting one is the callback. The other two are a read and a
 * redirect.
 *
 * ## Why the callback is a redirect target and not an API call
 *
 * The person's browser arrives here from their bank, mid-navigation, expecting a page. So this
 * route answers with a 302 into the app rather than with JSON — and it must answer with one in
 * every case, including the failures. A payer who cancelled and gets a JSON error object in
 * their address bar has been dumped out of the product with no way back in.
 *
 * It is deliberately not behind `requireUser`. The payment row says whose it is; the session
 * says whose browser this is. Those are the same person almost always, and when they are not —
 * a link opened in a different browser, a session that expired on the bank's slow page — the
 * row is the one that should win. Nothing here is credited to a session, so there is no
 * cross-account risk in that; the worst case is somebody sees a receipt for a payment that is
 * already theirs.
 *
 * ## What is trusted from the query string
 *
 * The authority, as a lookup key, and nothing else. `Status=OK` is a hint that the payer
 * finished, not evidence of payment: it is a query parameter on a URL anybody can type. The
 * only thing that credits a subscription is `verify()` answering yes for a stored amount.
 */
import {
  ensureTrial, startPayment, attachAuthority, paymentByAuthority, paymentsFor,
  credit, settleUnpaid
} from '@gymbuddy/db/billing.js'
import { entitlement } from '@gymbuddy/domain/entitlement.js'
import { requireUser } from '../session.js'
import { config } from '../config.js'
import { limit } from '../rate-limit.js'
import { entitlementFor } from '../entitlement.js'
import { billingEnabled, billingConfig, catalogue, amountFor, isTerm, gatewayFromEnv } from '../payments/pricing.js'

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status })

/** Back into the app, with an outcome the billing screen can render. */
const backTo = outcome => `${config.origin}/#/coach?billing=${outcome}`

export default async function billingRoutes(app, opts = {}) {
  // Injectable so the suite can drive the whole flow against a fake gateway. Resolved per
  // request rather than at registration: an instance that gains a merchant id on restart
  // should not need this file to have been imported afterwards.
  const gateway = () => opts.gateway ?? gatewayFromEnv()

  /**
   * What this account is entitled to, what it would cost to change that, and what it has bought.
   *
   * One call, because the upgrade screen needs all three and a screen that renders in three
   * stages as three requests land is worse than one that waits.
   */
  app.get('/api/billing/status', async req => {
    const user = await requireUser(req)
    const ent = await entitlementFor(user.id)
    return {
      enabled: billingEnabled(),
      currency: billingConfig().currency,
      sandbox: billingConfig().sandbox,
      entitlement: ent,
      terms: billingEnabled() ? catalogue() : [],
      payments: billingEnabled()
        ? (await paymentsFor(user.id, 10)).map(publicPayment)
        : []
    }
  })

  /**
   * Start a purchase: our row first, then the gateway's authority, then the redirect.
   *
   * That order matters. The row is written before anybody is sent anywhere, so a payment that
   * completes is always a payment we asked for — and an authority that arrives at the callback
   * with no row behind it is a forgery rather than a race we lost.
   */
  app.post('/api/billing/checkout', { config: limit('billing') }, async req => {
    const user = await requireUser(req)
    const gw = gateway()
    if (!gw) throw bad('this instance does not take payments', 409)

    const months = Number(req.body?.months)
    if (!isTerm(months)) throw bad('months must be one of the offered terms')

    const amount = amountFor(months)
    const payment = await startPayment({
      userId: user.id, gateway: gw.name, amount, currency: gw.currency, months
    })

    try {
      const { authority, startUrl } = await gw.request({
        amount,
        // Shown on the gateway's own page — the last thing they read before paying, so it says
        // what they are buying rather than naming an internal plan.
        description: months === 1
          ? 'GymBuddy coaching — 1 month'
          : `GymBuddy coaching — ${months} months`,
        callbackUrl: `${config.origin}/api/billing/callback`,
        email: user.email || null
      })
      await attachAuthority(payment.id, authority)
      return { startUrl, paymentId: payment.id, amount, currency: gw.currency, months }
    } catch (err) {
      // The attempt never became a redirect. Close the row now rather than leaving it for
      // reconciliation to puzzle over — nobody was ever sent anywhere to pay.
      await settleUnpaid(payment.id, 'failed', { stage: 'request', message: err.message })
      req.log?.error?.({ err }, 'payment request failed')
      // Deliberately exposed: this is the gateway being down, not a bug here, and "something
      // went wrong" would send them to support for something that fixes itself in a minute.
      throw Object.assign(new Error('could not reach the payment gateway — try again shortly'), {
        status: 502, code: 'gateway_unreachable', expose: true
      })
    }
  })

  /**
   * Where the bank sends them back. Always redirects; never renders.
   *
   * The outcomes, and why each is separate: `ok` paid, `already` paid earlier and this is the
   * second arrival of the same receipt, `cancelled` they chose not to, `failed` the gateway
   * said no, `unknown` we cannot match the authority to anything we started.
   */
  app.get('/api/billing/callback', async (req, reply) => {
    const gw = gateway()
    // Zarinpal capitalises these. Accept either, because a gateway that renames a query
    // parameter in a minor release should not silently lose everyone's money.
    const authority = req.query.Authority || req.query.authority
    const status = String(req.query.Status || req.query.status || '')

    if (!gw || !authority) return reply.redirect(backTo('unknown'))

    const payment = await paymentByAuthority(gw.name, authority)
    if (!payment) {
      req.log?.warn?.({ authority }, 'callback for an unknown authority')
      return reply.redirect(backTo('unknown'))
    }
    if (payment.status === 'paid') return reply.redirect(backTo('already'))

    if (status.toUpperCase() !== 'OK') {
      await settleUnpaid(payment.id, 'abandoned', { status })
      return reply.redirect(backTo('cancelled'))
    }

    let result
    try {
      // The stored amount, never one from the request — this is what makes a tampered callback
      // a -50 from the gateway instead of a cheap upgrade.
      result = await gw.verify({ amount: Number(payment.amount), authority })
    } catch (err) {
      // Verification is the one failure we must not resolve as "no". They may well have paid;
      // the row stays pending and reconciliation picks it up.
      req.log?.error?.({ err, authority }, 'verify failed — left pending for reconciliation')
      return reply.redirect(backTo('pending'))
    }

    if (!result.ok) {
      await settleUnpaid(payment.id, 'failed', { code: result.code, reason: result.reason })
      req.log?.warn?.({ authority, code: result.code }, 'payment not verified')
      return reply.redirect(backTo('failed'))
    }

    const { credited } = await credit({
      paymentId: payment.id, refId: result.refId, detail: result.raw ?? null
    })
    req.log?.info?.({ authority, refId: result.refId, credited }, 'payment settled')
    return reply.redirect(backTo(credited ? 'ok' : 'already'))
  })

  /**
   * Start the trial. Called the first time somebody opens the coach side.
   *
   * Idempotent by construction — a second call returns the same row rather than a second
   * fortnight, which is why the clock can be started from the UI without the UI having to
   * remember whether it already did.
   */
  app.post('/api/billing/trial', async req => {
    const user = await requireUser(req)
    if (!billingEnabled()) return { entitlement: await entitlementFor(user.id) }
    const sub = await ensureTrial(user.id)
    return { entitlement: entitlement(sub) }
  })
}

/* A payment as its payer may see it. The gateway's raw `detail` never leaves the server: it is
 * there for whoever is debugging a settlement, and it carries card fragments. */
const publicPayment = p => ({
  id: p.id,
  months: p.months,
  amount: Number(p.amount),
  currency: p.currency,
  status: p.status,
  refId: p.ref_id,
  at: p.settled_at || p.created_at
})

export { publicPayment }
