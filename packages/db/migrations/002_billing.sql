-- GymBuddy 002 — subscriptions, and a record of every payment attempt.
--
-- Two tables and one hard rule: a payment is credited exactly once, and the database is what
-- enforces that rather than the code that happens to call it. See `payments_ref_key` below.
--
-- Nothing here is syncable. A subscription is an account fact, not training data — it is not in
-- SYNC_TABLES, does not go through log_change(), and never reaches a client's local state.

-- One row per coach who has ever started a trial or paid. Absence means "never coached", which
-- the domain reads as `none` rather than as an error.
create table subscriptions (
  user_id       uuid primary key references users(id) on delete cascade,
  -- Room for a second plan later without a migration. There is one today.
  plan          text not null default 'coach' check (plan in ('coach')),
  -- The whole state machine, as a date. Null means never paid. See domain/entitlement.js for
  -- why this is a date and not a subscription object: the gateways here do not do recurring.
  paid_through  timestamptz,
  trial_ends_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Every attempt, including the ones that went nowhere. An abandoned payment is not noise: it is
-- the difference between "the gateway is broken" and "nobody wanted to buy it", and you cannot
-- tell those apart after the fact if you only wrote down the successes.
create table payments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  gateway      text not null,                    -- 'zarinpal'
  -- The gateway's handle for this attempt, minted before the person is redirected. Null only
  -- in the window between our row and its answer.
  authority    text,
  -- The gateway's receipt, set at verification. Its uniqueness is the double-credit guard.
  ref_id       text,
  -- Minor units of `currency`, exactly as sent to the gateway. Storing what was sent rather
  -- than a prettier number is what makes a dispute answerable a year later.
  amount       bigint not null check (amount > 0),
  currency     text   not null default 'IRR' check (currency in ('IRR', 'IRT')),
  months       int    not null check (months > 0),
  status       text   not null default 'pending'
                 check (status in ('pending', 'paid', 'failed', 'abandoned')),
  -- What the gateway said, kept verbatim for the times its documentation and its behaviour
  -- disagree. Never rendered to anybody.
  detail       jsonb,
  created_at   timestamptz not null default now(),
  settled_at   timestamptz
);

-- An authority is one attempt. Two rows claiming the same one means we lost track of which.
create unique index payments_authority_key on payments (gateway, authority)
  where authority is not null;

-- The one that matters. Zarinpal's verify is not idempotent in the way you want — a second
-- call for an already-verified authority answers 101 ("verified") rather than an error, and a
-- callback can arrive twice (a refresh, a retry, a person opening the link on two devices).
-- Without this index the second arrival extends the subscription a second time, for free.
create unique index payments_ref_key on payments (gateway, ref_id)
  where ref_id is not null;

create index payments_user_idx on payments (user_id, created_at desc);
-- Reconciliation reads this: paid at the gateway, never confirmed here, because the person
-- closed the tab before the callback. There are no webhooks to hear it from any other way.
create index payments_pending_idx on payments (created_at) where status = 'pending';
