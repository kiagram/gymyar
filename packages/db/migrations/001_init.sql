-- GymBuddy 001 — replaces openGym's state-<uid>.json blob with rows.
--
-- Two id conventions, on purpose:
--   * server-minted uuid for identity and coaching (users, sessions, links, revisions)
--   * client-minted text for a user's own syncable data (routines, workouts, sets, …)
-- The second is what makes offline-first work: a phone in a basement mints the id for a set
-- it just logged and that id is final, so nothing has to be renumbered when it reconnects.

create table users (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  email             text,
  email_verified_at timestamptz,
  password_hash     text,
  locale            text not null default 'en',
  units             text not null default 'kg' check (units in ('kg','lb')),
  is_coach          boolean not null default false,
  is_admin          boolean not null default false,
  disabled_at       timestamptz,
  session_version   int  not null default 1,   -- bump = sign out everywhere
  created_at        timestamptz not null default now()
);
create unique index users_email_key on users (lower(email)) where email is not null;

create table credentials (
  id           text primary key,               -- base64url credential id
  user_id      uuid not null references users(id) on delete cascade,
  public_key   text not null,
  counter      bigint not null default 0,
  transports   text[] not null default '{}',
  last_used_at timestamptz,
  created_at   timestamptz not null default now()
);
create index credentials_user_idx on credentials (user_id);

create table identities (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  provider   text not null check (provider in ('apple','google')),
  subject    text not null,
  created_at timestamptz not null default now(),
  unique (provider, subject)
);

create table invites (
  code       text primary key,
  created_by uuid references users(id) on delete set null,
  used_by    uuid references users(id) on delete set null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create table push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  endpoint   text not null unique,
  keys       jsonb not null,
  created_at timestamptz not null default now()
);
create index push_user_idx on push_subscriptions (user_id);

-- ── exercises ───────────────────────────────────────────────────────────────────
-- Library rows (owner_id null) and a user's own rows share one table, so every set
-- carries a real foreign key. Media sits behind image_url/animation_url: replacing the
-- Gym visual assets is an UPDATE, not a migration.
create table exercises (
  id            text primary key,
  owner_id      uuid references users(id) on delete cascade,
  library_key   text unique,
  name          text not null,
  body_part     text not null,
  target        text,
  equipment     text,
  secondary     text[] not null default '{}',
  steps         text[] not null default '{}',
  description   text,
  is_cardio     boolean not null default false,
  is_bodyweight boolean not null default false,
  per_side      boolean not null default false,
  image_url     text,
  animation_url text,
  attribution   text,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  check (owner_id is not null or library_key is not null)
);
create index exercises_owner_idx on exercises (owner_id) where owner_id is not null;
create index exercises_body_part_idx on exercises (body_part);
create index exercises_name_idx on exercises (lower(name));

-- ── coaching ────────────────────────────────────────────────────────────────────
create table coaching_links (
  id           uuid primary key default gen_random_uuid(),
  coach_id     uuid not null references users(id) on delete cascade,
  client_id    uuid references users(id) on delete cascade,
  invite_email text,
  invite_code  text unique,
  status       text not null default 'pending'
                 check (status in ('pending','active','paused','ended','declined')),
  -- what the client has agreed the coach may see. Never assumed: a client can share
  -- programmes without sharing what they weigh.
  scopes       text[] not null default '{programmes,workouts}',
  invited_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  ended_at     timestamptz,
  check (client_id is not null or invite_email is not null)
);
create unique index coaching_links_pair_idx on coaching_links (coach_id, client_id)
  where client_id is not null and status in ('pending','active','paused');
create index coaching_links_client_idx on coaching_links (client_id) where status = 'active';
create index coaching_links_coach_idx on coaching_links (coach_id);

-- ── training content ────────────────────────────────────────────────────────────
create table routines (
  id            text primary key,
  user_id       uuid not null references users(id) on delete cascade,
  author_id     uuid references users(id) on delete set null,
  assigned_by   uuid references coaching_links(id) on delete set null,
  name          text not null,
  emoji         text,
  policy        text not null default 'linear',
  policy_config jsonb not null default '{}',
  position      int  not null default 0,
  exercises     jsonb not null default '[]',   -- ordered, with superset grouping and per-ex config
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index routines_user_idx on routines (user_id, updated_at desc);

create table week_plan (
  user_id    uuid not null references users(id) on delete cascade,
  weekday    int  not null check (weekday between 0 and 6),
  routine_id text,
  updated_at timestamptz not null default now(),
  primary key (user_id, weekday)
);

create table day_overrides (
  user_id    uuid not null references users(id) on delete cascade,
  on_date    date not null,
  routine_id text,                              -- null = rest day
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, on_date)
);

-- ── logged training ─────────────────────────────────────────────────────────────
create table workouts (
  id            text primary key,
  user_id       uuid not null references users(id) on delete cascade,
  routine_id    text,
  routine_name  text,
  started_at    timestamptz not null,
  finished_at   timestamptz,
  bodyweight_kg numeric(6,2),
  notes         text,
  prs           text[] not null default '{}',   -- exercise ids that hit a record in this session
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index workouts_user_idx on workouts (user_id, started_at desc);
-- the coach dashboard's "who actually trained this week" query rides this one
create index workouts_done_idx on workouts (user_id, finished_at desc) where finished_at is not null;

-- Sets are rows, not JSON inside the workout. This is the table the coach dashboard, the
-- 1RM curves and the AI's "what has this person actually been lifting" all read, and none
-- of those should have to traverse JSONB to answer.
--
-- A workout and its sets still sync as ONE unit: the client posts the whole workout, the
-- server replaces its set rows in a transaction. Nobody ever edits someone else's workout,
-- so there is no second writer to reconcile and no reason to sync sets individually.
create table workout_sets (
  id           text primary key,
  workout_id   text not null references workouts(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  exercise_id  text not null,
  position     int  not null,
  -- one of: weight+reps · seconds (planks, carries) · distance+seconds (cardio)
  weight_kg    numeric(7,2),
  reps         int,
  seconds      int,
  distance_m   numeric(9,2),
  per_side     boolean not null default false,
  effort_value numeric(3,1),                    -- always stored as RIR
  effort_scale text check (effort_scale in ('rir','rpe')),
  is_warmup    boolean not null default false,
  done         boolean not null default true,   -- false = planned but skipped
  done_at      timestamptz not null default now()
);
create index workout_sets_workout_idx on workout_sets (workout_id, position);
-- progression and 1RM both read "this person, this exercise, newest first"
create index workout_sets_history_idx on workout_sets (user_id, exercise_id, done_at desc);

create table bodyweight_entries (
  id         text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  on_date    date not null,
  weight_kg  numeric(6,2) not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index bodyweight_day_idx on bodyweight_entries (user_id, on_date)
  where deleted_at is null;

create table user_settings (
  user_id    uuid primary key references users(id) on delete cascade,
  settings   jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- ── proposals ───────────────────────────────────────────────────────────────────
-- A coach never writes a client's routine. Their version lands here and the client
-- accepts it, so a client's own edit can never be erased by a coach's sync.
create table routine_revisions (
  id          uuid primary key default gen_random_uuid(),
  routine_id  text not null,
  user_id     uuid not null references users(id) on delete cascade,  -- whose plan it targets
  link_id     uuid not null references coaching_links(id) on delete cascade,
  proposed_by uuid not null references users(id) on delete cascade,
  payload     jsonb not null,
  note        text,
  status      text not null default 'pending'
                check (status in ('pending','accepted','declined','superseded')),
  proposed_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index revisions_user_idx on routine_revisions (user_id, status);
create unique index revisions_one_open_idx on routine_revisions (routine_id)
  where status = 'pending';

create table messages (
  id           uuid primary key default gen_random_uuid(),
  link_id      uuid not null references coaching_links(id) on delete cascade,
  sender_id    uuid not null references users(id) on delete cascade,
  body         text not null,
  workout_id   text,
  exercise_id  text,
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index messages_link_idx on messages (link_id, created_at desc);

-- ── sync ────────────────────────────────────────────────────────────────────────
-- One monotonic counter per user. A client stores the last cursor it saw and asks for
-- everything above it; that is the entire delta protocol.
create table sync_cursor (
  user_id uuid primary key references users(id) on delete cascade,
  value   bigint not null default 0
);

create table change_log (
  user_id    uuid not null references users(id) on delete cascade,
  cursor     bigint not null,
  table_name text not null,
  row_id     text not null,
  op         text not null check (op in ('upsert','delete')),
  at         timestamptz not null default now(),
  primary key (user_id, cursor)
);
create index change_log_row_idx on change_log (user_id, table_name, row_id);

-- Allocate the next cursor for a user, creating the counter row on first use.
create or replace function next_cursor(uid uuid) returns bigint as $$
  insert into sync_cursor (user_id, value) values (uid, 1)
  on conflict (user_id) do update set value = sync_cursor.value + 1
  returning value;
$$ language sql;

-- Record a change and return the cursor it was recorded at. Every write to a syncable
-- table goes through this; that is what lets a client pull a delta instead of the world.
create or replace function log_change(uid uuid, tbl text, rid text, operation text)
returns bigint as $$
declare c bigint;
begin
  c := next_cursor(uid);
  insert into change_log (user_id, cursor, table_name, row_id, op)
  values (uid, c, tbl, rid, operation);
  return c;
end;
$$ language plpgsql;
