-- GymYar 010 — a phone number is an identity here.
--
-- Every way into this app so far assumed something the market it is built for often does not
-- have. A passkey assumes a device and a browser that will do WebAuthn. An email address
-- assumes an inbox somebody reads — and in Iran an email account is largely a thing you hold in
-- order to sign up to foreign services, most of which will not take an Iranian card or address
-- anyway. The reset email this schema already supports has to cross a border to arrive, from a
-- relay whose reputation is not ours, into filters that distrust the whole origin.
--
-- What a coach and their clients all have is a mobile number, and a domestic SMS gateway is the
-- one delivery channel in this product that is not somebody else's geopolitics. So: a third
-- door into the same session, alongside the two that already exist rather than instead of them.
--
-- ## `phone` is E.164, and the index is what makes that matter
--
-- `+989123456789`. One spelling, minted by `normalizePhone` in packages/domain/src/phone.js,
-- which is imported by the client and the server so that the number stored and the number
-- looked up cannot drift. The column would otherwise hold `09123456789`, `+98 912 345 6789`
-- and `۰۹۱۲۳۴۵۶۷۸۹` as three different people.
--
-- Unique, partial on `not null`, exactly like `users_email_key` above it: a number identifies
-- one account, and the rows with no number at all — every existing user, and every passkey
-- signup after this — do not collide with each other.
--
-- `phone_verified_at` rather than a boolean, matching `email_verified_at` from 001. A number
-- only ever arrives here by way of a code that was texted to it and typed back, so in practice
-- it is set at the same moment the column is written; it is a timestamp because "when did this
-- person last prove they hold that SIM" is the question asked after a number is recycled, and
-- Iranian numbers are recycled.
--
-- ## The codes are not in this table, and the hash is not a plain SHA-256
--
-- `phone_codes` stores `hmac(key, code || phone)`, never the code. That is the same invariant as
-- `password_resets` in 005, arrived at differently: there, the token is 256 bits of randomness
-- and a plain SHA-256 is enough, because there is nothing to guess. A one-time code is six
-- digits. A million-entry rainbow table for SHA-256 is a few seconds of work, so a dump of this
-- table with a plain hash in it would be a dump of live codes — and the phone number is in the
-- same row, so a per-row salt is not enough either; what is needed is a secret the dump does
-- not contain. Hence a keyed hash, with the key derived from `SESSION_SECRET`.
--
-- ## Attempts are a column because the code is short
--
-- Six digits is one in a million per guess, which is plenty against a person and nothing at all
-- against a script that may try five thousand times. `attempts` is incremented on every wrong
-- answer and the code is dead at MAX_ATTEMPTS, so the number of guesses a code will ever face
-- is a small constant rather than however many requests the rate limiter lets through.
--
-- ## Why rows for spent and expired codes stay a while
--
-- The sweeper takes them, not the request — same as password resets. "Was a code sent to this
-- number, when, and how many times" is the question an operator gets asked when somebody's
-- signup did not work, and a row deleted on use cannot answer it. It is also how the resend
-- cooldown and the per-number daily ceiling are counted: both are `count(*) where created_at >`,
-- which needs the rows that are already spent.

alter table users add column phone text;
alter table users add column phone_verified_at timestamptz;

-- One number, one account. Partial, so the accounts with no number do not collide — see above.
create unique index users_phone_key on users (phone) where phone is not null;

create table phone_codes (
  id          uuid primary key default gen_random_uuid(),
  -- E.164, and not a foreign key to users: the whole point is that this is sent *before* there
  -- is an account. A row here is a claim about a number, not about a person.
  phone       text not null,
  -- The only copy of anything code-shaped, and it is keyed — see the header.
  code_hash   text not null,
  -- 'signup' or 'signin'. Recorded rather than enforced: which one a code turns out to be is
  -- decided when it is spent, by whether that number has an account by then. Kept because a
  -- flood of one kind and a flood of the other are different problems.
  purpose     text not null default 'signin' check (purpose in ('signup', 'signin')),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  attempts    int not null default 0,
  -- What the request looked like, for an operator asking why one number got twenty of these.
  -- Not used for any decision — see the note in 005 about carrier-grade NAT.
  requested_ip text,
  created_at  timestamptz not null default now()
);

-- The lookup a verification does: this number, still live. Everything else is a scan nobody runs.
create index phone_codes_live_idx on phone_codes (phone, created_at desc);

-- What the sweeper takes away, and what the cooldown counts.
create index phone_codes_expiry_idx on phone_codes (expires_at);
