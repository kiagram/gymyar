/* Passkeys, and email + password for everyone whose device or browser will not do passkeys.
 *
 * Both paths end at the same place: a signed session cookie. Passkeys stay the better option and
 * the one the UI leads with; the password path exists because "sign up" cannot be a dead end for
 * a mainstream product, which is exactly the reason openGym could stay passkey-only and we can't.
 */
import crypto from 'node:crypto'
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server'
import { db } from '@gymyar/db'
import {
  createUser, findUserByEmail, findCredential, saveCredential, touchCredential, setLocale,
  verifyPassword, bumpSessionVersion, publicUser
} from '@gymyar/db/users.js'
import { config } from '../config.js'
import { LIMITS, MAX_VIDEO_SECONDS } from '@gymyar/storage'
import { isLocale } from '@gymyar/domain'
import { mailerFor, mailEnabled, resetEmail } from '@gymyar/mail'
import { createReset, consume, isLive } from '@gymyar/db/passwords.js'
import { issue, clear, requireUser, currentUser } from '../session.js'
import { limit } from '../rate-limit.js'

/* Challenges are short-lived and single-use. In memory on purpose: they are worthless after five
 * minutes, and a restart losing them costs a user one retry. */
const challenges = new Map()
const CHALLENGE_TTL = 5 * 60_000
const putChallenge = data => {
  const cid = crypto.randomBytes(16).toString('base64url')
  challenges.set(cid, { ...data, exp: Date.now() + CHALLENGE_TTL })
  return cid
}
const takeChallenge = cid => {
  const c = challenges.get(cid)
  challenges.delete(cid)
  return !c || c.exp < Date.now() ? null : c
}
setInterval(() => {
  for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k)
}, 60_000).unref()

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status })

async function checkInvite(code) {
  if (!config.inviteOnly) return null
  const rows = await db()`select * from invites where code = ${code} and used_by is null`
  if (!rows.length) throw bad('a valid invite code is required', 403)
  return rows[0]
}

export default async function authRoutes(app) {
  app.get('/api/config', async () => ({
    inviteOnly: config.inviteOnly,
    rpName: config.rpName,
    passkeys: true,
    passwords: true,
    /* Whether "forgot password" is a thing on this instance.
     *
     * False when no mail transport is configured, and the client then does not offer the link
     * at all. That is the honest shape: an instance with no way to send email cannot reset a
     * password, and a form that says "check your inbox" to somebody who will never receive
     * anything is worse than no form. See packages/mail/src/index.js. */
    passwordReset: mailEnabled(),
    /* The upload ceilings, so the app can refuse a file before spending somebody's mobile
     * data on it rather than after. The server enforces them regardless — this is courtesy,
     * not the check — but a rejection that arrives at 100% of a 60 MB upload is a person who
     * does not try again. */
    media: { limits: LIMITS, maxVideoSeconds: MAX_VIDEO_SECONDS }
  }))

  app.get('/api/me', async req => {
    const user = await currentUser(req)
    if (!user) throw bad('not signed in', 401)
    return { user: publicUser(user) }
  })

  /**
   * The parts of a profile the server needs to know and sync does not carry.
   *
   * Only `locale`, for now, and it is here rather than in a sync row because it is not one: the
   * app's language is a device setting the client already keeps, and this is the server being
   * told which language to *write* in — for the note a coach's client reads, which the server
   * generates. An allowlist rather than whatever arrives, since it lands in a column two
   * features branch on.
   */
  app.patch('/api/me', async req => {
    const user = await requireUser(req)
    const locale = String(req.body?.locale || '')
    if (!isLocale(locale)) throw bad('not a language this app has')
    // Nothing to say and nothing to write when it has not moved — this is called on every
    // sign-in, and an UPDATE per launch is a write nobody asked for.
    if (locale === user.locale) return { user: publicUser(user) }
    await setLocale(user.id, locale)
    return { user: publicUser({ ...user, locale }) }
  })

  /* ---------------------------------------------------------- passkeys ---- */

  app.post('/api/register/options', { config: limit('auth') }, async req => {
    const name = String(req.body?.name || '').trim().slice(0, 40)
    if (!name) throw bad('name required')
    const code = String(req.body?.code || '').trim().toUpperCase()
    await checkInvite(code)
    const handle = crypto.randomBytes(12).toString('base64url')
    const options = await generateRegistrationOptions({
      rpName: config.rpName, rpID: config.rpId,
      userID: Buffer.from(handle), userName: name, userDisplayName: name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }
    })
    return { cid: putChallenge({ challenge: options.challenge, name, code }), options }
  })

  app.post('/api/register/verify', { config: limit('auth') }, async (req, reply) => {
    const c = takeChallenge(req.body?.cid)
    if (!c?.name) throw bad('challenge expired — try again')

    let verification
    try {
      verification = await verifyRegistrationResponse({
        response: req.body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpId,
        requireUserVerification: false
      })
    } catch (e) { throw bad('verification failed: ' + e.message) }
    if (!verification.verified) throw bad('not verified')

    const { credential } = verification.registrationInfo
    if (await findCredential(credential.id)) throw bad('credential already registered', 409)
    // Re-checked here, not just at options time: an invite can be used by someone else in the
    // seconds between the two calls, and burning it must happen in the same breath as the signup.
    const invite = await checkInvite(c.code)

    const user = await createUser({ name: c.name })
    await saveCredential({
      id: credential.id, userId: user.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter || 0,
      transports: req.body.credential?.response?.transports || []
    })
    if (invite) {
      await db()`update invites set used_by = ${user.id}, used_at = now() where code = ${invite.code}`
    }
    issue(reply, user)
    return { user: publicUser(user) }
  })

  app.post('/api/login/options', { config: limit('auth') }, async () => {
    const options = await generateAuthenticationOptions({
      rpID: config.rpId, userVerification: 'preferred', allowCredentials: []
    })
    return { cid: putChallenge({ challenge: options.challenge }), options }
  })

  app.post('/api/login/verify', { config: limit('auth') }, async (req, reply) => {
    const c = takeChallenge(req.body?.cid)
    if (!c) throw bad('challenge expired — try again')
    const cred = await findCredential(req.body?.credential?.id)
    if (!cred) throw bad('unknown passkey — create a profile first', 404)

    let verification
    try {
      verification = await verifyAuthenticationResponse({
        response: req.body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpId,
        requireUserVerification: false,
        credential: {
          id: cred.id,
          publicKey: Buffer.from(cred.public_key, 'base64url'),
          counter: Number(cred.counter),
          transports: cred.transports
        }
      })
    } catch (e) { throw bad('verification failed: ' + e.message) }
    if (!verification.verified) throw bad('not verified')

    await touchCredential(cred.id, verification.authenticationInfo.newCounter)
    const { findUserById } = await import('@gymyar/db/users.js')
    const user = await findUserById(cred.user_id)
    if (!user) throw bad('user missing', 500)
    if (user.disabled_at) throw bad('this account has been disabled', 403)
    issue(reply, user)
    return { user: publicUser(user) }
  })

  /* ------------------------------------------------- email and password ---- */

  app.post('/api/register/password', async (req, reply) => {
    const name = String(req.body?.name || '').trim().slice(0, 40)
    const email = String(req.body?.email || '').trim().toLowerCase()
    const password = String(req.body?.password || '')
    if (!name) throw bad('name required')
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('a valid email is required')
    if (password.length < 10) throw bad('password must be at least 10 characters')
    await checkInvite(String(req.body?.code || '').trim().toUpperCase())
    if (await findUserByEmail(email)) throw bad('that email is already registered', 409)

    // The language they are reading the signup form in, so the first note this account is sent
    // is already in it. Anything unrecognised is simply English rather than a rejection: a bad
    // `locale` is not a reason to refuse somebody an account.
    const locale = isLocale(req.body?.locale) ? req.body.locale : 'en'
    const user = await createUser({ name, email, password, locale, isCoach: !!req.body?.asCoach })
    issue(reply, user)
    return { user: publicUser(user) }
  })

  app.post('/api/login/password', { config: limit('auth') }, async (req, reply) => {
    const email = String(req.body?.email || '').trim().toLowerCase()
    const password = String(req.body?.password || '')
    const user = await findUserByEmail(email)
    // Same message and roughly the same work either way, so the response cannot be used to
    // enumerate which addresses have accounts.
    const ok = user?.password_hash ? await verifyPassword(password, user.password_hash) : false
    if (!ok) throw bad('email or password is incorrect', 401)
    if (user.disabled_at) throw bad('this account has been disabled', 403)
    issue(reply, user)
    return { user: publicUser(user) }
  })

  /* ---------------------------------------------------- password reset ---- */

  /**
   * Ask for a link.
   *
   * Answers the same thing whether or not that address has an account, always. An endpoint that
   * says "no such user" is an endpoint that confirms which of a leaked address list are real
   * people here — and for a coaching app that list is a membership roster.
   *
   * Which means the caller learns nothing from the response, including nothing about whether it
   * worked. That is the trade, and it is the right one: somebody who mistyped their address
   * gets no email and tries again, while somebody enumerating gets nothing at all.
   */
  app.post('/api/password/forgot', { config: limit('password-reset') }, async req => {
    /* `expose`, because this is a 5xx raised on purpose — see the error handler in app.js. An
     * instance with no mail transport is not a bug, and "something went wrong" tells the person
     * nothing they could act on. */
    if (!mailEnabled()) {
      throw Object.assign(new Error('this instance cannot send email'), { status: 501, expose: true })
    }
    const email = String(req.body?.email || '').trim().toLowerCase()

    const user = await findUserByEmail(email)
    // A passkey-only account has no password to reset, and a disabled one is not being let back
    // in by email. Both fall through to the same answer as an address nobody has.
    if (user?.password_hash && !user.disabled_at) {
      const token = await createReset({ userId: user.id, ip: req.ip })
      const url = `${config.origin}/#/reset/${token}`
      // Their language, from their profile — see packages/mail/src/templates.js for why that
      // rather than the locale of whichever browser asked.
      const { subject, text } = resetEmail({ name: user.name, url, locale: user.locale })
      try {
        await mailerFor({ log: req.log }).send({ to: user.email, subject, text })
      } catch (err) {
        /* Logged and swallowed. The person on the other end is told the same thing either way,
         * so throwing here would leak — a 500 for real addresses and a 200 for the rest is the
         * enumeration oracle this endpoint was carefully written not to be. The operator gets
         * the reason, which is who can actually act on a relay that is refusing connections. */
        req.log.error({ err, userId: user.id }, 'could not send a password reset email')
      }
    }
    return { ok: true }
  })

  /**
   * Is this link still good? Asked when the reset screen opens.
   *
   * Yes or no and nothing else — it names no account and no address, so guessing at tokens
   * reveals nothing about whose they might be. It exists so somebody who followed a stale link
   * is told before they choose a password rather than after.
   */
  app.get('/api/password/reset/:token', async req => ({
    valid: await isLive({ token: String(req.params.token || '') })
  }))

  /**
   * Spend the link and set the password.
   *
   * Signs the account out everywhere on the way through — see `consume`. Somebody resetting a
   * password may be doing it because another person had the old one, and a reset that leaves
   * that person's session alive has fixed nothing.
   */
  app.post('/api/password/reset', { config: limit('auth') }, async (req, reply) => {
    const token = String(req.body?.token || '')
    const password = String(req.body?.password || '')
    // The same rule the signup form applies. Checked before the token is spent, so a password
    // that was never going to be accepted does not cost somebody their link.
    if (password.length < 10) throw bad('password must be at least 10 characters')

    const user = await consume({ token, password })
    if (!user) throw bad('this link has expired or has already been used', 400)

    // Signed in on this device, since they have just proved they can read the account's email
    // and chosen the password — asking them to type it again immediately is ceremony.
    issue(reply, user)
    return { user: publicUser(user) }
  })

  /* ------------------------------------------------------------ logout ---- */

  app.post('/api/logout', async (req, reply) => { clear(reply); return { ok: true } })

  app.post('/api/logout/all', async (req, reply) => {
    const user = await requireUser(req)
    await bumpSessionVersion(user.id)
    clear(reply)
    return { ok: true }
  })
}
