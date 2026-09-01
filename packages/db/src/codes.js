/* One-time codes, minting one, spending one, and refusing to do either too often.
 *
 * Two channels, one implementation. A code texted to a phone and a code mailed to an address
 * want every property below — never stored, keyed hash, five guesses, a resend cooldown, a
 * daily ceiling per destination, an atomic claim that rolls back. A second copy of that for the
 * second channel is a second place for one of those to drift, and these are the invariants
 * whose drift hands somebody an account. `channel` is the only thing that differs, and it is a
 * column rather than a fork.
 *
 * A sibling of passwords.js, and worth reading next to it — the invariants are the same and one
 * of them is reached differently, which is the interesting part of this file.
 *
 * ## The code is never stored, and a plain hash would not be enough
 *
 * `password_resets` stores `sha256(token)` and that is sufficient there: the token is 32 random
 * bytes, so a dump of the table contains nothing anybody can invert. Six digits is a different
 * object. There are a million of them; hashing all million with SHA-256 is a few seconds, and
 * the destination sits in the same row, so salting per row buys nothing either — the attacker
 * has the salt. What makes a stolen table useless is a secret the table does not contain.
 *
 * So this is `HMAC(key, channel + ':' + address + ':' + code)`, keyed from `SESSION_SECRET` through a fixed
 * label — the same derivation, for the same reason, as the media URL key in
 * packages/storage/src/sign.js. Rotating the session secret invalidates every outstanding code,
 * which costs somebody one resend and is the correct blast radius for "the secret leaked".
 *
 * Binding the destination into the hash is not decoration: without it, a code minted for one
 * address verifies against a row minted for another, and the check that matters — that this
 * person holds *this* SIM, reads *this* inbox — is not being made.
 *
 * ## Three separate ceilings, because they stop three separate things
 *
 *   MAX_ATTEMPTS       guessing. Six digits is one in a million per try and nothing at all
 *                      against a script, so a code faces a small constant number of guesses and
 *                      then it is dead, regardless of how many requests get through.
 *   RESEND_COOLDOWN    a person pressing "resend" — and the flood one impatient tap can start.
 *   DAILY_CAP          somebody else's phone, or somebody else's inbox. Each message costs the
 *                      operator something and costs the recipient an interruption they did not
 *                      ask for; an unthrottled endpoint here is a way to use this instance to
 *                      pester a stranger all night, on whichever channel.
 *
 * The rate limiter in the API is not a substitute for any of them. It counts requests per
 * caller; these count messages per *number*, which is what the person being texted cares about.
 *
 * ## A resend kills the previous code
 *
 * Same as `createReset`: asking twice must not leave two working codes. The second message is
 * the one the person is looking at, and the first is a code sitting in a notification that no
 * longer opens anything. It is also what keeps "the live code for this number" a single row
 * rather than a set the verifier would have to search.
 */
import crypto from 'node:crypto'
import { db } from './index.js'

/** How long a code lives. Stated in the message — see packages/sms/src/templates.js. */
export const CODE_TTL_MS = 5 * 60 * 1000
/** Guesses one code will ever face before it is dead. */
export const MAX_ATTEMPTS = 5
/** How long before the same number may be texted again. */
export const RESEND_COOLDOWN_MS = 60 * 1000
/** Messages one number may be sent in a day. */
export const DAILY_CAP = 5
const DAY_MS = 24 * 60 * 60 * 1000

/* Domain separation. Changing this string invalidates every outstanding code and nothing else.
 * Still says `phone` because rotating it for a rename would log out nobody and invalidate every
 * code in flight for no reason at all — the label is an opaque constant, not a description. */
const LABEL = 'gymyar/phone-code/v1'

/** The channels a code can travel down. */
export const CHANNELS = ['sms', 'email']

/* Derived once per process. The secret cannot change under a running process, and doing an
 * HMAC per verification to rediscover the same 32 bytes is work for nobody. */
let key = null
function codeKey() {
  if (key) return key
  const secret = process.env.PHONE_CODE_SECRET || process.env.SESSION_SECRET
  if (!secret) throw new Error('verification codes need SESSION_SECRET — a code hashed with nothing is a code stored in the clear')
  key = crypto.createHmac('sha256', secret).update(LABEL).digest()
  return key
}
/** For tests, and for nothing else: the key is derived from an environment read at first use. */
export const _resetKey = () => { key = null }

/* The destination is inside the hash, so a code minted for one address cannot be spent on
 * another — and the channel is too, so a code mailed to `sam@x.test` is not also a code for a
 * phone number that happens to be spelled the same way. Neither is a hypothetical worth
 * leaving open for the cost of two extra characters. */
const hashCode = (channel, address, code) =>
  crypto.createHmac('sha256', codeKey()).update(`${channel}:${address}:${code}`).digest('base64url')

/**
 * Six digits, uniformly.
 *
 * `randomInt` rather than `randomBytes % 1000000`, which is biased — slightly, in a way that
 * makes some codes likelier than others, which is exactly the kind of thing nobody notices and
 * an attacker does. Padded rather than shifted into range: `000123` is a perfectly good code,
 * and excluding the leading-zero sixth of the space to avoid a `padStart` would cost more
 * entropy than the shortcut is worth.
 */
export const mintCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')

/**
 * How many messages this number has been sent recently, and when the last one went.
 *
 * Counted from the rows themselves — spent and expired included, which is why the sweeper keeps
 * them for a day rather than the request deleting them.
 */
async function recent(channel, address, now, s) {
  const [row] = await s`
    select
      count(*) filter (where created_at > ${new Date(now - DAY_MS)})::int as today,
      max(created_at) as last_at
    from verification_codes where channel = ${channel} and address = ${address}`
  return { today: row?.today ?? 0, lastAt: row?.last_at ? new Date(row.last_at).getTime() : null }
}

/**
 * Mint a code for this number, or say why not.
 *
 * Returns the code — the only time it exists outside the message — or `{ ok: false }` with the
 * reason and how long to wait. Not a throw: a cooldown is an ordinary answer to an ordinary
 * request, and the screen that asked has a countdown to render either way.
 */
export async function requestCode({ channel = 'sms', address, purpose = 'signin', ip = null, now = Date.now() }, s = db()) {
  if (!address) throw new Error('requestCode needs an address')
  if (!CHANNELS.includes(channel)) throw new Error(`unknown channel: ${channel}`)

  const { today, lastAt } = await recent(channel, address, now, s)
  if (lastAt !== null && now - lastAt < RESEND_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', retryAfter: Math.ceil((RESEND_COOLDOWN_MS - (now - lastAt)) / 1000) }
  }
  if (today >= DAILY_CAP) {
    return { ok: false, reason: 'daily', retryAfter: Math.ceil(DAY_MS / 1000) }
  }

  const code = mintCode()
  const expiresAt = new Date(now + CODE_TTL_MS)
  await s.begin(async tx => {
    // The previous code stops working the moment a new one is sent — see the header. Scoped to
    // the channel, so confirming an address does not silently kill a sign-in code in flight to
    // the same person's phone.
    await tx`update verification_codes set used_at = now()
             where channel = ${channel} and address = ${address} and used_at is null`
    /* `created_at` is written rather than defaulted, so that the cooldown and the daily
     * ceiling are read off the same clock they are enforced against. Left to `default now()`
     * it is the database's clock, and every caller-supplied `now` — which is how this module
     * is testable without sleeping for a minute — would be compared against a timestamp from
     * somewhere else. Milliseconds of skew, and a cooldown that is off by exactly that. */
    await tx`
      insert into verification_codes (channel, address, code_hash, purpose, expires_at, requested_ip, created_at)
      values (${channel}, ${address}, ${hashCode(channel, address, code)}, ${purpose}, ${expiresAt}, ${ip}, ${new Date(now)})`
  })
  return { ok: true, code, expiresAt }
}

/**
 * Spend a code, or say what was wrong with it.
 *
 * Every outcome that is not `ok` is deliberately not told apart by the caller's *message* — the
 * API says one thing for a wrong code and an expired one — but they are distinguished here,
 * because an operator reading a log and a screen deciding whether to offer "send a new code"
 * both need to know which happened.
 *
 * The row is locked and spent inside one transaction, so two requests carrying the same code
 * race the database rather than each other and exactly one wins. A read-then-write would let a
 * double-tap through twice, which for a signup means two accounts on one number.
 *
 * ## `then` — a code is spent only if what it was for worked
 *
 * The optional callback runs inside that transaction, after the code matched and before it is
 * marked used, and is handed the transaction to do its own writes on. Whatever it returns comes
 * back as `result`; whatever it *throws* rolls the whole thing back, which leaves the code live.
 *
 * That is not a convenience. Without it, every refusal that comes after the code is checked —
 * this is a new number and nobody said what to call them, the invite code was wrong, the account
 * is disabled — burns the code, and the person is told to go and wait a minute for another text
 * because they left a field blank. With it, the account and the spending of the code are one
 * atomic act: either somebody is signed in, or nothing happened and the code they are holding
 * still works.
 */
export async function claimCode({ channel = 'sms', address, code, now = Date.now(), then = null }, s = db()) {
  /* A missing destination is a caller that has been refactored badly, not a person who typed
   * the wrong thing — and answering `{ ok: false, reason: 'wrong' }` for it makes the two
   * indistinguishable. That is not hypothetical: renaming this parameter left one of four call
   * sites passing the old name, and the endpoint went on politely rejecting every correct code
   * anybody typed. A throw is the difference between a red test and a mystery. */
  if (!address) throw new Error('claimCode needs an address')
  if (!CHANNELS.includes(channel)) throw new Error(`unknown channel: ${channel}`)
  if (!code) return { ok: false, reason: 'wrong' }

  return s.begin(async tx => {
    /* `for update` rather than a bare select: two guesses arriving together must not both read
     * `attempts = 4` and both be allowed a try. */
    const [row] = await tx`
      select * from verification_codes
      where channel = ${channel} and address = ${address} and used_at is null
      order by created_at desc limit 1
      for update`

    if (!row) return { ok: false, reason: 'none' }
    if (new Date(row.expires_at).getTime() <= now) return { ok: false, reason: 'expired' }
    if (row.attempts >= MAX_ATTEMPTS) {
      await tx`update verification_codes set used_at = now() where id = ${row.id}`
      return { ok: false, reason: 'exhausted' }
    }

    const expected = Buffer.from(row.code_hash, 'base64url')
    const actual = Buffer.from(hashCode(channel, address, String(code)), 'base64url')
    // Constant time, out of habit rather than necessity — the attacker already knows the code
    // is six digits, and this costs nothing.
    const match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual)

    if (!match) {
      const [bumped] = await tx`
        update verification_codes set attempts = attempts + 1 where id = ${row.id} returning attempts`
      const left = Math.max(0, MAX_ATTEMPTS - bumped.attempts)
      // The last wrong guess kills the code rather than leaving a dead row that says "0 left".
      if (left === 0) await tx`update verification_codes set used_at = now() where id = ${row.id}`
      return { ok: false, reason: 'wrong', attemptsLeft: left }
    }

    /* Before the code is marked used, and inside the same transaction — see the header. A
     * throw from here takes the `used_at` update with it. */
    const result = then ? await then(tx, { purpose: row.purpose }) : null

    await tx`update verification_codes set used_at = now() where id = ${row.id}`
    return { ok: true, purpose: row.purpose, result }
  })
}

/**
 * Rows that can no longer do anything: spent, or expired unspent.
 *
 * Kept for a day after they die rather than deleted on the spot, for the reason 005 gives about
 * password resets and for one more: the cooldown and the daily ceiling are counted off these
 * rows, so a sweeper that ran on the minute would reset both.
 */
export async function purgeDeadCodes({ keepHours = 24, now = Date.now() } = {}, s = db()) {
  const cutoff = new Date(now - keepHours * 60 * 60 * 1000)
  const rows = await s`
    delete from verification_codes
    where (used_at is not null and used_at < ${cutoff})
       or (used_at is null and expires_at < ${cutoff})
    returning id`
  return rows.length
}

/** Whether this destination has a code outstanding. Used by the tests and by an operator. */
export const liveCodeFor = (address, channel = 'sms', s = db()) => s`
  select count(*)::int as n from verification_codes
  where channel = ${channel} and address = ${address} and used_at is null and expires_at > now()`
  .then(r => r[0].n)
