-- GymBuddy 005 — a way back into an account.
--
-- Email and password sign-in shipped without one, which made "I forgot my password" the end of
-- an account rather than an inconvenience. Passkeys have no equivalent problem — the
-- authenticator holds the secret and its own recovery is the platform's job — but the whole
-- point of adding passwords was that passkey-only is a dead end for a mainstream signup, and a
-- password with no reset is a different dead end at the same door.
--
-- ## The token is not in this table
--
-- What is stored is `sha256(token)`. The token itself is 32 random bytes that exist in exactly
-- two places: the URL in the email, and the request that comes back with it. A dump of this
-- table, a replica, a backup on somebody's laptop — none of them contains anything that opens
-- an account.
--
-- SHA-256 rather than the scrypt used for passwords, and that is not an oversight. A password
-- is low-entropy and human-chosen, so the hash has to be slow enough to make guessing it
-- expensive. This is 256 bits of `randomBytes`; there is nothing to guess, and a slow hash
-- would only make the endpoint slower. The property being bought is "a stolen database does not
-- contain live tokens", which a fast hash gives just as completely.
--
-- ## One use, one hour
--
-- `used_at` rather than a delete, so a link that has already been spent can say so instead of
-- looking identical to one that never existed — and so the sweeper, not the request, is what
-- takes the row away. An hour is stated in the email in thirteen languages; it is not a knob.
--
-- Resetting also bumps `session_version`, which signs the account out everywhere. That is the
-- correct blast radius for "somebody may have had my password": the reset is worth nothing if
-- whoever else was in the account keeps their cookie.

create table password_resets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  -- The only copy of anything token-shaped, and it is one way. See the header.
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at    timestamptz,
  -- What the request looked like, for an operator asking why somebody got five of these. Not
  -- used for any decision — an address is not an identity, and rate limiting is keyed by the
  -- account being asked about rather than by where the asking came from.
  requested_ip text,
  created_at timestamptz not null default now()
);

-- The lookup a reset does: by hash, and only ever by hash.
create index password_resets_user_idx on password_resets (user_id, created_at desc);

-- What the sweeper takes away — spent or expired, whichever came first. Partial, because the
-- rows worth keeping are the handful that are still live.
create index password_resets_spent_idx on password_resets (expires_at)
  where used_at is not null;
