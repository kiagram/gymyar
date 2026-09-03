# How GymYar is put together

## The problem this shape solves

openGym keeps a user's whole account — routines, every session, every weigh-in, settings — as one
JSON object. It syncs by `PUT`ting that object and keeping whichever copy has the newer timestamp.

For one person self-hosting, that is a good design: no migrations, trivially exportable, works
offline by construction. For a coaching platform it fails three ways at once.

- **Two writers destroy each other.** A coach editing a programme while their client is logging a
  set means two whole-account writes, and one of them wins entirely. The loser does not lose the
  routine they were editing — they lose everything they changed since their last sync.
- **The server cannot answer anything.** "Which of my clients missed a session this week" is not
  answerable about data the server stores as opaque JSON and never parses.
- **There is nowhere to put a third party.** An AI that drafts next week's programme is just
  another writer racing the other two.

## What replaced it

### Rows, and a counter

Every table that belongs to a user carries `updated_at` and `deleted_at`. Every write goes through
`log_change()`, which bumps a per-user monotonic counter and records what changed at that value.

```
pull(user, since) → { cursor, changes }    everything above `since`, one row per change
push(user, payload) → { cursor }           one transaction, one log entry per row
```

A client stores the last cursor it saw. A phone that has been in a locker for a week costs one
small request instead of the entire training history in both directions.

Conflict resolution is last-write-wins **per row**. That sounds like what openGym did and is not:
the unit is one routine or one session rather than the whole account, so losing a race costs the
thing you were editing instead of everything you have ever logged.

### The blob stays, on the client

The React app still holds the state object. Every view reads it, it survives being offline, and
rewriting all of that would have bought nothing — the blob was fatal as a *storage and sync unit*,
not as an in-memory working copy.

`packages/domain/src/statemap.js` maps between the two and is imported by both the client and the
server, because two hand-written mappers drift and the drift eats training history quietly.

### Diffing, not change tracking

The client works out what to send by mapping its state to rows and comparing against a snapshot of
what it last successfully sent. It could instead announce each mutation as it happens — but the
store mutates through one generic `update(fn)`, so every call site would have to remember, and one
that forgets loses data silently. Diffing cannot forget. It costs a JSON pass over the history per
sync, debounced and off the interaction path.

The snapshot advances only on a successful push, so a failed one is simply recomputed and resent.
The outbox is the difference between two states rather than a list that could be lost.

## Coaching

**A coach never writes a client's rows.** Their version of a programme lands in
`proposals` with a note, and the client sees what would change — sets and reps, before and
after — before deciding. On accept it is written as the client's own row, in the same transaction
that resolves the proposal.

This is why there is no merge algorithm anywhere in this codebase. There is only ever one writer
per row; the second party's intent is a separate object with its own lifecycle.

**Scopes** gate every coach-side read: `programmes`, `workouts`, `bodyweight`, granted
individually at accept time and revocable at any point. A client who shared their programme has
not thereby agreed to hand over every weigh-in. Sections a coach cannot see are labelled rather
than hidden — a silently absent panel reads as a bug.

## Attachments

Form-check video, progress photos and files on a message are the first user data that is not a
row in Postgres, and the split is deliberate: `attachments` is an index and
[`packages/storage`](../packages/storage) is a bag of bytes with no opinions. The storage
interface is five methods — `put`, `get`, `signedUrl`, `stat`, `delete` — and keeping it that
short is the design rather than a preference. The methods that get proposed (list, copy, a
directory walk) are almost always a caller asking the volume something the database already
knows. `get` earns its place once and late: a model asked to look at a photo is the only reader
that cannot be handed a URL.

Two drivers implement it. `fs` is a directory on a volume served by the nginx already in front
of the app, and is the default because S3 and the CDNs in front of it are not reachable from an
Iranian entity. `s3` is any store that speaks S3, including a MinIO on the same machine. The
second one exists partly to keep the first honest: an abstraction with one implementation is a
guess, and writing the second is how you find out. It found one leak — `signedUrl` is awaited
rather than read, because presigning through the SDK can have to resolve credentials over the
network first.

**The row is written before the bytes.** An upload is two writes to two systems that cannot
share a transaction, so one is first, and that choice decides which failure is recoverable.
Bytes first would leave an object nothing knows about after a crash — and nothing *could* know,
because storage cannot list itself. So a row is reserved with `uploaded_at` null, the bytes
follow, and the row is finished. Every object on the volume has a row naming it before it
exists; a row still null an hour later is an upload that died, and the sweeper deletes its bytes
by key.

**The type comes from the bytes, never from the header.** A `Content-Type` on an upload is a
claim by the uploader, and believing it would let them choose what a browser later does with
their file — served from the app's own origin. `sniff.js` reads the leading bytes against a
short list of formats real cameras and recorders emit, and the extension the object is stored
under comes from that.

**Two doors.** Everything under `/api/attachments` is a session: who are you, is this yours.
`/media/*` has no session at all — it takes an HMAC signature that expires in minutes, minted by
whichever route just checked the permission. That is what lets nginx serve a 60 MB video without
Node touching a byte (`X-Accel-Redirect`), and it is why a leaked media URL is worth little: it
names one object and stops working shortly. The signing key is derived from `SESSION_SECRET`
through a fixed label, so it rotates with it and a leaked media link is never a forged session.

**Attachments do not sync.** They are not in `SYNC_TABLES` and never reach `log_change()`. Sync
keeps an offline working copy of training on a phone, and a synced attachment row would promise
a video the app cannot play with no signal. Screens fetch them when they open — the same rule
coaching data already follows.

**Scopes, and the one that is new.** A form check rides the `workouts` scope, because it is a
record of a session. A progress photo has its own `photos` scope: sharing a weigh-in with a
coach says nothing about sharing a photograph of your body, and folding the two together would
decide that on the client's behalf. Files on a message are read by the two people in the
conversation, which membership already settles. A coach never uploads into a client's account,
for the same reason they never write a client's routine.

**Check-ins.** The template is the coach's row and the answer is the client's, written through
their own sync — one per person per day, keyed by the date like a weigh-in, so two offline
devices answering the same Saturday merge rather than collide. A coach reads them through the
`checkins` scope, which is in the default invitation because answering questions you have read
is itself the consent. `photos` is not, and a check-in that asks for a picture still gets it as
an attachment behind that scope rather than growing a column of its own. A check-in with no
`submitted_at` is a draft: it syncs so it survives a closed app, and no coach ever sees it.

**Habits.** Both the habit and its ticks are the client's rows, synced, because a habit is ticked
on a phone that is often offline. A coach-suggested one arrives as a proposal of `kind = 'habit'`
and carries `author_id` and `assigned_by` afterwards, exactly as an accepted programme does — so
a suggested habit and a self-made one are the same row differing only in who is recorded as
having written it. A tick has no `done` column: the row is the fact, unticking is a tombstone,
and the pair `(habit, date)` is its address in the change log. Read through the `habits` scope,
which is separate from `checkins` because a weekly summary and a daily tick grid are different
disclosures.

## The AI layer

### Why the planner is not a language model

The obvious build is to hand a model the goal and let it write the programme. That is the wrong
tool twice over.

Sets, reps, loads and progression steps are arithmetic this codebase already does correctly and
tests thoroughly — `progression.js` knows what Greyskull does after a missed AMRAP, and a model
does not. And a model asked for exercises will cheerfully name ones that are not in the library,
or put 140 kg on the bar of somebody who has never squatted. Neither failure is acceptable in
something people load a barbell from.

So the split is: **the domain owns every number, the model owns language.**

| Job | Who does it |
|---|---|
| Choosing exercises for a goal and a set of equipment | `planner.js`, against the live library |
| Sets, reps, and which progression policy | `planner.js`, from the goal |
| Finding stalls, missed sessions, untrained muscles | `planner.js`, from logged sets |
| Turning "I want to get stronger, 3 days, dumbbells" into fields | model, or a keyword reader |
| Writing the note that explains a change | model, or a template |
| Reading "bench 5x5 at 80" | deterministic parser |
| Reading "did five across on bench, felt heavy" | model, rewritten into shorthand the parser reads |

Every model output crosses a validation boundary before it can affect anything. A brief goes
through `normaliseBrief`, which drops invented goals and equipment and clamps a week to something
a week can hold. A rewritten log goes back through the deterministic parser, which is the only
thing allowed to name an exercise — so a model cannot put a lift in somebody's history that does
not exist.

With no key configured, every feature still runs. `/api/ai/status` reports which one answered, and
the UI says so, because users forgive a template and do not forgive being told a template was
intelligence.

### Selecting exercises

Patterns resolve by name against the live data, and a candidate **must** match one of the pattern's
named preferences — the match is the filter, not a tie-break. Selecting by target muscle alone put
"left hook. boxing" in overhead press slots and "rear deltoid stretch" in rear-delt slots, because
the dataset tags both as `delts`. Requiring a named match means every pick was written down by a
person, and a pattern nobody can equip resolves to nothing at all, which the planner reports rather
than filling with junk.

Heavy compounds vary across the week — a four-day split that resolves each hinge slot independently
prescribes barbell deadlift 5×5 twice, which is a programming mistake a lifter spots immediately.
Accessories do not vary, because reaching for an alternative there finds "dumbbell biceps curl
squat", and curling the same way twice a week is correct.

Selection is deterministic: the same brief produces a byte-identical programme. That is what makes
it testable, and what stops "regenerate" from being a slot machine.

### Reviewing training

`reviewTraining` reads logged sets and nothing else. "Feels hard" is not evidence; four sessions in
a row short of the rep target is. Stalls come from the same `stallCount` the progression policies
use, so the review and the app never disagree about whether something has stopped moving.
Attendance counts finished sessions only — a session started and abandoned is not training.
"This is too easy" needs four rated sessions before it will say so, and stays silent entirely on a
profile that does not log effort.

`proposeAdaptation` turns the worst finding into a routine in the app's own shape — which is
exactly the payload the propose endpoint takes. A coach opens a filled-in composer, edits it, and
sends it. Nothing reaches a client that a coach did not send.

### Which language the server writes in

The domain owns the numbers and a model owns the language — but *which* language is a property
of the reader, and the reader is not always the person making the request. A coach drafts a
change and their client reads the note, so the note is written in the client's language, not the
coach's.

That means the server has to know it. `users.locale` is where it lives, written by the client at
signup and whenever the app's language changes; `PATCH /api/me` validates against `LOCALES` in
the domain, which is the same list the language picker is built from. It is not a synced row —
it is not something the app edits offline, and the server is the only consumer.

Two things read it: `interpretBrief` and `explainChange`. Both write prose in English or Persian
and fall back to English elsewhere, which is a scope choice rather than a gap — the register of a
coaching note is not a translation job (see the comment above `LANGUAGE_NAME`). Exercise names
inside those sentences come from `packages/domain/src/names/`, shared with the client, because a
note is assembled server-side and reaches the client as finished text with nothing left to
translate.

## Units

The database stores kilograms. openGym stores whatever the user typed in whatever unit they had
selected. Every conversion goes through `toKg`/`fromKg` with the profile's unit, and the blob
importer reads each profile's setting rather than assuming — assuming kg would multiply every
pound-user's history by 2.2 and there would be no way back.

## Sets

A set is one of three shapes and the columns say which, with no `kind` field doing the work:

| Mode | State | Columns |
|---|---|---|
| reps | `{ w, r }` | `weight_kg`, `reps` |
| time | `{ sec, w? }` | `seconds`, optional `weight_kg` |
| cardio | `{ min, speed }` | `seconds`, `distance_m` |

Cardio is stored as distance and duration rather than the km/h the UI collects, because "how far
did they run this month" is a question the coach dashboard asks and a speed column cannot answer.
Speed is recovered exactly on the way back.

Effort is normalised to reps-in-reserve so two profiles on different scales are comparable, with
the scale it was logged on kept alongside. RPE 8 is exactly RIR 2, so it round-trips — and a set
logged in RPE is never silently rewritten as RIR.

## Testing

Four layers, because each one caught things the others could not:

- **domain** — pure logic, no database, no browser
- **db** — the sync engine and the coaching rules against real Postgres
- **api** — every route over real HTTP with real session cookies, via fastify's `inject`
- **ai** — the fallbacks, the validation boundary, and every way a model can misbehave
- **client** — the diff engine, including the failure paths
- **smoke** (`infra/scripts/smoke.sh`) — the coaching flow end to end against a running instance
- **e2e** (`infra/scripts/e2e.mjs`) — the real UI in a real browser

That last pair earned their place. Three bugs reached them with every other suite green: an invite
with no email address violated a database constraint, and — twice — a date arrived as an ISO
string where the code expected a calendar day, because `postgres` hands the server `Date` objects
and JSON does not. Only a round trip through a browser sees that.
