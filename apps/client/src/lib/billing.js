/* Subscriptions, client side.
 *
 * Like the rest of coaching, none of this touches the sync engine — a subscription is an
 * account fact, read fresh when a screen opens. It is never part of the state a phone carries
 * offline, because the one question it answers ("may I do this?") is answered by the server at
 * the moment of asking anyway.
 */
import { api } from './api.js'
import { t, getLang, dateLocale } from './i18n.js'

export const fetchBilling = () => api('/api/billing/status')

export const startTrial = () => api('/api/billing/trial', { method: 'POST', body: '{}' })

/**
 * Buy or renew, and leave.
 *
 * The gateway owns the next screen: a full navigation, not a popup and not an iframe. Banks
 * break out of frames, and a popup on iOS Safari is a blocked window and a person who thinks
 * the button is broken.
 */
export async function checkout(months) {
  const { startUrl } = await api('/api/billing/checkout', {
    method: 'POST', body: JSON.stringify({ months })
  })
  window.location.href = startUrl
}

/* ------------------------------------------------------------- rendering ---- */

/**
 * A price, in the reader's digits.
 *
 * Prices come from the server in Toman — the unit an Iranian customer thinks in, even though
 * the gateway settles in Rials — so this formats what was quoted rather than converting
 * anything. `toLocaleString` is what makes ۱۴۹٬۰۰۰ out of 149000 under `fa-IR`, which is the
 * difference between a price and a number somebody has to decode.
 */
export const fmtToman = n => t('{0} T', Number(n).toLocaleString(dateLocale()))

/** A date, spelled out — Jalali under fa-IR, because that is what `dateLocale()` resolves to. */
export const fmtUntil = iso => iso
  ? new Date(iso).toLocaleDateString(dateLocale(), { year: 'numeric', month: 'long', day: 'numeric' })
  : ''

/**
 * What to say about an entitlement, and how loudly.
 *
 * One place rather than a conditional per screen, because the same five states are described
 * on the roster, in the subscription screen and in whatever refused an action — and three
 * screens disagreeing about whether a trial has "ended" or "run out" reads as three bugs.
 *
 * `tone` is what the caller colours with: `ok` needs no attention, `warn` needs some soon,
 * `stop` means something is already refused.
 */
export function describeEntitlement(ent) {
  if (!ent) return null
  const { state, daysLeft, until } = ent

  switch (state) {
    // No gateway on this instance. There is nothing to say and nothing to sell.
    case 'unbilled':
      return null
    case 'active':
      return {
        tone: daysLeft != null && daysLeft <= 7 ? 'warn' : 'ok',
        title: t('Subscription active'),
        detail: t('Runs until {0}.', fmtUntil(until))
      }
    case 'trial':
      return {
        tone: daysLeft != null && daysLeft <= 3 ? 'warn' : 'ok',
        title: daysLeft === 1 ? t('Trial ends tomorrow') : t('{0} days left in your trial', daysLeft),
        detail: t('Everything on the coach side works until {0}.', fmtUntil(until))
      }
    case 'grace':
      return {
        tone: 'warn',
        title: t('Your subscription has lapsed'),
        detail: t('You can still read and message your clients for {0} more days, but not propose programmes or take on anyone new.', daysLeft)
      }
    case 'expired':
      return {
        tone: 'stop',
        title: t('Subscription ended'),
        detail: t('Your clients keep their training and lose nothing. Renew to start coaching them again.')
      }
    case 'none':
    default:
      return {
        tone: 'stop',
        title: t('No subscription'),
        detail: t('Coaching needs one. Your own training does not, and never will.')
      }
  }
}

/**
 * What a checkout came back as. The `?billing=` on the URL the gateway sent them to.
 *
 * `pending` is the honest one and the reason this is a table rather than an if: we asked the
 * gateway and could not get an answer, so telling them it failed would be a lie about their
 * money. It says we are checking, because we are.
 */
export const CHECKOUT_OUTCOMES = {
  ok: () => ({ tone: 'ok', message: t('Payment received — your subscription is active.') }),
  already: () => ({ tone: 'ok', message: t('That payment was already applied.') }),
  cancelled: () => ({ tone: 'warn', message: t('Payment cancelled. You have not been charged.') }),
  failed: () => ({ tone: 'stop', message: t('The payment did not go through. You have not been charged.') }),
  pending: () => ({ tone: 'warn', message: t('We could not confirm the payment yet. If it went through, it will be applied shortly — do not pay again.') }),
  unknown: () => ({ tone: 'stop', message: t('We could not match that payment. If money left your account, contact support with the date and amount.') })
}

export const readOutcome = key => (CHECKOUT_OUTCOMES[key] ? CHECKOUT_OUTCOMES[key]() : null)

/** Did this request fail because nobody has paid? */
export const isPaymentRequired = err => err?.status === 402 || err?.code === 'payment_required'

/* Payment statuses, for the receipts list. Keyed to what the database stores. */
export const PAYMENT_STATUS = {
  paid: () => t('Paid'),
  pending: () => t('Awaiting confirmation'),
  failed: () => t('Failed'),
  abandoned: () => t('Cancelled')
}

/** How long a term is, said the way a person would say it. */
export const termLabel = months =>
  months === 1 ? t('1 month') : months === 12 ? t('1 year') : t('{0} months', months)
