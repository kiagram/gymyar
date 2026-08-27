-- GymYar 008 — the things done between sessions.
--
-- A programme says what to do three times a week. Most of what decides whether it works happens
-- on the other four days, and none of it is a set: the walk, the water, the protein, going to
-- bed. A coach can already ask about those once a week (007) and can already read every rep —
-- what they cannot do is agree with somebody that a thing will happen daily and then both see
-- whether it did.
--
-- ## Both tables are the client's, and the coach only ever proposes
--
-- A habit lands the same way a programme does: the coach proposes, the client accepts, and what
-- is written afterwards is the client's own row through their own sync. `author_id` and
-- `assigned_by` are copied straight from `routines` — same columns, same meaning, same reason —
-- so a habit a coach suggested and a habit somebody made up for themselves are the same kind of
-- row differing only in who is recorded as having written it. 006's `kind` is what carries it,
-- and this is the migration that proves that seam was worth building.
--
-- ## A tick is a row, and its absence is the whole answer
--
-- `habit_ticks` has no `done` column. The row *is* the tick; unticking is a delete, which
-- becomes a `deleted_at` because sync needs a tombstone to tell "they unticked it" apart from
-- "this device has not heard about it yet". A boolean column would have made a third state —
-- a row saying false — that means exactly what no row means, and every query would have had to
-- remember which of the two it was looking at.
--
-- There is no count either. "Eight glasses of water" is a number, and numbers belong in a
-- check-in's `measure` field where they already have bounds and a unit. A habit is a yes.
--
-- ## Why the key is (user, habit, date)
--
-- `habit_id` alone is unique — it is a primary key — so the user is strictly redundant in this
-- key. It is there because every synced table in this schema is scoped by user in every query
-- it appears in, and a key that does not start with the column all the reads filter on is an
-- index the reads cannot use. The redundancy costs 16 bytes a row and buys the index everything
-- else already has.

create table habits (
  -- Client-generated, like a routine's and for the same reason: it is created offline and has
  -- to have a name before any server hears about it. Collisions across accounts are handled
  -- where routines handle them — the upsert is scoped to the owner, so the loser of an
  -- astronomically unlikely clash gets a refusal rather than somebody else's row.
  id              text primary key,
  user_id         uuid not null references users(id) on delete cascade,

  -- Who wrote it and which relationship it arrived through, exactly as on `routines`. Both
  -- survive the other party leaving: a habit somebody kept for a year does not stop being
  -- theirs because the coach who suggested it deleted their account.
  author_id       uuid references users(id) on delete set null,
  assigned_by     uuid references coaching_links(id) on delete set null,

  title           text not null,

  -- How many days a week counts as done. Seven is "daily" and is the common case; three is a
  -- habit with rest built into it. Not zero — a habit nobody has to do on any day is not a
  -- habit, it is a note — and not more than seven, which is not a week.
  target_per_week int  not null default 7 check (target_per_week between 1 and 7),

  position        int  not null default 0,

  -- Retired, but its ticks are still history worth reading. Distinct from `deleted_at`, which
  -- is the sync tombstone and means the row is gone: archiving takes a habit off today's list
  -- and keeps the six months of it that already happened.
  archived_at     timestamptz,

  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create index habits_user_idx on habits (user_id, position) where deleted_at is null;

create table habit_ticks (
  user_id    uuid not null references users(id) on delete cascade,
  habit_id   text not null references habits(id) on delete cascade,
  on_date    date not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, habit_id, on_date)
);
-- The grid a person actually looks at: one habit, the last few weeks.
create index habit_ticks_habit_idx on habit_ticks (habit_id, on_date desc) where deleted_at is null;

-- `habits` joins the scopes a client can grant, and joins the default invitation with it.
--
-- Its own scope rather than riding `checkins`, which is the nearest thing and still not the same
-- thing. A weekly check-in is a summary somebody composed; a tick grid is a day-by-day record of
-- what a person did with their evenings. Granting the first has never been agreement to the
-- second, and this codebase has one answer for that shape of question — ask separately.
--
-- In the default, though, unlike `photos`. A coach who agrees a daily habit with somebody and
-- then cannot see whether it happened has been handed a feature that does nothing, and the line
-- these defaults draw is whether the data exists *because* coaching asked for it. A habit does.
-- A photograph of somebody's body does not.
alter table coaching_links
  alter column scopes set default '{programmes,workouts,checkins,habits}';
