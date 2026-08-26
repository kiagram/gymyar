/* Sending email, and the decision not to pretend we can.
 *
 * GymBuddy has never sent an email. That was fine while everything it did was between a person
 * and their own server — and it stopped being fine the moment accounts had passwords, because
 * a password you can forget and cannot reset is an account you lose. This package is the
 * smallest thing that fixes that.
 *
 * ## Three states, and the third is the interesting one
 *
 *   smtp   a relay this instance can reach. The real thing.
 *   log    the message is written to the server log instead of sent.
 *   off    no transport configured, and password reset is not offered at all.
 *
 * `off` is the default and it is not a degraded mode — it is an honest one. An instance with no
 * way to send mail genuinely cannot reset a password, and the alternative to saying so is a
 * screen that says "check your email" to somebody who will never receive one. So the API
 * reports `passwordReset: false`, the client does not render the link, and the endpoint refuses.
 * The same shape as billing: a property of a deployment, not of the software.
 *
 * `log` exists for the household instance — one person, their own server, no relay, and they
 * are the one reading the logs anyway. It is documented as exactly that, because on an instance
 * with users it means every reset link passes through whatever ships those logs.
 *
 * ## Plain text, no HTML
 *
 * The only email this sends is a link and a sentence about it. HTML would buy a button and cost
 * a rendering surface, a second body to keep in step across both languages, and the deliver-
 * ability penalty every text-only sender avoids. A URL on its own line is linkified by every
 * mail client written this century.
 */
import { smtpTransport } from './smtp.js'

export { resetEmail, MAIL_LOCALES } from './templates.js'

/**
 * The transport this deployment is configured for, or null.
 *
 * Read per call rather than frozen at import, matching `storageFor` and `billingConfig` — the
 * test suite stands up more than one instance in a process, and a module-load-order dependency
 * is a bug that only shows up in whichever file happens to import first.
 */
export function mailerFor({ env = process.env, log = null } = {}) {
  const kind = (env.MAIL_TRANSPORT || '').toLowerCase()
  if (!kind || kind === 'off') return null

  if (kind === 'log') {
    return {
      name: 'log',
      async send({ to, subject, text }) {
        // `info`, not `debug`: on the instance this is for, this line *is* the delivery, and a
        // level the operator has to go looking for would make it a feature that silently does
        // nothing.
        log?.info?.({ to, subject, body: text }, 'email (not sent — MAIL_TRANSPORT=log)')
        return { accepted: true, transport: 'log' }
      }
    }
  }

  if (kind === 'smtp') return smtpTransport(env)

  throw new Error(`unknown MAIL_TRANSPORT: ${kind} (expected 'smtp', 'log', or unset)`)
}

/** Whether this instance can send at all. What `passwordReset` in /api/config reports. */
export const mailEnabled = (env = process.env) =>
  !!(env.MAIL_TRANSPORT && env.MAIL_TRANSPORT.toLowerCase() !== 'off')
