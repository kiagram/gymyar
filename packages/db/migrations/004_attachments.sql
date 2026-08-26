-- GymBuddy 004 — the index for bytes that are not in this database.
--
-- Every table before this one holds the thing itself: a set is its numbers, a message is its
-- text, and a pg_dump is the whole of what a person has. Form-check video is not that, so this
-- table holds everything *about* an upload and `packages/storage` holds the upload. The row is
-- the index; the volume is a bag of bytes with no opinions.
--
-- That split is why `storage_key` is unique. It is the only link between the two halves, and a
-- second row claiming the same key would make "delete this attachment" ambiguous in the worst
-- possible way — one row's deletion taking away another row's bytes. The key is derived from
-- `id`, so uniqueness is already true; the constraint is what makes it enforced rather than
-- observed.
--
-- ## The row comes first, and that is the whole reconciliation story
--
-- An upload is two writes to two systems that cannot share a transaction, so one of them is
-- going to be first and the choice decides which failure is recoverable.
--
-- Bytes first would mean a crash between the two leaves an object on the volume that nothing
-- knows about. Nothing *can* know about it: `packages/storage` has no `list` method, on
-- purpose, because a caller listing storage is a caller asking the volume a question the
-- database is supposed to answer. An orphan created that way is unfindable by design, and it
-- is unfindable forever.
--
-- So the row is written first, with `uploaded_at` null, and the bytes follow. Every object on
-- the volume has a row pointing at it before it exists, which makes the sweeper's job finite:
-- a row still null minutes later is an upload that died, and its bytes — which may or may not
-- have landed — are deleted by key, idempotently. `stat` answers the only question left, which
-- is whether the object a live row names is really there.
--
-- The other half of that is `orphaned_media` at the bottom of this file: a key outlives its
-- row, so a row removed by something other than the sweeper — a cascade, most of all a deleted
-- account — does not take the only record of its bytes with it.
--
-- `uploaded_at` is therefore the readable flag, not a timestamp anybody displays: null means
-- half a file, and every read filters on it. `bytes` is null with it, because the size is not
-- known until the last byte arrives and a zero there would be a lie about an empty file.
--
-- ## Not a syncable table, deliberately
--
-- `attachments` does not go through `log_change()` and is not in `SYNC_TABLES`. Sync exists to
-- keep an offline working copy of a person's training on their phone, and an attachment cannot
-- take part in that honestly: the bytes are not on the phone, so a synced row would promise a
-- video the app cannot play with no signal. Attachments are read from their own endpoints when
-- a screen opens, which is the same rule coaching data already follows — and it is what keeps
-- a coach who watches a client's video from ending up with that client's row in their own
-- state.
--
-- ## Who owns an attachment, and who may see it
--
-- `owner_id` is whoever uploaded it, which is also whose account deletion takes it away and
-- whose prefix on disk it sits under. It is not the same question as who may *read* it, and
-- that question is answered by `subject`:
--
--   form_check  a lift, filmed. Owned by the client; a coach reads it with the `workouts`
--               scope, because it is a record of a session and rides the same permission.
--   progress    a photo on a date. Owned by the person in it, and gated on its own `photos`
--               scope — a body in a mirror is not covered by consent to see a weigh-in, and
--               anyone who thinks otherwise should not be building this.
--   message     anything attached to a coaching thread. Read by the two people in the thread,
--               which membership already decides; no scope of its own.
--
-- A coach never uploads into a client's account. `form_check` and `progress` are the client's
-- own rows for the same reason their training is: there is one writer, and it is them.

create table attachments (
  id          uuid primary key,
  owner_id    uuid not null references users(id) on delete cascade,
  subject     text not null check (subject in ('form_check', 'progress', 'message')),
  -- Derived from the sniffed type, never from what the upload claimed. Kept alongside `mime`
  -- because every limit and every permission rule is about the kind, not the container.
  kind        text not null check (kind in ('photo', 'video', 'audio')),
  mime        text not null,
  storage_key text not null unique,

  -- Both null until the last byte lands. See the header: this is the flag every read filters
  -- on and the one the sweeper looks for, not a timestamp anything renders.
  bytes       bigint check (bytes > 0),
  uploaded_at timestamptz,

  -- What it documents. Which of these are set is a function of `subject` — see the check.
  workout_id  text,
  exercise_id text,
  on_date     date,
  message_id  uuid references messages(id) on delete cascade,

  caption     text,
  created_at  timestamptz not null default now(),

  -- Set the moment somebody deletes it, so it leaves every screen at the speed of one UPDATE
  -- rather than at the speed of whatever the volume is doing. The sweeper deletes the row —
  -- which tombstones its key — and then the bytes.
  deleted_at  timestamptz,

  -- A size with no upload, or an upload with no size, is a state no code path produces and
  -- none should have to reason about.
  constraint attachments_finished check ((bytes is null) = (uploaded_at is null)),

  -- Each subject carries exactly the context that identifies it, and none of the others. A
  -- progress photo with a workout id is not a harmless extra field: it is a row that two
  -- different queries would both find, under two different permission rules.
  constraint attachments_context check (
    case subject
      when 'form_check' then workout_id is not null and exercise_id is not null
                             and on_date is null and message_id is null
      when 'progress'   then on_date is not null
                             and workout_id is null and exercise_id is null and message_id is null
      when 'message'    then message_id is not null
                             and workout_id is null and exercise_id is null and on_date is null
    end
  ),

  -- A body is a photo and a lift is not a recording. The kinds a subject accepts are here
  -- rather than only in the upload route, because the route is one way in and this is the rule.
  constraint attachments_kind check (
    case subject
      when 'form_check' then kind in ('video', 'photo')
      when 'progress'   then kind = 'photo'
      when 'message'    then true
    end
  )
);

-- The three reads. Each is "one person's finished attachments for one thing", which is the only
-- shape any screen asks for, and each excludes the unfinished and the deleted rather than
-- filtering them afterwards.
create index attachments_workout_idx on attachments (owner_id, workout_id)
  where subject = 'form_check' and uploaded_at is not null and deleted_at is null;
create index attachments_progress_idx on attachments (owner_id, on_date desc)
  where subject = 'progress' and uploaded_at is not null and deleted_at is null;
create index attachments_message_idx on attachments (message_id)
  where subject = 'message' and uploaded_at is not null and deleted_at is null;

-- What the sweeper asks for, in its two halves: deleted on purpose, and abandoned halfway.
-- Both are small and usually empty, which is what a partial index is for.
create index attachments_deleted_idx on attachments (deleted_at)
  where deleted_at is not null;
create index attachments_unfinished_idx on attachments (created_at)
  where uploaded_at is null and deleted_at is null;

-- The quota query — everything one account is currently holding — reads this rather than the
-- table. An upload waits on it, so it should not be a sequential scan over everyone's rows.
create index attachments_owner_idx on attachments (owner_id) where deleted_at is null;

-- ── what to forget ──────────────────────────────────────────────────────────────
--
-- The one thing an attachment row cannot do is outlive itself, and something has to.
--
-- `attachments` is the only index into the volume, so the moment a row is gone its bytes are
-- unfindable: `packages/storage` has no `list`, by design. That is fine for a deletion the
-- application performs, which removes the bytes on the way past — and not fine at all for the
-- deletions it does not perform. `owner_id` and `message_id` both cascade, so dropping a user
-- takes every attachment row they ever had with it, silently, leaving every file they ever
-- uploaded on the disk with nothing left that knows it exists. Account deletion is the exact
-- case where "we still have their files" is the worst possible outcome.
--
-- So the key outlives the row. Deleting any attachment row — by the sweeper, by a cascade, by
-- hand at a psql prompt — writes its key here, and the sweeper works from this table rather
-- than from a guess about what might be out there.
--
-- It also makes the ordering safe in the other direction. Bytes-then-row was chosen because a
-- crash in between had to leave the recoverable failure rather than the permanent one; with a
-- tombstone the row can go first and the key is still there afterwards, which means the moment
-- something is unreachable is the moment the row leaves, not the moment the volume agrees.
create table orphaned_media (
  storage_key text primary key,
  at          timestamptz not null default now()
);

create or replace function orphan_media() returns trigger as $$
begin
  -- `do nothing` because a key can arrive twice: the same object re-tombstoned by a retry, or
  -- a row purged after its bytes were already gone. Both want the earliest timestamp, and
  -- neither is an error worth failing a cascade for.
  insert into orphaned_media (storage_key) values (old.storage_key)
  on conflict (storage_key) do nothing;
  return old;
end;
$$ language plpgsql;

create trigger attachments_orphan_media
  after delete on attachments
  for each row execute function orphan_media();
