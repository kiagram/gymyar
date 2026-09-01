/* Talking to a gateway: the two request shapes both providers need, and one timeout.
 *
 * `fetch` with no signal waits as long as the other end wants it to. That is the wrong default
 * everywhere and it is a visibly wrong one here: the caller is a person standing at a signup
 * screen with a phone in their hand, and a gateway that has stopped answering should cost them
 * eight seconds and an error they can retry, not a request that hangs until a proxy somewhere
 * gives up. Iranian gateways are reachable from Iranian hosting and frequently not from
 * anywhere else, so "slow, then nothing" is an ordinary failure here rather than an exotic one.
 */
import { normalizePhone } from '@gymyar/domain'

/** How long a gateway gets to answer. */
export const TIMEOUT_MS = 8000

/** A refusal that came from the provider rather than from the network. Carried so the API can
 *  log which, and still tell the person the same thing either way. */
export class SmsError extends Error {
  constructor(message, { provider = null, providerStatus = null } = {}) {
    super(message)
    this.name = 'SmsError'
    this.provider = provider
    this.providerStatus = providerStatus
  }
}

/** `+989123456789` → `09123456789`, which is the only form either provider's API accepts. */
export function national(e164) {
  const norm = normalizePhone(e164)
  if (!norm) throw new SmsError(`not a number this gateway can reach: ${e164}`)
  return '0' + norm.slice(3)
}

async function request(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  /* Parsed before the status is checked, on purpose: both providers put the reason a message
   * was refused in the body, and several of those refusals arrive as a 4xx. Throwing on the
   * status first would discard the only useful part of the response. */
  const body = await res.json().catch(() => null)
  if (!res.ok && !body) throw new SmsError(`gateway answered HTTP ${res.status}`)
  return body
}

export const postForm = (url, fields) => request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString()
})

export const postJSON = (url, body, headers = {}) => request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body)
})
