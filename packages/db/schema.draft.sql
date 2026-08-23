-- GymBuddy — phase 2 data model (DRAFT, for review before any code is written against it)
--
-- Replaces openGym's single state-<uid>.json blob. The blob is why the coach features can't
-- exist: whole-state PUT with last-write-wins means a coach and a client writing in the same
-- window silently destroy one of the two edits, and the server can never query anything
-- because it never parses the JSON.
--
-- Three rules this schema commits to:
--   1. Every row that belongs to a person carries user_id. Tenancy is enforced by RLS, not by
--      remembering to add a WHERE clause.
--   2. Every syncable row carries (updated_at, deleted_at, rev) so the client can pull a delta
--      instead of the whole world, and a delete survives an offline device coming back.
--   3. A coach's edit and a client's edit are different rows, never the same row written twice.

create extension if not exists "pgcrypto";

-- ── identity ────────────────────────────────────────────────────────────────────
create table users (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email         citext unique,                 -- null for passkey-only profiles
  email_verified_at timestamptz,
  locale        text not null default 'en',
  units         text not null default 'kg' check (units in ('kg','lb')),
  is_coach      boolean not null default false,
  disabled_at   timestamptz,
  created_at    timestamptz not null default now()
);

-- WebAuthn credentials, carried over from openGym's db.json `creds`
create table credentials (
  id            text primary key,              -- base64url credential id
  user_id       uuid not null references users(id) on delete cascade,
  public_key    text not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  last_used_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index on credentials (user_id);

-- Non-passkey logins. Sign in with Apple is not optional: Apple requires it wherever another
-- third-party login is offered.
create table identities (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  provider      text not null check (provider in ('apple','google','email')),
  subject       text not null,
  created_at    timestamptz not null default now(),
  unique (provider, subject)
);

create table sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  version       int not null default 1,        -- bump to kill every session ("sign out everywhere")
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);
create index on sessions (user_id);

-- ── coaching ────────────────────────────────────────────────────────────────────
create table coaching_links (
  id            uuid primary key default gen_random_uuid(),
  coach_id      uuid not null references users(id) on delete cascade,
  client_id     uuid references users(id) on delete cascade,  -- null until the invite is accepted
  invite_email  citext,
  invite_token  text unique,
  status        text not null default 'pending'
                  check (status in ('pending','active','paused','ended')),
  -- what the client has agreed the coach may see. Never assume; a client can share programmes
  -- without sharing bodyweight.
  scopes        text[] not null default '{programmes,workouts}',
  invited_at    timestamptz not null default now(),
  accepted_at   timestamptz,
  ended_at      timestamptz,
  check (client_id is not null or invite_email is not null)
);
create unique index on coaching_links (coach_id, client_id) where client_id is not null;
create index on coaching_links (client_id) where status = 'active';

-- ── training content ────────────────────────────────────────────────────────────
-- A routine authored by a coach and a routine authored by a client are the same shape; author_id
-- says which, and assigned_by tells the client UI to show "from your coach".
create table routines (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,  -- whose plan this is
  author_id     uuid not null references users(id),                    -- who wrote it
  assigned_by   uuid references coaching_links(id) on delete set null,
  name          text not null,
  policy        text not null default 'linear',   -- see packages/domain/src/progression.js
  policy_config jsonb not null default '{}',
  position      int  not null default 0,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  rev           bigint not null default 1
);
create index on routines (user_id, updated_at);

create table routine_exercises (
  id            uuid primary key default gen_random_uuid(),
  routine_id    uuid not null references routines(id) on delete cascade,
  exercise_ref  text not null,                  -- library id, or custom_exercises.id
  position      int  not null,
  superset_group int,                           -- same value = logged back to back, one rest after
  config        jsonb not null default '{}',    -- sets, rep range, per-exercise policy override
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  rev           bigint not null default 1
);
create index on routine_exercises (routine_id, position);

create table custom_exercises (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  name          text not null,
  body_part     text not null,
  equipment     text,
  description   text,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  rev           bigint not null default 1
);
create index on custom_exercises (user_id);

-- weekday → routine, plus per-date overrides for "I'm moving Tuesday to Thursday"
create table week_plan (
  user_id       uuid not null references users(id) on delete cascade,
  weekday       int  not null check (weekday between 0 and 6),
  routine_id    uuid references routines(id) on delete set null,
  updated_at    timestamptz not null default now(),
  rev           bigint not null default 1,
  primary key (user_id, weekday)
);
create table day_overrides (
  user_id       uuid not null references users(id) on delete cascade,
  on_date       date not null,
  routine_id    uuid references routines(id) on delete set null,  -- null = rest day
  updated_at    timestamptz not null default now(),
  rev           bigint not null default 1,
  primary key (user_id, on_date)
);

-- ── logged training ─────────────────────────────────────────────────────────────
create table workouts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  routine_id    uuid references routines(id) on delete set null,
  started_at    timestamptz not null,
  finished_at   timestamptz,
  bodyweight_kg numeric(6,2),
  notes         text,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  rev           bigint not null default 1
);
create index on workouts (user_id, started_at desc);
-- the coach dashboard's "who trained this week" query lives on this index
create index on workouts (user_id, finished_at desc) where finished_at is not null;

create table workout_sets (
  id            uuid primary key default gen_random_uuid(),
  workout_id    uuid not null references workouts(id) on delete cascade,
  exercise_ref  text not null,
  position      int not null,
  -- one of weight+reps, seconds (planks, carries), or distance+seconds (cardio)
  weight_kg     numeric(7,2),
  reps          int,
  seconds       int,
  distance_m    numeric(9,2),
  per_side      boolean not null default false,
  effort_value  numeric(3,1),                   -- always stored as RIR
  effort_scale  text check (effort_scale in ('rir','rpe')),
  is_warmup     boolean not null default false,
  done_at       timestamptz not null default now()
);
create index on workout_sets (workout_id, position);
-- 1RM history and progression both read "this exercise, this user, newest first"
create index on workout_sets (exercise_ref, done_at desc);

create table bodyweight_entries (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  on_date       date not null,
  weight_kg     numeric(6,2) not null,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  rev           bigint not null default 1,
  unique (user_id, on_date)
);

-- ── sync ────────────────────────────────────────────────────────────────────────
-- Monotonic per-user counter. The client stores the last cursor it saw and asks for
-- everything above it — that is the whole delta-sync protocol.
create table sync_cursor (
  user_id       uuid primary key references users(id) on delete cascade,
  value         bigint not null default 0
);

create table change_log (
  user_id       uuid not null references users(id) on delete cascade,
  cursor        bigint not null,
  table_name    text not null,
  row_id        uuid not null,
  op            text not null check (op in ('upsert','delete')),
  at            timestamptz not null default now(),
  primary key (user_id, cursor)
);

-- ── messaging ───────────────────────────────────────────────────────────────────
create table messages (
  id            uuid primary key default gen_random_uuid(),
  link_id       uuid not null references coaching_links(id) on delete cascade,
  sender_id     uuid not null references users(id) on delete cascade,
  body          text not null,
  -- a comment pinned to a specific session or exercise, which is what coaching actually is
  workout_id    uuid references workouts(id) on delete set null,
  exercise_ref  text,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index on messages (link_id, created_at desc);

-- ── open questions for review ───────────────────────────────────────────────────
-- 1. exercise_ref is text, not a FK, because library exercises and custom exercises share one
--    namespace. Cleaner alternative: one `exercises` table with a nullable owner. Decide before
--    writing the migration — it is painful to change later.
-- 2. Weights are stored in kg and converted for display. openGym stores whatever the user typed.
--    The migration must therefore read each profile's unit setting, not assume kg.
-- 3. Should a coach's programme edit be a proposal the client accepts, or applied directly?
--    Proposals need a `routine_revisions` table; direct application does not. This is a product
--    decision that changes the schema.
