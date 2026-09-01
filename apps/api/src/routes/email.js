/* Proving that somebody can read the address they typed, and putting it on their account.
 *
 * The sibling of routes/phone.js, and the shapes are deliberately the same: a code, six digits,
 * five minutes, a claim that rolls back when what it was for fails. What differs is that a
 * phone number *is* a credential here and an email address is only half of one — sign-in is the
 * address and a password together — which is why this file takes both in one step.
 *
 * ## The column that had never been written
 *
 * `users.email_verified_at` has been in the schema since 001 and nothing ever set it. So every
 * address in an existing database is unproven, and the signup form has always accepted anybody's:
 * it checked that an address was well-formed and unclaimed, never that the person typing it
 * could read it. This is the only code path that writes that column, and it is only reachable
 * from a code that was mailed to the address.
 *
 * ## Unverified is not blocked, with one exception
 *
 * Signing up by email still works exactly as it did — the account is created, the session is
 * issued, and a code goes out in the background. Nothing waits on it. A signup that dead-ends
 * on a mail server's queue is a lost user, and the account is no more dangerous unverified
 * today than it was last week.
 *
 * The exception is `/api/password/forgot`, which now requires a verified address. That is the
 * one place where an unproven address is actively harmful rather than merely unproven: it mails
 * a way into the account to an inbox nobody has shown they can read.
 */
import { setEmail, clearEmail, listCredentials, publicUser } from '@gymyar/db/users.js'
import { requestCode, claimCode, CODE_TTL_MS, RESEND_COOLDOWN_MS } from '@gymyar/db/codes.js'
import { mailerFor, mailEnabled, codeEmail } from '@gymyar/mail'
import { latinDigits } from '@gymyar/domain'
import { requireUser } from '../session.js'
import { limit } from '../rate-limit.js'

const bad = (msg, status = 400, extra = {}) => Object.assign(new Error(msg), { status, ...extra })

/* `expose`, because this is a 5xx raised on purpose — see the error handler in app.js. An
 * instance with no relay is not a bug, and "something went wrong" tells the person nothing they
 * could act on. Same shape as the gateway-less phone routes next door. */
const noMail = () =>
  Object.assign(new Error('this instance cannot send email'), { status: 501, expose: true })

/* The same expression the signup form has always used. Deliberately loose: the check that an
 * address is real is the code sent to it, and a stricter pattern only ever rejects somebody's
 * genuinely odd but valid address. */
const looksLikeEmail = a => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)

function readEmail(input) {
  const email = String(input || '').trim().toLowerCase()
  if (!looksLikeEmail(email)) throw bad('a valid email address is required')
  return email
}

/** The password rule, in one place, matching signup and reset. */
function readPassword(input, { required }) {
  const password = String(input || '')
  if (!password) {
    if (required) throw bad('choose a password — it is what signs you in with this address', 400, { code: 'password_required' })
    return null
  }
  if (password.length < 10) throw bad('password must be at least 10 characters')
  return password
}

/**
 * Send a confirmation code, and the one place this app mails somebody unprompted.
 *
 * Shared by the signed-in route below and by signup, which is why it swallows nothing and
 * decides nothing — the caller knows whether a failure is worth telling somebody about.
 */
export async function sendCode({ user, email, log, ip = null }) {
  const minted = await requestCode({ channel: 'email', address: email, purpose: 'signin', ip })
  if (!minted.ok) return minted

  const { subject, text } = codeEmail({ name: user.name, code: minted.code, locale: user.locale })
  await mailerFor({ log }).send({ to: email, subject, text })
  return minted
}

export default async function emailRoutes(app) {
  /**
   * Send a code to an address somebody wants on their account.
   *
   * Nothing checks here whether the address is already somebody else's, for the two reasons
   * routes/phone.js gives about numbers: it would be a race the unique index cannot lose and a
   * check can, and it would make this a way for any signed-in account to ask which addresses
   * are registered. The collision is reported at `verify`, to somebody who by then has read the
   * mail.
   */
  app.post('/api/me/email/start', { config: limit('code') }, async req => {
    const user = await requireUser(req)
    if (!mailEnabled()) throw noMail()
    const email = readEmail(req.body?.email)

    let minted
    try {
      minted = await sendCode({ user, email, log: req.log, ip: req.ip })
    } catch (err) {
      /* Told, not swallowed — unlike `/api/password/forgot`, which has to answer identically
       * whether or not an address has an account and therefore cannot report a relay that is
       * down. This route is behind a session and says nothing about anybody else's account, so
       * the person waiting on a code is simply told it did not go. */
      req.log.error({ err, userId: user.id }, 'could not send a confirmation code')
      throw Object.assign(new Error('could not send the code — try again in a moment'), {
        status: 502, expose: true, code: 'mail_failed'
      })
    }
    if (!minted.ok) {
      throw bad(
        minted.reason === 'daily'
          ? 'that address has been sent too many codes today — try again tomorrow'
          : `wait ${minted.retryAfter}s before asking for another code`,
        429, { code: 'code_throttled', details: { retryAfter: minted.retryAfter } }
      )
    }
    return {
      ok: true,
      expiresIn: Math.floor(CODE_TTL_MS / 1000),
      resendIn: Math.floor(RESEND_COOLDOWN_MS / 1000)
    }
  })

  /**
   * Spend the code, and write the address and the password that goes with it.
   *
   * The password is required when the account does not already have one, and that is the whole
   * difference between this and the phone equivalent. An account created by phone has no
   * password, so an address alone would leave it exactly as reachable as it was — one way in,
   * and a second contact detail. Asking for both in the same step is what makes this worth
   * having.
   *
   * Everything happens inside the claim's transaction, so a password that is too short or an
   * address that turns out to be somebody else's costs the code nothing.
   */
  app.post('/api/me/email/verify', async req => {
    const user = await requireUser(req)
    if (!mailEnabled()) throw noMail()

    const email = readEmail(req.body?.email)
    // Persian digits, same as the phone route — the keyboard does not change because
    // the code arrived by mail instead of by text.
    const code = latinDigits(req.body?.code).replace(/\D+/g, '')

    const claim = await claimCode({ channel: 'email', address: email, code, then: async tx => {
      // Required only when there is nothing to fall back on. An account that already has a
      // password keeps it — changing an address is not a reason to make somebody choose a new
      // one, and this endpoint is not a password reset.
      const password = readPassword(req.body?.password, { required: !user.password_hash })
      try {
        return await setEmail(user.id, email, { password }, tx)
      } catch (err) {
        // The unique index is the check — see the note in routes/phone.js about why asking
        // first is the wrong shape.
        if (err.code === '23505') throw bad('that address is already on another account', 409, { code: 'email_taken' })
        throw err
      }
    } })

    if (!claim.ok) {
      throw bad('that code is wrong or has expired', 401, {
        code: 'bad_code',
        ...(claim.reason === 'wrong' ? { details: { attemptsLeft: claim.attemptsLeft } } : {})
      })
    }
    return { user: publicUser(claim.result) }
  })

  /**
   * Take the address off this account, and the password with it.
   *
   * Refused when it is the only way in, exactly as removing a phone number is. The two guards
   * are mirror images and both have to exist: an account with only an email must keep it, and
   * an account with only a phone must keep that.
   */
  app.delete('/api/me/email', async req => {
    const user = await requireUser(req)
    if (!user.email) return { user: publicUser(user) }

    const passkeys = await listCredentials(user.id)
    if (!user.phone && passkeys.length === 0) {
      throw bad(
        'this address is the only way into this account — add a phone number or a passkey first',
        409, { code: 'last_credential' }
      )
    }
    return { user: publicUser(await clearEmail(user.id)) }
  })
}
