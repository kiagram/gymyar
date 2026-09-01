/* Sending a text message, and the decision not to pretend we can.
 *
 * The same three states as `@gymyar/mail`, and the same argument for the third — see that
 * package's header, which this one is deliberately a sibling of rather than a variation on.
 *
 *   kavenegar / smsir   a real Iranian gateway. The thing that makes signup work.
 *   log                 the message is written to the server log instead of sent.
 *   off                 no gateway configured, and phone signup is not offered at all.
 *
 * ## Why this exists at all when there is already email
 *
 * Because of who this product is for. A coach in Tehran and their clients have a phone number
 * and, very often, no email address they check — mail is a thing you have for signing up to
 * foreign services, and most of those do not accept an Iranian card or an Iranian address
 * anyway. Meanwhile the reset email this repo already sends has to cross a border to arrive,
 * from a relay whose reputation is not in our hands, to an inbox behind filters that treat the
 * whole origin with suspicion. A phone number is the identifier this market actually uses, and
 * an SMS from a domestic gateway is the one delivery channel that is not somebody else's
 * geopolitics.
 *
 * That is also the reason none of this replaces anything. Passkeys stay the best option,
 * email and password stays for everyone outside Iran, and this is a third door into the same
 * session cookie.
 *
 * ## `off` is honest, not degraded
 *
 * An instance with no gateway genuinely cannot text anybody, so `/api/config` reports
 * `phoneAuth: false`, the client does not render the option, and the endpoint refuses with a
 * 501. A signup screen that asks for a number and then says "code sent" to somebody who will
 * never receive one is worse than a screen that does not offer it.
 *
 * `log` is for the household instance: one person, their own server, no gateway, and they are
 * the one reading the logs. On an instance with users it means every code passes through
 * whatever ships those logs, which is a sentence worth reading twice before setting it.
 */
import { kavenegarTransport } from './kavenegar.js'
import { smsirTransport } from './smsir.js'

export { codeMessage, CODE_TTL_MINUTES, SMS_LOCALES } from './templates.js'
export { SmsError } from './http.js'

/**
 * The gateway this deployment is configured for, or null.
 *
 * Read per call rather than frozen at import, matching `mailerFor` and `storageFor` — the test
 * suite stands up more than one instance in a process, and a module-load-order dependency is a
 * bug that only shows up in whichever file happens to import first.
 */
export function smsFor({ env = process.env, log = null } = {}) {
  const kind = (env.SMS_TRANSPORT || '').toLowerCase()
  if (!kind || kind === 'off') return null

  if (kind === 'log') {
    return {
      name: 'log',
      async send({ to, code, text }) {
        /* `info`, not `debug`: on the instance this is for, this line *is* the delivery, and a
         * level the operator has to go looking for would make it a feature that silently does
         * nothing. The code is in it, which is the entire point and the entire risk. */
        log?.info?.({ to, code, body: text }, 'sms (not sent — SMS_TRANSPORT=log)')
        return { accepted: true, transport: 'log' }
      }
    }
  }

  if (kind === 'kavenegar') return kavenegarTransport(env)
  if (kind === 'smsir') return smsirTransport(env)

  throw new Error(`unknown SMS_TRANSPORT: ${kind} (expected 'kavenegar', 'smsir', 'log', or unset)`)
}

/** Whether this instance can text at all. What `phoneAuth` in /api/config reports. */
export const smsEnabled = (env = process.env) =>
  !!(env.SMS_TRANSPORT && env.SMS_TRANSPORT.toLowerCase() !== 'off')

/** What the code message says it is from. The operator-registered sender name, in practice. */
export const smsBrand = (env = process.env) => env.SMS_BRAND || env.RP_NAME || 'GymYar'
