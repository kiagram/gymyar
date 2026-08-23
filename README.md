# GymBuddy

A coaching platform built on [openGym](https://gitea.com/DuarteSantos/openGym) — the gym and
body-weight tracker, extended with coach ↔ client programming, delivered as a web app, an iOS app
and an Android app from one codebase.

**AGPL-3.0-or-later.** Source stays public; see [NOTICE.md](NOTICE.md) for the upstream
attribution and the App Store additional permission we inherit.

## Run it

```bash
cp .env.example .env
docker compose up -d --build
```

Open **http://localhost:8080**. With `SEED_DEMO=1` in `.env` (the default in the example) the
first boot creates a coach and three clients with twelve weeks of training each:

| Account | Password | What it shows |
|---|---|---|
| `coach@gymbuddy.test` | `gymbuddy-demo-1` | The roster: adherence, who has drifted, an open proposal |
| `sam@gymbuddy.test` | `gymbuddy-demo-1` | Shares everything; has a proposal waiting |
| `ava@gymbuddy.test` | `gymbuddy-demo-1` | Shares programmes and workouts, not body weight |
| `theo@gymbuddy.test` | `gymbuddy-demo-1` | Shares programmes only, and stopped training three weeks ago |

Turn `SEED_DEMO` off for a real instance and set a real `SESSION_SECRET`.

## Layout

```
apps/client       React 19 + Vite PWA, wrapped by Capacitor 7 for iOS and Android
apps/api          Fastify — auth, delta sync, coaching
apps/site         marketing site (static)
packages/domain   runtime-agnostic training logic, shared by client and server
packages/db       Postgres schema, migrations, sync engine, coaching rules
packages/ai       the language layer, and the deterministic path underneath it
infra             nginx, Docker builds, media fetch, smoke and browser tests
docs              self-hosting, mobile builds, upstream README
```

### How sync works

openGym stored a user's entire account as one JSON blob and synced it with a whole-state `PUT`,
last write wins. That is elegant for one person on their own server and fatal for coaching: a
coach editing a programme while their client is mid-session silently destroys one of the two
edits, and the server can never answer a question about data it never parses.

GymBuddy stores rows. Every write bumps a per-user counter and records what changed at that
value; a client remembers the last counter it saw and asks for what came after. The client still
holds the blob in memory — that part was never the problem, and it is what keeps the app working
offline — but the wire format and the database are relational.

`packages/domain/src/statemap.js` is the boundary between the two, imported by both sides so
there is one mapper rather than two that drift.

### What the AI layer is, and is not

The domain owns every number. Sets, reps, loads, progression policies and exercise selection are
computed by `packages/domain/src/planner.js` against the real library and the same progression
rules the app already runs on. A model is asked to do two things: turn free text into a structured
brief, and write the note explaining a change. Both have deterministic implementations underneath.

With no `ANTHROPIC_API_KEY` set, GymBuddy builds the same plans, finds the same stalls and parses
the same logs — it phrases things from a template instead of writing prose, and `/api/ai/status`
says so. That is what makes it safe to expose: nothing can invent a lift that is not in the
library, or put 140 kg on a beginner's bar.

Nothing drafted is ever applied. A generated plan comes back for the person to look at; a drafted
change for a client fills in the composer their coach already uses. There is no endpoint that
writes training.

### The rule that makes coaching safe

**A coach never writes a client's rows.** A proposed programme lands in `routine_revisions` and
becomes real only when the client accepts it, at which point it is written as the client's own
row through the normal sync path. There is only ever one writer per row, so there is nothing to
merge — and a client's own edit cannot be erased by a coach's sync.

Scopes are the other half: sharing a programme does not share what you weigh. Every coach-side
read is gated on the scope the client granted, section by section.

## Develop

```bash
npm install
npm run db:reset          # schema + exercise library, against $DATABASE_URL
npm run db:demo           # …plus the demo coach and clients
npm run api               # API on :3000
npm run dev               # client on :5173, proxying /api to it
npm test                  # domain, database, API and client suites
npm run test:smoke        # end-to-end over HTTP against a running instance
npm run test:e2e          # the same flows driven through a real browser
npm run sync:mobile       # build + capacitor sync for the native shells
```

The database and API suites need a Postgres in `DATABASE_URL`. CI stands one up; locally, any
throwaway database will do.

## Status

- [x] **Phase 1** — fork, rebrand, monorepo, domain package extracted
- [x] **Phase 2** — Postgres, delta sync, Fastify API, migration from an openGym blob
- [x] **Phase 3** — coaches, clients, scopes, proposals, messaging
- [x] **Phase 4** — programme generation, training review, logging by typing
- [ ] **Phase 5** — billing and store submission

## Before launch

Two things block a paid launch and neither is code:

1. **Exercise media.** The 1,324 animations are © [Gym visual](https://gymvisual.com/), not MIT.
   The dataset grants us nothing — obtain a commercial licence or replace the media. Exercise
   rows carry `image_url` and `animation_url`, so swapping the source is an `UPDATE`.
2. **Legal review** of the AGPL position, since we charge for hosting.
