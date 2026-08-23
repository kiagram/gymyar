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
import { db } from '@gymbuddy/db'
import {
  createUser, findUserByEmail, findCredential, saveCredential, touchCredential,
  verifyPassword, bumpSessionVersion, publicUser
} from '@gymbuddy/db/users.js'
import { config } from '../config.js'
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
    passwords: true
  }))

  app.get('/api/me', async req => {
    const user = await currentUser(req)
    if (!user) throw bad('not signed in', 401)
    return { user: publicUser(user) }
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
    const { findUserById } = await import('@gymbuddy/db/users.js')
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

    const user = await createUser({ name, email, password, isCoach: !!req.body?.asCoach })
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

  /* ------------------------------------------------------------ logout ---- */

  app.post('/api/logout', async (req, reply) => { clear(reply); return { ok: true } })

  app.post('/api/logout/all', async (req, reply) => {
    const user = await requireUser(req)
    await bumpSessionVersion(user.id)
    clear(reply)
    return { ok: true }
  })
}
