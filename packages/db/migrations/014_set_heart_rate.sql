-- GymYar 014 — the peak a single set cost, and the timestamp that makes it findable.
--
-- 012 gave a session four numbers. This gives a set one, which is the last thing
-- docs/WEARABLES.md promises `heartrate.js` and the only part of it that could not be built
-- when the strap landed: `hrForSpan` takes any window, and a set had no window to be taken
-- against — only the session had times.
--
-- ## `done_at` has been the workout's end on every row
--
-- The column has existed since 001 and `statemap.js` has been filling it with `ms(w.end)` for
-- every set in a session, so twelve sets an hour apart all claimed the same instant. Nothing
-- was visibly wrong, which is why it lasted: the one index that reads it
-- (`workout_sets_history_idx`, a lift's history newest-first) sorts sessions correctly even
-- when every set inside one is tied.
--
-- It is what a per-set heart rate needs, though, so the client now records the moment a set is
-- actually checked off and sends it. No backfill: rows written before this cannot be improved,
-- and inventing plausible times for them would be worse than leaving them tied — a made-up
-- timestamp is indistinguishable from a real one the moment it is stored.
--
-- ## One column, and it is the maximum
--
-- Not an average. A set's window necessarily contains the rest before it — the app knows when
-- a set was finished and never when it was started — so the mean over that window is mostly
-- somebody standing still, and it would read as though every set were easy. The peak is the
-- number the window exists to find, and it is the one a person looks for.
--
-- The same 25–240 window as 012 and as `believableBpm`, for the same reason: a value this
-- database accepts and a value that module believes should be the same set of numbers.

alter table workout_sets add column hr_peak_bpm smallint
  check (hr_peak_bpm is null or hr_peak_bpm between 25 and 240);

comment on column workout_sets.hr_peak_bpm is
  'Highest heart rate around this set — its window, plus the lag before a peak arrives.';
comment on column workout_sets.done_at is
  'When this set was checked off. Sessions logged before 014 carry the workout end on every row.';
