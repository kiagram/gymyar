# GymBuddy

A coaching platform built on [openGym](https://gitea.com/DuarteSantos/openGym) — the gym and
body-weight tracker, extended with coach ↔ client programming and an AI layer, delivered as a
web app, an iOS app and an Android app from one codebase.

**AGPL-3.0-or-later.** Source stays public; see [NOTICE.md](NOTICE.md) for the upstream
attribution and the App Store additional permission we inherit.

## Layout

```
apps/client       React 19 + Vite PWA, wrapped by Capacitor 7 for iOS and Android
apps/api          Node API — passkey auth, push, per-user state
apps/site         marketing site (static)
packages/domain   runtime-agnostic training logic, shared by client, API and AI worker
packages/db       Postgres schema (phase 2, draft)
infra             nginx, Docker builds, media fetch scripts
docs              self-hosting, mobile builds, upstream README
```

### Why `packages/domain` exists

Progression rules, 1RM estimation, superset and per-side handling, and CSV import are the
expensive part of this codebase and the part a coaching platform needs on **both** sides of the
wire: the client computes the next prescription so it works offline, and the server needs the
identical result to generate programmes and validate what a coach or an AI proposes. Extracting
it means one implementation, one test suite, no drift.

Its contract: no DOM, no React, no Vite-only syntax. Anything needing a browser stays in
`apps/client/src/lib`. Translation goes through `i18n-adapter.js`, which the client registers a
real translator into at boot and which falls back to English everywhere else.

## Develop

```bash
npm install
npm run dev            # client on :5173
npm test               # domain + client suites
npm run build          # production web bundle
npm run sync:mobile    # build + capacitor sync for the native shells
```

Self-hosted stack (unchanged from upstream, paths updated):

```bash
cp .env.example .env
docker compose up -d --build
```

## Status

- [x] **Phase 1** — fork, rebrand, monorepo, domain package extracted, tests green
- [ ] **Phase 2** — Postgres, per-entity sync, Fastify API (schema drafted in `packages/db`)
- [ ] **Phase 3** — coaches and clients
- [ ] **Phase 4** — AI programming
- [ ] **Phase 5** — billing and store submission

Full assessment and reasoning: see the GymBuddy project docs.

## Before launch

Two items block a paid launch and neither is code:

1. **Exercise media.** The 1,324 animations are © [Gym visual](https://gymvisual.com/), not MIT.
   The dataset grants us nothing — obtain a commercial licence or replace the media.
2. **Legal review** of the AGPL position, since we charge for hosting.
