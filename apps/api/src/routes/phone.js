/* Signing up and signing in with an Iranian mobile number.
 *
 * The third door into the same session cookie, next to passkeys and email-and-password. Why it
 * exists is argued in packages/sms/src/index.js and in migration 010; what follows is how it
 * behaves, which has two decisions in it worth defending.
 *
 * ## One flow, not two
 *
 * There is no "sign up with a phone" separate from "sign in with a phone". A person types their
 * number, receives a code, types it back, and lands in their account — which is created on the
 * spot if it did not exist. That is how every Iranian app this product's users already have on
 * their phone behaves, and it is also the honest shape: possession of the SIM is the entire
 * credential either way, so the two cases differ by one INSERT and nothing a person should have
 * to choose between on a screen beforehand.
 *
 * ## Which is why `start` will not say whether the number is registered
 *
 * The obvious version of the flow answers the first request with `registered: true|false`, so
 * the second screen knows whether to ask for a name. It is also a membership oracle: anybody
 * with a list of phone numbers could ask this endpoint which of them train here, and for a
 * coaching app that list is a roster of who has a coach.
 *
 * `/api/password/forgot` next door already refuses to be that for email addresses, at the cost
 * of never being able to say whether the message went. This endpoint pays a smaller price for
 * the same property: it answers identically for a number with an account and one without, and
 * the question "is this new" is deferred to `verify` — where it is answered only to somebody
 * who has just proved they hold the SIM. A new number arrives there without a name and is told
 * `name_required`; the client shows one field and posts again. One extra step, for new accounts
 * only, and no way to ask about somebody else's number.
 *
 * ## Where the ceilings are
 *
 * Three of them, in two places, and they are not redundant:
 *
 *   the limiter here      requests per caller, keyed by the number being asked about, so one
 *                         person hammering the endpoint spends their own budget rather than
 *                         that of everybody behind the same carrier address.
 *   the cooldown and      messages per *number*, in phone-codes.js. This is the one that
 *   daily cap             protects the person being texted and the operator's bill, and it
 *                         holds no matter how the requests are spread out or where they came
 *                         from.
 *   MAX_ATTEMPTS          guesses per code. Six digits is nothing against a script; this makes
 *                         the number of tries a constant rather than whatever gets through.
 */
import { db } from '@gymyar/db'
import {
  createUser, findUserByPhone, setPhone, clearPhone, listCredentials, publicUser
} from '@gymyar/db/users.js'
import { requestCode, claimCode, CODE_TTL_MS, RESEND_COOLDOWN_MS } from '@gymyar/db/codes.js'
import { normalizePhone, latinDigits, isLocale } from '@gymyar/domain'
import { smsFor, smsEnabled, smsBrand, codeMessage } from '@gymyar/sms'
import { config } from '../config.js'
import { issue, requireUser } from '../session.js'
import { limit } from '../rate-limit.js'

const bad = (msg, status = 400, extra = {}) => Object.assign(new Error(msg), { status, ...extra })

/* `expose`, because this is a 5xx raised on purpose — see the error handler in app.js. An
 * instance with no gateway is not a bug, and "something went wrong" tells the person nothing
 * they could act on. Same shape as the mail-less password reset next door. */
const noGateway = () =>
  Object.assign(new Error('this instance cannot send text messages'), { status: 501, expose: true })

/* A refusal from the per-number ceilings, as a 429 carrying the wait.
 *
 * The same shape the rate limiter returns, so the client has one thing to render rather than
 * two — and both `start` routes below answer with it, because a cooldown is about the number
 * being texted and neither of them gets to be an exception to that. */
const throttled = minted => bad(
  minted.reason === 'daily'
    ? 'that number has been sent too many codes today — try again tomorrow'
    : `wait ${minted.retryAfter}s before asking for another code`,
  429, { code: 'sms_throttled', details: { retryAfter: minted.retryAfter } }
)

/* The number, canonically, or a refusal. Everything downstream — the column, the unique index,
 * the OTP key, the gateway — is handed this and only this. */
function readPhone(input) {
  const phone = normalizePhone(input)
  if (!phone) throw bad('enter an Iranian mobile number, like 09123456789')
  return phone
}

/* Invite codes, on the transaction the signup is running in — see the `then` callback below.
 * Checked there rather than before it, so a wrong invite code costs a person a retype rather
 * than a text message. */
async function checkInvite(code, s) {
  if (!config.inviteOnly) return null
  const rows = await s`select * from invites where code = ${code} and used_by is null`
  if (!rows.length) throw bad('a valid invite code is required', 403)
  return rows[0]
}

export default async function phoneRoutes(app) {
  /**
   * Send a code to a number.
   *
   * Answers the same thing for a number with an account and one without — see the header. What
   * it does report is the cooldown, because that is about the caller's own last request rather
   * than about anybody's account, and a screen with a countdown on the resend button is the
   * difference between a person waiting and a person tapping.
   */
  app.post('/api/phone/start', { config: limit('code') }, async req => {
    const gateway = smsFor({ env: process.env, log: req.log })
    if (!gateway) throw noGateway()

    const phone = readPhone(req.body?.phone)
    /* Which language the code message is written in. The screen the person is looking at, not
     * an account's setting — there may be no account, and if there is one we are deliberately
     * not looking it up here. Persian when unrecognised, which is the one place in this repo
     * where the fallback is not English; the message goes to a +98 handset. */
    const locale = isLocale(req.body?.locale) ? req.body.locale : 'fa'

    // Recorded, not enforced — which of the two this turns out to be is decided when the code
    // is spent. A flood of one kind and a flood of the other are different problems.
    const purpose = await findUserByPhone(phone) ? 'signin' : 'signup'
    const minted = await requestCode({ channel: 'sms', address: phone, purpose, ip: req.ip })
    if (!minted.ok) throw throttled(minted)

    try {
      await gateway.send({
        to: phone,
        code: minted.code,
        text: codeMessage({ code: minted.code, locale, brand: smsBrand() })
      })
    } catch (err) {
      /* Told, not swallowed — and this is where this endpoint parts company with
       * `/api/password/forgot`, which logs a failed send and answers `ok` regardless. That one
       * has to: its response is the same for an address with an account and one without, and a
       * 500 for real addresses would be the enumeration oracle it exists not to be. Here the
       * answer is already independent of whether the number is registered, so saying "the
       * message did not go" leaks nothing and is the only useful thing to say to somebody who
       * is about to stare at a handset for five minutes.
       *
       * The code stays live. They can ask again after the cooldown, and if the first message
       * turns up late it still works. */
      req.log.error({ err, phone }, 'could not send a sign-in code')
      throw Object.assign(new Error('could not send the code — try again in a moment'), {
        status: 502, expose: true, code: 'sms_failed'
      })
    }

    return {
      ok: true,
      // What the screen needs to draw itself: how long the code is good for, and when the
      // resend button comes back. Neither says anything about whose number this is.
      expiresIn: Math.floor(CODE_TTL_MS / 1000),
      resendIn: Math.floor(RESEND_COOLDOWN_MS / 1000)
    }
  })

  /**
   * Spend the code: sign in, or create the account.
   *
   * The order matters. The code is claimed *first* — before the invite is checked, before a
   * name is demanded, before anything is written — because everything after it is a statement
   * about an account, and none of that may be said to somebody who has not proved they hold
   * the SIM. It is also what stops this being a way to burn through invite codes.
   */
  app.post('/api/phone/verify', { config: limit('auth') }, async (req, reply) => {
    if (!smsEnabled()) throw noGateway()

    const phone = readPhone(req.body?.phone)
    // A code typed on an Iranian phone's own keyboard arrives as `۱۲۳۴۵۶`. Converting it here
    // rather than rejecting it is the whole reason `latinDigits` is in the domain.
    const code = latinDigits(req.body?.code).replace(/\D+/g, '')

    /* Everything below the code check happens inside the claim's own transaction, and a throw
     * from any of it takes the spending of the code with it. That is what makes "you left the
     * name blank" cost a retype rather than another text message and another minute of waiting
     * — and it is what makes the account and the code being spent one atomic act rather than
     * two writes with a window between them. See `claimCode`. */
    const claim = await claimCode({ channel: 'sms', address: phone, code, then: async tx => {
      const existing = await findUserByPhone(phone, tx)
      if (existing) {
        if (existing.disabled_at) throw bad('this account has been disabled', 403)
        return { user: existing, created: false }
      }

      /* A new number. Only here — to somebody holding a code that was texted to this handset —
       * does this endpoint admit there is no account, and ask for the one thing an account
       * needs that a phone number does not carry. */
      const name = String(req.body?.name || '').trim().slice(0, 40)
      if (!name) throw bad('what should we call you?', 400, { code: 'name_required' })

      /* `invite`, not `code` — that name is taken by the six digits this request is spending,
       * and two fields called almost the same thing on one endpoint is a bug waiting for a
       * tired afternoon. */
      const invite = await checkInvite(String(req.body?.invite || '').trim().toUpperCase(), tx)
      // The language they are reading the signup screen in, so the first note this account is
      // sent is already in it. Anything unrecognised is English rather than a rejection — a bad
      // `locale` is not a reason to refuse somebody an account.
      const locale = isLocale(req.body?.locale) ? req.body.locale : 'en'

      const user = await createUser({ name, phone, locale, isCoach: !!req.body?.asCoach }, tx)
      if (invite) {
        await tx`update invites set used_by = ${user.id}, used_at = now() where code = ${invite.code}`
      }
      return { user, created: true }
    } })

    if (!claim.ok) {
      /* One message for a wrong code, an expired one and one that was never sent. The reasons
       * are distinguished in the database layer, for a log an operator reads; they are not
       * distinguished here, because the difference between "wrong" and "there is no code for
       * that number" is exactly the fact this endpoint is not willing to publish.
       *
       * `attemptsLeft` is the exception, and only when there is a code being guessed at: a
       * person who has mistyped twice should be told the code is about to die rather than
       * discovering it silently. It says nothing about whether the number has an account. */
      throw bad('that code is wrong or has expired', 401, {
        code: 'bad_code',
        ...(claim.reason === 'wrong' ? { details: { attemptsLeft: claim.attemptsLeft } } : {})
      })
    }

    const { user, created } = claim.result
    issue(reply, user)
    return { user: publicUser(user), created }
  })

  /* ------------------------------- a number on an account that already exists ---- */

  /**
   * Attach a number to the account you are signed in to, or move it to a different one.
   *
   * The same two calls as signup and for the same reason — a number is only ever written after
   * a code went to it and came back — but the account is the one holding the cookie rather than
   * whichever one the number points at. Somebody who joined with a passkey on a laptop and now
   * wants to sign in on their phone comes through here.
   *
   * Nothing checks here whether the number already belongs to somebody else, and that is
   * deliberate twice over. It would be a race — the answer can change between the check and the
   * write, and the unique index is the only thing that cannot lose that race. And it would make
   * this endpoint a way for any signed-in account to ask which numbers are registered, which is
   * the question `/api/phone/start` is carefully built not to answer. So the collision is
   * reported at `verify`, to somebody who has by then proved they hold the SIM.
   */
  app.post('/api/me/phone/start', { config: limit('code') }, async req => {
    const user = await requireUser(req)
    const gateway = smsFor({ env: process.env, log: req.log })
    if (!gateway) throw noGateway()

    const phone = readPhone(req.body?.phone)
    // Their own language this time, from their profile — unlike the signup path, there is an
    // account here and what they set on it is a better answer than the browser that asked.
    const locale = isLocale(user.locale) ? user.locale : 'fa'

    const minted = await requestCode({ channel: 'sms', address: phone, purpose: 'signin', ip: req.ip })
    if (!minted.ok) throw throttled(minted)

    try {
      await gateway.send({
        to: phone,
        code: minted.code,
        text: codeMessage({ code: minted.code, locale, brand: smsBrand() })
      })
    } catch (err) {
      req.log.error({ err, userId: user.id }, 'could not send a number-confirmation code')
      throw Object.assign(new Error('could not send the code — try again in a moment'), {
        status: 502, expose: true, code: 'sms_failed'
      })
    }
    return { ok: true, expiresIn: Math.floor(CODE_TTL_MS / 1000), resendIn: Math.floor(RESEND_COOLDOWN_MS / 1000) }
  })

  /**
   * Spend the code and write the number onto this account.
   *
   * The write is inside the claim's transaction, so a number that turns out to be somebody
   * else's costs the code nothing — they can try a different one immediately rather than
   * waiting out a cooldown for a mistake the server could see coming.
   */
  app.post('/api/me/phone/verify', async req => {
    const user = await requireUser(req)
    if (!smsEnabled()) throw noGateway()

    const phone = readPhone(req.body?.phone)
    const code = latinDigits(req.body?.code).replace(/\D+/g, '')

    const claim = await claimCode({ channel: 'sms', address: phone, code, then: async tx => {
      /* The unique index is the check. Postgres raises 23505 when the number is already on
       * another account, and catching the constraint rather than asking first is what makes
       * this correct under two people confirming the same number in the same second. */
      try {
        return await setPhone(user.id, phone, tx)
      } catch (err) {
        if (err.code === '23505') throw bad('that number is already on another account', 409, { code: 'phone_taken' })
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
   * Take the number off this account.
   *
   * Refused when it is the only way in. An account created by phone has no password and no
   * passkey, so removing its number is not "unlinking a contact detail" — it is deleting the
   * credential, and the next screen would be a sign-in form with nothing to type into it. The
   * refusal names what is missing, because "add a passkey first" is an action and "cannot
   * remove" is not.
   */
  app.delete('/api/me/phone', async req => {
    const user = await requireUser(req)
    if (!user.phone) return { user: publicUser(user) }

    const passkeys = await listCredentials(user.id)
    if (!user.password_hash && passkeys.length === 0) {
      throw bad(
        'this number is the only way into this account — add a passkey or a password first',
        409, { code: 'last_credential' }
      )
    }
    return { user: publicUser(await clearPhone(user.id)) }
  })
}
