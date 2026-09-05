/* Users, credentials and sessions — the parts of openGym's db.json that became tables. */
import crypto from 'node:crypto'
import { db } from './index.js'

const scrypt = (pw, salt) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))))

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const key = await scrypt(password, salt)
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export async function verifyPassword(password, stored) {
  if (!stored?.startsWith('scrypt$')) return false
  const [, salt, key] = stored.split('$')
  const expected = Buffer.from(key, 'base64url')
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'))
  // Constant time: a length mismatch alone must not be a faster "no" than a value mismatch.
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

/**
 * `phone` is E.164 and already verified when it is present.
 *
 * There is no path that writes the column unverified: a number only reaches this function by
 * way of a code that was texted to it and typed back (see codes.js), so the timestamp is
 * set in the same insert rather than left for a later step nobody would take. A column that can
 * hold an unproven number is a column no other feature can trust.
 */
export async function createUser({ name, email = null, password = null, phone = null, isCoach = false, isAdmin = false, locale = 'en' }, s = db()) {
  const password_hash = password ? await hashPassword(password) : null
  const [user] = await s`
    insert into users (name, email, password_hash, phone, phone_verified_at, is_coach, is_admin, locale)
    values (${name}, ${email}, ${password_hash}, ${phone}, ${phone ? s`now()` : null}, ${isCoach}, ${isAdmin}, ${locale})
    returning *`
  await s`insert into sync_cursor (user_id, value) values (${user.id}, 0)
          on conflict (user_id) do nothing`
  return user
}

export const findUserById = (id, s = db()) =>
  s`select * from users where id = ${id}`.then(r => r[0] || null)

export const findUserByEmail = (email, s = db()) =>
  s`select * from users where lower(email) = lower(${email})`.then(r => r[0] || null)

/* Exact match, not `lower()` like the email lookup beside it. A phone number has one spelling
 * by the time it gets here — `normalizePhone` in the domain produced it, on both sides of the
 * wire — and a case-insensitive comparison on a string of digits would be a lookup that cannot
 * use the unique index for no benefit at all. */
export const findUserByPhone = (phone, s = db()) =>
  s`select * from users where phone = ${phone}`.then(r => r[0] || null)

/**
 * Attach a verified number to an account that already exists, or take one away.
 *
 * `phone_verified_at` moves with the column for the same reason it is set in `createUser`:
 * there is no path that writes an unproven number, so the timestamp is not a second step
 * somebody could forget. Clearing sets it back to null rather than leaving a timestamp
 * describing a number the row no longer has.
 *
 * The unique index does the work of refusing a number that is already somebody else's — a
 * lookup before the write is a race, and this is the one write in the file where losing that
 * race would move an identity from one account to another.
 */
export const setPhone = (userId, phone, s = db()) =>
  s`update users set phone = ${phone}, phone_verified_at = now() where id = ${userId} returning *`
    .then(r => r[0] || null)

export const clearPhone = (userId, s = db()) =>
  s`update users set phone = null, phone_verified_at = null where id = ${userId} returning *`
    .then(r => r[0] || null)

/**
 * Put a confirmed address on an account, and the password that makes it a way in.
 *
 * `email_verified_at` is written here and nowhere else. The column has been in the schema since
 * 001 and nothing ever wrote it — so every address in an older database is unverified, and
 * anybody could sign up with somebody else's. This function is the only path that sets it, and
 * it is only reachable from a code that was mailed to the address and typed back.
 *
 * The password is optional and usually not. An account created by phone has no `password_hash`,
 * so an address on its own buys nothing — it cannot sign anybody in and cannot be reset, since
 * a reset needs a password to replace. Setting both at once is what makes this a second way in
 * rather than a contact detail.
 */
export async function setEmail(userId, email, { password = null } = {}, s = db()) {
  /* Two statements rather than one with a conditional fragment. The fragment version reads as
   * though the password is optional *to the update*, and it is not — either it is being set or
   * the column is being left exactly as it was, and those are different writes. */
  const [user] = password
    ? await s`update users set email = ${email}, email_verified_at = now(),
                password_hash = ${await hashPassword(password)}
              where id = ${userId} returning *`
    : await s`update users set email = ${email}, email_verified_at = now()
              where id = ${userId} returning *`
  return user || null
}

/**
 * Take the address off, and the password with it.
 *
 * The password goes because it cannot be used without the address — sign-in is the pair, and a
 * `password_hash` with no `email` beside it is a credential nothing can present. Leaving it
 * would also make the last-way-in check in the route wrong: it asks whether a password exists,
 * and a dangling hash would answer yes for an account that cannot actually be signed into.
 */
export const clearEmail = (userId, s = db()) =>
  s`update users set email = null, email_verified_at = null, password_hash = null
    where id = ${userId} returning *`.then(r => r[0] || null)

export const listCredentials = (userId, s = db()) =>
  s`select * from credentials where user_id = ${userId}`

export const findCredential = (id, s = db()) =>
  s`select * from credentials where id = ${id}`.then(r => r[0] || null)

export const saveCredential = (c, s = db()) => s`
  insert into credentials (id, user_id, public_key, counter, transports)
  values (${c.id}, ${c.userId}, ${c.publicKey}, ${c.counter ?? 0}, ${c.transports ?? []})
  on conflict (id) do update set counter = excluded.counter, last_used_at = now()`

export const touchCredential = (id, counter, s = db()) =>
  s`update credentials set counter = ${counter}, last_used_at = now() where id = ${id}`

/**
 * Remember which language this person reads.
 *
 * The column existed from 001 and nothing ever wrote it, so it was `'en'` for everybody — which
 * quietly made two features monolingual. `interpretBrief` and `explainChange` both take
 * `user.locale` and are commented as answering "in the language this person set on their
 * profile"; with the column frozen at the default, a Farsi coach's client got an English note
 * from a layer that had Farsi support sitting unreachable behind it.
 *
 * Not part of sync: this is a property of the account rather than a row the app edits offline,
 * and the client pushes it when it changes.
 */
export const setLocale = (userId, locale, s = db()) =>
  s`update users set locale = ${locale} where id = ${userId} returning locale`
    .then(r => r[0]?.locale ?? null)

/** Invalidate every session this user has anywhere. */
export const bumpSessionVersion = (userId, s = db()) =>
  s`update users set session_version = session_version + 1 where id = ${userId}
    returning session_version`.then(r => r[0]?.session_version)

export const setDisabled = (userId, disabled, s = db()) =>
  s`update users set disabled_at = ${disabled ? s`now()` : null} where id = ${userId}`

/**
 * Promote or demote, so that becoming an admin is not a `psql` prompt.
 *
 * `is_admin` shipped in 001 and nothing has ever written it: SELF_HOSTING.md tells a new
 * operator to run an `update users set is_admin = true` by hand, and there was no second way.
 * That is defensible for the *first* admin — the check that you own the box is that you can
 * reach its database — and indefensible for every one after them, which is what this is for.
 *
 * Omitting a flag leaves it alone rather than clearing it. `coalesce` rather than a composed
 * `set` clause because there is no dynamic-SQL idiom anywhere else in this package, and the
 * alternative — always writing both — turns "make them a coach" into a silent demotion the
 * moment a caller forgets to send back a flag it never meant to touch.
 */
export const setRoles = (userId, { isCoach, isAdmin } = {}, s = db()) =>
  s`update users
       set is_coach = coalesce(${isCoach ?? null}, is_coach),
           is_admin = coalesce(${isAdmin ?? null}, is_admin)
     where id = ${userId}
     returning id, name, is_coach, is_admin`.then(r => r[0] ?? null)

/**
 * How many admins could actually sign in right now.
 *
 * Disabled accounts are not counted, and that is the whole point of the function: an instance
 * whose only admin is disabled has no administrator, which is the same lockout as having
 * demoted them. Both routes that can produce it ask this first.
 */
export const activeAdminCount = (s = db()) =>
  s`select count(*)::int as n from users where is_admin and disabled_at is null`
    .then(r => r[0].n)

export const publicUser = u => u && ({
  id: u.id, name: u.name, email: u.email, phone: u.phone, units: u.units, locale: u.locale,
  /* Whether the address has been proved, which the client needs and `email` alone cannot say.
   * There is no `phoneVerified` beside it because there is no such thing as an unverified
   * number here — a phone only ever reaches the column by way of a code sent to it. */
  emailVerified: !!u.email_verified_at,
  isCoach: u.is_coach, isAdmin: u.is_admin
})
