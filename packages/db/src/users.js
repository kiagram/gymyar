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
 * way of a code that was texted to it and typed back (see phone-codes.js), so the timestamp is
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

export const publicUser = u => u && ({
  id: u.id, name: u.name, email: u.email, phone: u.phone, units: u.units, locale: u.locale,
  isCoach: u.is_coach, isAdmin: u.is_admin
})
