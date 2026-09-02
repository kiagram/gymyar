-- GymYar 012 — somewhere for a heart rate to live.
--
-- `parseAppleHealth()` has been reading heart rate out of an Apple Health export since the
-- importer learned to read sessions, and `mergeImport` has been dropping it on the way into
-- state. Not out of caution: `rowsToWorkout` rebuilds a session from its columns, so anything
-- the parser attached to a workout survived in the browser until the first sync and then
-- disappeared, with nothing having failed and nothing to see in a log. Dropping it deliberately
-- at the door was the least bad thing to do while there was no column. This is the column.
--
-- ## Four numbers on the session, and not a table of samples
--
-- docs/WEARABLES.md files "HR samples" under M3, and this is deliberately less than that.
--
-- A watch writes a reading every few seconds, which is on the order of 175,000 rows per person
-- per year — by a wide margin the largest table in this database, several times over, for a
-- curve nothing in the app draws yet. The four numbers below are what the importer actually
-- produces, and they are what every screen that could show a heart rate today would ask for.
--
-- The asymmetry is the argument: a samples table can be added the day something needs the shape
-- of the curve rather than its summary, and it costs one migration. Adding it now costs every
-- row of every import anybody ever runs, forever, and there is no migration that gives that
-- back. `heartrate.js` already computes zones and time-in-zone from samples, so the maths is
-- not what would be missing — only the storage, and only when a screen wants it.
--
-- ## All four, or none of them
--
-- `effort.js` refuses to average fewer than five rated sets, for the reason spelled out there:
-- an average without its denominator speaks for data that is not behind it. The same rule is a
-- constraint here rather than a convention, because these four columns can be written by an
-- importer, by a sync push and one day by a shortcut POSTing from an iPhone, and a rule that
-- lives in three writers is a rule that holds in two of them.
--
-- So: all four present or all four absent, the count positive, the average between the extremes,
-- and every reading inside the range a human heart can produce — the same 25–240 window
-- `heartrate.js` filters samples with, so a value this database accepts and a value that module
-- believes are the same set of numbers.

alter table workouts
  add column hr_avg_bpm smallint,
  add column hr_min_bpm smallint,
  add column hr_max_bpm smallint,
  add column hr_samples integer;

comment on column workouts.hr_avg_bpm is
  'Mean heart rate over the session. Null unless all four hr_ columns are set.';
comment on column workouts.hr_samples is
  'How many readings the other three are computed from — the denominator, never dropped.';

alter table workouts add constraint workouts_hr_complete
  check (num_nonnulls(hr_avg_bpm, hr_min_bpm, hr_max_bpm, hr_samples) in (0, 4));

alter table workouts add constraint workouts_hr_believable
  check (hr_min_bpm is null or (
    hr_min_bpm between 25 and 240 and
    hr_max_bpm between 25 and 240 and
    hr_avg_bpm between hr_min_bpm and hr_max_bpm and
    hr_samples > 0));
