# How GymBuddy is put together

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
`routine_revisions` with a note, and the client sees what would change — sets and reps, before and
after — before deciding. On accept it is written as the client's own row, in the same transaction
that resolves the proposal.

This is why there is no merge algorithm anywhere in this codebase. There is only ever one writer
per row; the second party's intent is a separate object with its own lifecycle.

**Scopes** gate every coach-side read: `programmes`, `workouts`, `bodyweight`, granted
individually at accept time and revocable at any point. A client who shared their programme has
not thereby agreed to hand over every weigh-in. Sections a coach cannot see are labelled rather
than hidden — a silently absent panel reads as a bug.

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
- **client** — the diff engine, including the failure paths
- **smoke** (`infra/scripts/smoke.sh`) — the coaching flow end to end against a running instance
- **e2e** (`infra/scripts/e2e.mjs`) — the real UI in a real browser

That last pair earned their place. Three bugs reached them with every other suite green: an invite
with no email address violated a database constraint, and — twice — a date arrived as an ISO
string where the code expected a calendar day, because `postgres` hands the server `Date` objects
and JSON does not. Only a round trip through a browser sees that.
