/* Password resets: minting a token, spending it, and cleaning up after both.
 *
 * The invariant this file exists to hold: **the token is never stored.** It is minted here,
 * returned to the caller once so it can go in an email, and what stays behind is a SHA-256 of
 * it. Every lookup hashes the incoming token and matches on that, so there is no code path that
 * could compare a stored token even by accident — there is no stored token.
 *
 * The second invariant is that spending one is atomic. `consume()` is a single UPDATE with the
 * "still valid" conditions in its WHERE clause, so two requests carrying the same link race the
 * database rather than each other, and exactly one of them wins. A read-then-check would let
 * both through on a double-click, and "the reset link worked twice" is the kind of bug that
 * only shows up when somebody's mail client prefetches the URL.
 */
import crypto from 'node:crypto'
import { db } from './index.js'
import { hashPassword, bumpSessionVersion } from './users.js'

/** How long a link lives. Stated in the email text — see packages/mail/src/templates.js. */
export const RESET_TTL_MS = 60 * 60 * 1000

/* 32 bytes, which is the whole security of this feature. base64url so it survives a URL, an
 * email client's line wrapping and a copy-paste out of one. */
const mintToken = () => crypto.randomBytes(32).toString('base64url')

/** One way, and fast on purpose — the input is already 256 bits of randomness. See 005. */
const hashToken = token => crypto.createHash('sha256').update(token).digest('base64url')

/**
 * Start a reset. Returns the token — the only time it exists outside the email.
 *
 * Outstanding tokens for the account are marked spent first. Asking twice should not leave two
 * working links: the second email is the one the person is looking at, and the first is a link
 * sitting in an inbox that no longer opens anything.
 */
export async function createReset({ userId, ip = null, now = Date.now() }, s = db()) {
  const token = mintToken()
  await s.begin(async tx => {
    await tx`
      update password_resets set used_at = now()
      where user_id = ${userId} and used_at is null`
    await tx`
      insert into password_resets (user_id, token_hash, expires_at, requested_ip)
      values (${userId}, ${hashToken(token)}, ${new Date(now + RESET_TTL_MS)}, ${ip})`
  })
  return token
}

/**
 * Spend a token and set the new password, or answer null.
 *
 * Everything that has to be true is in the WHERE clause of one UPDATE — unspent, unexpired,
 * and this exact hash — so the check and the claim cannot come apart under concurrency. Only a
 * request that actually changed a row goes on to touch the account.
 *
 * `bumpSessionVersion` is the part worth not removing. Somebody resetting a password may be
 * doing it because another person had the old one, and a reset that leaves that person's
 * session alive has fixed nothing.
 */
export async function consume({ token, password, now = Date.now() }, s = db()) {
  if (!token || !password) return null
  const password_hash = await hashPassword(password)

  return s.begin(async tx => {
    const [row] = await tx`
      update password_resets set used_at = now()
      where token_hash = ${hashToken(token)}
        and used_at is null
        and expires_at > ${new Date(now)}
      returning user_id`
    if (!row) return null

    const [user] = await tx`
      update users set password_hash = ${password_hash}
      where id = ${row.user_id} and disabled_at is null
      returning *`
    // A disabled account is not one to hand a working password to, and the token is spent
    // either way — a link that quietly does nothing is better than one that stays live.
    if (!user) return null

    /* The returned row carries the *new* version, not the one it was read with.
     *
     * The caller issues a session cookie from this, and a cookie stamped with the old version
     * stops verifying the moment the bump lands — so returning the pre-bump row signs the
     * person out on the device they are standing at, immediately after they proved the account
     * is theirs. Everywhere else is meant to be signed out. Here is not. */
    const version = await bumpSessionVersion(user.id, tx)
    return { ...user, session_version: version }
  })
}

/**
 * Whether a token would work, without spending it.
 *
 * The reset screen asks this on open so somebody who followed a stale link is told before they
 * choose a password rather than after. It is deliberately no more than a yes or no — it names
 * no account, so a token guessed at reveals nothing about whose it might have been.
 */
export async function isLive({ token, now = Date.now() }, s = db()) {
  if (!token) return false
  const rows = await s`
    select 1 from password_resets
    where token_hash = ${hashToken(token)} and used_at is null and expires_at > ${new Date(now)}`
  return rows.length > 0
}

/**
 * Rows that can no longer do anything: spent, or expired unspent.
 *
 * Kept for a day after they die rather than deleted on the spot, because "was a reset requested
 * for this account, and when" is a question worth being able to answer for a little while after
 * somebody asks it.
 */
export async function purgeDeadResets({ keepHours = 24, now = Date.now() } = {}, s = db()) {
  const cutoff = new Date(now - keepHours * 60 * 60 * 1000)
  const rows = await s`
    delete from password_resets
    where (used_at is not null and used_at < ${cutoff})
       or (used_at is null and expires_at < ${cutoff})
    returning id`
  return rows.length
}

/** How many live links this account has. Used only by the tests and by an operator asking. */
export const liveResetsFor = (userId, s = db()) => s`
  select count(*)::int as n from password_resets
  where user_id = ${userId} and used_at is null and expires_at > now()`
  .then(r => r[0].n)
