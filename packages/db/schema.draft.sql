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
  exercise_id   uuid not null references exercises(id),
  position      int  not null,
  superset_group int,                           -- same value = logged back to back, one rest after
  config        jsonb not null default '{}',    -- sets, rep range, per-exercise policy override
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  rev           bigint not null default 1
);
create index on routine_exercises (routine_id, position);

-- Library exercises and a user's own live in one table: owner_id null means it came from the
-- 1,324-exercise library, otherwise it belongs to that user. One code path everywhere, real
-- foreign keys from every set, and — the reason this matters most — the media lives behind
-- image_url/animation_url, so replacing the Gym visual assets is an UPDATE, not a migration.
create table exercises (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid references users(id) on delete cascade,   -- null = library
  library_key   text unique,                                   -- upstream dataset id, library rows only
  name          text not null,
  body_part     text not null,
  target        text,
  equipment     text,
  description   text,
  is_cardio     boolean not null default false,
  is_bodyweight boolean not null default false,
  per_side      boolean not null default false,
  image_url     text,
  animation_url text,
  attribution   text,                                          -- required for Gym visual media
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  rev           bigint not null default 1,
  check (owner_id is not null or library_key is not null)
);
create index on exercises (owner_id) where owner_id is not null;
create index on exercises (body_part);

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

-- A coach never writes a client's routine directly — their version lands here and the client
-- accepts it. A client who tweaked their own routine can therefore never lose that tweak
-- silently, and every programme change carries who proposed it and when it was accepted.
create table routine_revisions (
  id            uuid primary key default gen_random_uuid(),
  routine_id    uuid not null references routines(id) on delete cascade,
  link_id       uuid not null references coaching_links(id) on delete cascade,
  proposed_by   uuid not null references users(id),
  -- full proposed routine + exercises, applied transactionally on accept
  payload       jsonb not null,
  note          text,
  status        text not null default 'pending'
                  check (status in ('pending','accepted','declined','superseded')),
  proposed_at   timestamptz not null default now(),
  resolved_at   timestamptz
);
create index on routine_revisions (routine_id, status);
-- one open proposal per routine; a newer one supersedes the last
create unique index on routine_revisions (routine_id) where status = 'pending';

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
  exercise_id   uuid not null references exercises(id),
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
create index on workout_sets (exercise_id, done_at desc);

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
  exercise_id   uuid references exercises(id),
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index on messages (link_id, created_at desc);

-- ── decisions taken ─────────────────────────────────────────────────────────────
-- 1. One `exercises` table with a nullable owner, referenced by real foreign keys, rather than
--    a shared text namespace. Media sits behind image_url/animation_url so the Gym visual assets
--    can be swapped without touching a single row of training history.
-- 2. Weights are stored in kg and converted for display. openGym stores whatever the user typed,
--    so the migration must read each profile's unit setting — assuming kg silently corrupts
--    every lb user's history.
-- 3. A coach's programme edit is a proposal the client accepts (`routine_revisions`), not a
--    direct write. Costs one table and one screen; buys an audit trail and makes it impossible
--    for a coach's sync to erase a client's own edit.
--
-- ── still open ──────────────────────────────────────────────────────────────────
-- a. Row-level security policies are not written yet. Every table above carries the column they
--    need; the policies themselves come with the first migration.
-- b. change_log has no retention policy. A device offline for a year should fall back to a full
--    resync rather than replaying two years of cursors — pick the cutoff when sync is built.
