-- GymYar 013 — a resting heart rate per day.
--
-- `parseAppleHealth()` has been computing one for every day of an import since the reader
-- existed, and dropping all of them: 012 gave the *sessions* their heart rate, and a resting
-- figure belongs to a day rather than to a session. This is that day.
--
-- It is the number in a health export that most repays being plotted. A session average says
-- how hard that session was, which the person already knew; resting heart rate falls over
-- months of training and rises before somebody gets ill or has been sleeping badly, and it does
-- that whether or not they trained. It is the one line here that reports on the recovery half
-- of training rather than the work half.
--
-- ## Shaped like `bodyweight_entries`, because it is the same kind of thing
--
-- One value per person per day, so the day is the key and there is no synthetic id — and the
-- reason 001 gives for that still holds word for word: an id derived from the date alone would
-- be identical for every user on the planet, which is a collision waiting to become a leak.
--
-- Not a column *on* `bodyweight_entries`, though it is tempting and would have cost no table. A
-- day can have a resting heart rate and no weigh-in — most days of an import are exactly that,
-- since a watch measures every night and a person stands on scales when they remember to. The
-- weigh-in row would have to be invented to hold the heart rate, and then "how many days did
-- they weigh themselves" is a question this database can no longer answer.
--
-- ## The value
--
-- `smallint`, and the same 25–240 window as 012 and as `heartrate.js`, so a number this
-- database accepts is a number that module believes. `not null` because unlike a session's
-- four columns there is nothing partial to express: a day either has a figure or has no row.

create table resting_hr (
  user_id    uuid not null references users(id) on delete cascade,
  on_date    date not null,
  bpm        smallint not null check (bpm between 25 and 240),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, on_date)
);

comment on table resting_hr is
  'One resting heart rate per person per day. Imported from a health export, or measured.';
