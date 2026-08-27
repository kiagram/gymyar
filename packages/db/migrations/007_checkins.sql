-- GymYar 007 — the week, answered.
--
-- Coaching so far is a coach reading numbers a client's app recorded on its own: sets, loads,
-- what they weigh. None of it says whether the week was any good. A stalled lift and a stalled
-- lift after four nights of no sleep are the same rows and opposite problems, and the only
-- thing that separates them is somebody being asked.
--
-- ## The answer is the client's row, and the questions are the coach's
--
-- Same split as everywhere else here, for the same reason. A coach owns the *template* — which
-- questions, in what order — and writes it freely, because it is theirs. The client owns every
-- *answer*, written through their own sync like any other row they hold, which is what makes it
-- work on a phone with no signal and what stops a coach from ever authoring one.
--
-- A coach reads answers through the `checkins` scope. Not through authorship: a client with two
-- coaches answers once, and both see it if both were granted the scope. Which questions were
-- asked and who may read the replies are separate questions, and folding them together would
-- mean a client answering the same Saturday twice.
--
-- ## One a day, keyed like a weigh-in
--
-- `(user_id, on_date)` is the whole key. Not `(user_id, link_id, on_date)` — that would be a
-- second submission for a second coach, which is not a thing a person does: you describe your
-- week once. It is also the shape that already works. `bodyweight_entries` is keyed this way
-- precisely so that two offline devices recording the same day merge instead of colliding, and
-- a check-in has exactly that problem: an id generated per device would push two rows for one
-- Saturday and fail the whole transaction on the unique index.
--
-- ## What is not here
--
-- No photo column, and none is coming. A progress photo already exists as an attachment with a
-- date on it, gated on its own `photos` scope — and that scope is the entire point. Somebody
-- answering "how was your week" has not thereby agreed to be photographed, so a check-in asks
-- for a picture and the picture arrives down the path that already asked permission for one.
-- A column here would be a second, unasked-for consent wearing the first one's clothes.

create table checkin_templates (
  id          uuid primary key default gen_random_uuid(),
  coach_id    uuid not null references users(id) on delete cascade,
  title       text not null,
  -- `[{ key, type, label, required?, min?, max? }]`. Validated in the domain, by the same code
  -- on both sides of the wire — see `domain/src/checkin.js`.
  fields      jsonb not null default '[]',
  -- Archived, never deleted. An answer months old is only readable next to the question it
  -- answered, and a coach tidying their templates must not silently reword last spring.
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index checkin_templates_coach_idx on checkin_templates (coach_id) where archived_at is null;

-- Which template a coach put on a client, and the day it is due.
--
-- Keyed by the link rather than being two more columns on `coaching_links`, because a link is a
-- relationship and not a bag of whatever each feature needed. It also makes "no check-in on this
-- client" the absence of a row instead of two nulls that have to agree with each other.
--
-- One row per link: weekly, one template, one day. Fortnightly and monthly are deliberately not
-- here — a cadence that is not "every week" turns "is one due?" into calendar arithmetic against
-- a start date, in a product where the calendar is Jalali for most of its readers.
create table checkin_schedules (
  link_id     uuid primary key references coaching_links(id) on delete cascade,
  template_id uuid not null references checkin_templates(id) on delete cascade,
  -- `getDay()`'s numbering, 0 = Sunday, as `week_plan.weekday` already uses. Which weekday a
  -- reader's week *starts* on is a locale question and is not stored anywhere.
  weekday     int not null check (weekday between 0 and 6),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table checkins (
  user_id      uuid not null references users(id) on delete cascade,
  on_date      date not null,

  -- Which questions these are answers to. Null means the built-in set, which is what somebody
  -- with no coach answers — a check-in is a useful thing to keep for yourself, and requiring a
  -- template row per person to hold a constant would be a row per person holding a constant.
  --
  -- `set null` rather than `cascade` on purpose: a coach deleting their account must not take
  -- their clients' answers with it. The answers were never the coach's. What is lost is the
  -- wording of the questions, and an answer that has outlived its question reads as the
  -- built-in shape rather than as nothing.
  template_id  uuid references checkin_templates(id) on delete set null,

  -- `{ [field key]: value }`, shaped by the template and validated in the domain. A field the
  -- template no longer has is kept rather than dropped: it is what the person actually said.
  answers      jsonb not null default '{}',

  -- Null while it is a draft on somebody's phone. A half-filled check-in is still the client's
  -- row and still syncs; what it is not yet is an answer, and a coach's roster counts this.
  submitted_at timestamptz,

  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  primary key (user_id, on_date)
);
create index checkins_user_idx on checkins (user_id, on_date desc) where deleted_at is null;

-- `checkins` joins the scopes a client can grant. There is no constraint on the column to
-- widen — `coaching_links.scopes` is a text[] and the list of valid values lives in
-- `coaching.js`, where the consent screen and the enforcement read the same array.
--
-- The default below is what an invitation asks for when nothing says otherwise. Unlike
-- `photos`, this one belongs in it: a coaching relationship with no way to ask how the week
-- went is the relationship this migration exists to fix, whereas a photograph of somebody's
-- body is not something to request by default. Existing links are untouched, and must be —
-- a scope is granted by the client and cannot be backfilled on their behalf.
alter table coaching_links
  alter column scopes set default '{programmes,workouts,checkins}';
