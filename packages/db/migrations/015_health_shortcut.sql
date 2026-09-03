-- GymYar 015 — the way an iPhone gets a session in without an app.
--
-- docs/WEARABLES.md M3. On iOS there is no native build to read HealthKit from and there is not
-- going to be one — RELEASING.md settles that, and it is a sanctions problem rather than an
-- engineering one. What iOS does have is Shortcuts, with a *when a workout ends* automation and
-- a step that POSTs. So the phone pushes the session to us instead of us reading it off the
-- phone: no Developer Program, no Mac, no store review, and nothing anybody can revoke.
--
-- Two things are needed for that and neither exists yet: something for the shortcut to
-- authenticate with, and somewhere to record which session this is so it can arrive twice.
--
-- ## Why a token and not the session cookie
--
-- A shortcut is not a browser. It has no cookie jar, it runs while the phone is locked, and it
-- runs unattended months after it was set up — so it needs a credential that does not expire
-- when a session does and does not disappear when somebody signs out on their laptop.
--
-- The token is never stored. What is stored is an HMAC of it under SESSION_SECRET, the same
-- construction and for the same reason as `verification_codes` in 010: a plain hash of a
-- high-entropy secret is fine in theory, and keying it means a leaked table alone is not enough
-- to mint a request. It is shown to its owner exactly once, at the moment it is created.
--
-- Revocation is a column rather than a delete, so `last_used_at` survives the revoking and a
-- person can see whether the token they just killed had been in use.
--
-- ## `external_id`, which is the whole of the idempotency
--
-- The plan's own words: automations re-fire, and people re-run a shortcut by hand when they
-- think nothing happened. HealthKit gives every workout a UUID that is stable across those, so
-- the second arrival of one session has to update the first row rather than add a second.
--
-- Unique per user and not globally: two accounts on one family phone can legitimately hold the
-- same HealthKit UUID, and a global constraint would let the first of them lock the second out
-- of their own session. Partial, so the column stays null on every workout logged in the app —
-- which is nearly all of them — without those colliding with each other.

create table health_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- The lookup the endpoint does on every request is by hash; this is the one the settings screen
-- does, and it only ever wants the live ones.
create index health_tokens_user_idx on health_tokens (user_id) where revoked_at is null;

alter table workouts add column external_id text;

create unique index workouts_external_idx on workouts (user_id, external_id)
  where external_id is not null;

comment on column workouts.external_id is
  'HealthKit UUID for a session pushed in by the iOS shortcut. Null for anything logged here.';
