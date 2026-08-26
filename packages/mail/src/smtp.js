/* The SMTP transport.
 *
 * Thin on purpose: nodemailer already knows how to talk to a relay, and everything worth
 * deciding here is configuration rather than code.
 *
 * ## Why the port decides the encryption
 *
 * `secure` is not a separate switch. Port 465 is SMTPS — TLS from the first byte — and 587 is
 * submission, which starts in the clear and upgrades with STARTTLS. Getting those two crossed
 * produces a connection that hangs rather than one that fails, which is among the worse ways to
 * spend an evening. So the port picks it, and an instance that genuinely needs the other
 * combination says so with `MAIL_SMTP_SECURE`.
 *
 * `requireTLS` on the non-secure path is the part that matters: without it, a relay that does
 * not offer STARTTLS gets the password in plaintext and nobody is told. With it, that is a
 * connection error instead.
 */
import nodemailer from 'nodemailer'

export function smtpTransport(env) {
  const host = env.MAIL_SMTP_HOST
  if (!host) throw new Error('MAIL_TRANSPORT=smtp needs MAIL_SMTP_HOST')

  const port = +(env.MAIL_SMTP_PORT || 587)
  const secure = env.MAIL_SMTP_SECURE
    ? /^(1|true|yes|on)$/i.test(env.MAIL_SMTP_SECURE)
    : port === 465

  const from = env.MAIL_FROM
  if (!from) throw new Error('MAIL_TRANSPORT=smtp needs MAIL_FROM')

  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    // Upgrade or refuse. A relay that will not do STARTTLS is not one to hand a password to.
    requireTLS: !secure,
    auth: env.MAIL_SMTP_USER
      ? { user: env.MAIL_SMTP_USER, pass: env.MAIL_SMTP_PASS || '' }
      : undefined,
    // A reset is a person waiting at a screen. Failing in ten seconds and saying so beats a
    // request that hangs until something upstream gives up on it.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000
  })

  return {
    name: 'smtp',
    async send({ to, subject, text }) {
      const info = await transport.sendMail({ from, to, subject, text })
      return { accepted: (info.accepted || []).length > 0, transport: 'smtp', id: info.messageId }
    }
  }
}
