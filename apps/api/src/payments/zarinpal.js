/* Zarinpal, in one file and one fetch. No SDK, for the same reason the model adapter has none:
 * the surface is three POSTs and a redirect, and a dependency in front of it would be more code
 * than the thing it wraps.
 *
 * ## The shape of the flow, and what it costs us
 *
 *   1. `request()`  — we tell Zarinpal an amount; it mints an *authority*, its handle for the
 *                     attempt. We store it, then send the person to `startUrl`.
 *   2. they pay     — on their bank's page, entirely outside this process.
 *   3. callback     — their browser comes back to our `callback_url` with `Authority` and
 *                     `Status`. `Status=OK` means *they finished*, not that we have been paid.
 *   4. `verify()`   — the only thing that means paid. Answers a `ref_id`: the receipt.
 *
 * **There are no webhooks.** Step 3 is a browser redirect, which means the confirmation only
 * arrives if the person's browser survives the trip. Close the tab on the bank's page after
 * paying and the money has moved with nothing on our side to show for it. That is not an edge
 * case, it is a few percent of real traffic, and `unverified()` plus `stalePayments()` in
 * packages/db/src/billing.js are how it gets found. Ignoring it means quietly keeping money
 * for a subscription nobody received.
 *
 * Step 4 is also not idempotent in the direction you would like: verifying an authority that
 * was already verified answers **101** with the same `ref_id` rather than an error. So 101 is
 * a success here — the caller must credit it exactly as it credits 100, and rely on the unique
 * index on `ref_id` to stop the second one landing twice.
 *
 * ## Amounts
 *
 * `amount` is minor units of `currency`, passed through untouched. IRR is Rials, IRT is Tomans,
 * and one Toman is ten Rials — a mix-up here is a factor-of-ten billing error in whichever
 * direction hurts more, so the currency is always sent explicitly rather than left to whatever
 * the terminal defaults to.
 *
 * ## Before you trust this file
 *
 * These endpoints, field names and codes are what Zarinpal documented at the time of writing.
 * Payment gateways change them, and this one has changed its host at least once. Everything
 * version-specific is in the constants directly below, on purpose: check them against the
 * current docs before a first production charge, and fix them in one place if they have moved.
 */

const HOSTS = {
  live: 'https://payment.zarinpal.com',
  sandbox: 'https://sandbox.zarinpal.com'
}

const PATHS = {
  request: '/pg/v4/payment/request.json',
  verify: '/pg/v4/payment/verify.json',
  unverified: '/pg/v4/payment/unVerified.json',
  start: '/pg/StartPay/'
}

/** Verification outcomes that mean the money is ours. 101 is "you already asked" — see above. */
const VERIFIED = new Set([100, 101])

/**
 * The failures worth naming. Everything else falls through to the gateway's own message.
 *
 * These are for the log and for whoever is debugging a launch, not for the payer: a person
 * whose payment failed needs "it did not go through, you have not been charged", not code -53.
 */
const CODES = {
  '-9': 'the request was rejected as invalid (check merchant id, amount and callback URL)',
  '-10': 'merchant id or IP does not match this terminal',
  '-11': 'this terminal is not active — contact Zarinpal support',
  '-12': 'too many attempts against this terminal, try later',
  '-15': 'this terminal is suspended',
  '-16': 'this terminal is not approved for the requested level',
  '-30': 'this terminal is not permitted to use the requested feature',
  '-50': 'the verified amount does not match the amount requested',
  '-51': 'the payment did not complete',
  '-52': 'the gateway returned an unexpected error',
  '-53': 'this authority belongs to a different terminal',
  '-54': 'the authority is not valid'
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])
const sleep = ms => new Promise(r => setTimeout(r, ms))

class ZarinpalError extends Error {
  constructor(message, { code = null, status = null, body = null } = {}) {
    super(message)
    this.name = 'ZarinpalError'
    this.gatewayCode = code
    this.httpStatus = status
    this.body = body
  }
}

/**
 * One POST, retried only where retrying is safe.
 *
 * Both calls here are safe to repeat — a request that never returned minted nothing we can
 * use, and verify is already idempotent by design. A retry storm against a payment gateway is
 * worse than a slow failure, so: three attempts, backing off, only on statuses meaning
 * "not now".
 */
async function post(url, body, { timeoutMs, attempts = 3, fetchImpl }) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(300 * 2 ** (i - 1))
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal
      })
      const text = await res.text()
      let json = null
      try { json = text ? JSON.parse(text) : null } catch { /* handled below */ }

      if (!res.ok && RETRYABLE.has(res.status)) {
        lastErr = new ZarinpalError('zarinpal ' + res.status, { status: res.status, body: json ?? text })
        continue
      }
      if (json == null) {
        throw new ZarinpalError('zarinpal returned a response that was not JSON', {
          status: res.status, body: String(text).slice(0, 500)
        })
      }
      return json
    } catch (err) {
      // An aborted or dropped request may or may not have reached them. Retrying is the same
      // bet as above and for the same reason.
      if (err instanceof ZarinpalError && !RETRYABLE.has(err.httpStatus)) throw err
      lastErr = err
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr instanceof Error ? lastErr : new ZarinpalError('zarinpal is unreachable')
}

/* Zarinpal answers with a data object and an errors field — and errors is an object when there
 * is one, an empty array when there are none. No consumer should have to know that twice. */
const errorOf = payload => {
  const e = payload?.errors
  if (!e || (Array.isArray(e) && !e.length)) return null
  return Array.isArray(e) ? e[0] : e
}

const describe = (code, fallback) =>
  CODES[String(code)] || fallback || 'zarinpal refused the request (code ' + code + ')'

/**
 * A configured gateway.
 *
 * `merchantId` is the terminal's uuid. `sandbox: true` swaps the host for Zarinpal's test one,
 * where cards are fake and nothing settles — which is what every test and every staging deploy
 * should be pointed at.
 */
export function zarinpal({
  merchantId,
  sandbox = false,
  currency = 'IRR',
  timeoutMs = 15_000,
  fetchImpl = globalThis.fetch,
  host = sandbox ? HOSTS.sandbox : HOSTS.live
} = {}) {
  if (!merchantId) throw new Error('zarinpal needs a merchantId')
  if (currency !== 'IRR' && currency !== 'IRT') throw new Error('unknown currency: ' + currency)

  const url = path => host + path

  return {
    name: 'zarinpal',
    sandbox,
    currency,

    /**
     * Ask for an authority and the URL to send the payer to.
     *
     * `description` is shown to them on the gateway's page, so it is the one string here a real
     * person reads — it should say what they are buying, in their language.
     */
    async request({ amount, description, callbackUrl, email = null, mobile = null }) {
      if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer')
      if (!callbackUrl) throw new Error('callbackUrl is required')

      const payload = await post(url(PATHS.request), {
        merchant_id: merchantId,
        amount,
        currency,
        description,
        callback_url: callbackUrl,
        // Zarinpal rejects the key outright if it is present and empty, rather than ignoring it.
        ...(email || mobile ? { metadata: { ...(email && { email }), ...(mobile && { mobile }) } } : {})
      }, { timeoutMs, fetchImpl })

      const err = errorOf(payload)
      if (err) throw new ZarinpalError(describe(err.code, err.message), { code: err.code, body: payload })

      const authority = payload?.data?.authority
      if (!authority) throw new ZarinpalError('zarinpal did not return an authority', { body: payload })

      return { authority, startUrl: url(PATHS.start) + authority, raw: payload.data }
    },

    /**
     * Confirm a payment. The only call whose answer means money moved.
     *
     * `amount` must be the amount originally requested — Zarinpal checks it and answers -50 if
     * it disagrees, which is the guard against a tampered callback claiming a cheap authority
     * bought an expensive plan. Pass the stored amount, never one from the request.
     */
    async verify({ amount, authority }) {
      if (!authority) throw new Error('authority is required')

      const payload = await post(url(PATHS.verify), {
        merchant_id: merchantId, amount, authority
      }, { timeoutMs, fetchImpl })

      const code = payload?.data?.code ?? errorOf(payload)?.code
      if (VERIFIED.has(Number(code))) {
        return {
          ok: true,
          // 101 means somebody already verified this — the money is ours either way, but the
          // caller wants to know it is not looking at a fresh sale.
          alreadyVerified: Number(code) === 101,
          refId: String(payload.data.ref_id),
          cardPan: payload.data.card_pan ?? null,
          code: Number(code),
          raw: payload.data
        }
      }

      const err = errorOf(payload)
      return {
        ok: false,
        code: Number(code ?? err?.code ?? 0),
        reason: describe(code ?? err?.code, err?.message),
        raw: payload
      }
    },

    /**
     * Authorities the gateway considers paid but unverified — the closed-tab cases.
     *
     * This is the entire reconciliation story for a gateway with no webhooks. Whatever it
     * returns should be matched against our pending rows and verified properly; the answer is
     * a list of handles, not a list of settlements.
     */
    async unverified() {
      const payload = await post(url(PATHS.unverified), { merchant_id: merchantId },
        { timeoutMs, fetchImpl })
      const err = errorOf(payload)
      // -9 here means "nothing pending" on some terminals rather than a real fault.
      if (err && Number(err.code) !== -9) {
        throw new ZarinpalError(describe(err.code, err.message), { code: err.code, body: payload })
      }
      return payload?.data?.authorities ?? []
    }
  }
}

export { ZarinpalError, HOSTS as ZARINPAL_HOSTS }
