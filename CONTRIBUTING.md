# Contributing to GymYar

Thanks for taking a look. GymYar is a coaching platform built on
[openGym](https://gitea.com/DuarteSantos/openGym) — the tracker half is deliberately small and
dependency-light, and the goal is to keep it that way while the coaching half stays boringly
strict about who may write what.

## Project layout

```
apps/client       React 19 + Vite PWA. android/ + ios/ are the Capacitor shells (docs/MOBILE.md).
apps/api          Fastify — auth, delta sync, coaching, billing.
apps/site         marketing site: hand-written HTML/CSS/JS, no build step.
packages/domain   runtime-agnostic training logic, imported by both client and server.
packages/db       Postgres schema, migrations, sync engine, coaching rules.
packages/ai       the language layer, and the deterministic path underneath it.
infra             nginx, Docker builds, media fetch, logo rendering, smoke and browser tests.
logo              the identity. Every icon in the repo is generated from here.
docs              self-hosting, mobile builds, releasing, store listings, upstream README.
```

## Running for development

```bash
cp .env.example .env
npm install
npm run db:reset          # schema + exercise library, against $DATABASE_URL
npm run db:demo           # …plus the demo coach and three clients
npm run api               # API on :3000
npm run dev               # client on :5173, proxying /api to it
```

Or the whole stack in containers, which is what a self-hoster gets:

```bash
docker compose up -d --build      # db + api + web on :8080
```

```bash
npm test                  # domain, ai, db, api, client and release suites
npm run test:smoke        # end-to-end over HTTP against a running instance
npm run test:e2e          # the same flows driven through a real browser
```

The database and API suites need a Postgres in `DATABASE_URL`. CI stands one up; locally, any
throwaway database will do.

## The rules that are not style preferences

Three invariants hold this product together. A change that breaks one is wrong even if every
test passes, so they get stated rather than left to be inferred.

- **A coach never writes a client's rows.** Coach-authored changes land in `proposals`
  and become real only when the client accepts, at which point they are written as the client's
  own row through the normal sync path. One writer per row is what makes two-party editing safe
  without merge machinery. Do not add a route that writes another user's training.
- **Every coach-side read is gated on a granted scope.** Use `requireScope()`. A link existing
  is not permission; the client chose, section by section, and can change their mind.
- **The domain owns every number; a model owns language.** Sets, reps, loads, progression and
  exercise selection are computed in `packages/domain`. A model turns free text into a
  structured brief and writes the note explaining a change — both with deterministic
  implementations underneath, so the product works with no provider configured. Nothing a model
  produces may reach the database without a person confirming it.

## Guidelines

- **Keep it dependency-light.** The client is React + Router + Zustand and little else; the API
  is Fastify with a short list. New dependencies are a hard sell in either.
- **`packages/domain` must stay runtime-agnostic** — no DOM, no React, no Vite-only syntax like
  `import.meta.env`. The same code computes a prescription on a phone and on the server. There
  is a test that imports the package in a plain Node process precisely because vitest's
  transform hides this class of mistake.
- **Match the style.** Small components, clear names, comments where the *why* is not obvious —
  and this codebase does write those comments. State lives in `src/store`, pure helpers in
  `src/lib`.
- **Training logic gets a unit test.** Anything deciding what you lift next, or reading a logged
  session back, belongs in a pure helper with tests beside it. These rules are easy to get
  subtly wrong and nearly impossible to verify by clicking.
- **Permission logic gets a test that tries to break it.** Cross-account reads, ungranted
  scopes, forged cookies — the API suite covers these and new surfaces should extend it.
- **Never edit a generated file.** Every icon, launch screen and the social banner come from
  `logo/` via `node infra/scripts/render-logo.mjs`; CI fails on drift. Same for the version,
  which is stamped into four files by `infra/scripts/version.mjs`.
- **New user-facing strings go into all twelve locales.** `node apps/client/scripts/check-locales.mjs`
  is in CI and fails on a key present in some and missing from others. Check RTL if you touched
  layout — Farsi mirrors.
- **Don't commit** `media/`, `data/` or `.env`. They are gitignored, and the reason is in
  [docs/PUBLISHING.md](docs/PUBLISHING.md).
- **Test the flow you touched** in a browser before opening a PR — the smoke and e2e runs have
  caught bugs that every unit test passed straight through.

## Good first issues

- **Translating the coaching UI.** The roster, client detail, proposal composer and inbox call
  `t()` correctly, but ~110 of their strings have no entry in any locale file, so they fall back
  to English in all twelve languages — including Farsi, where the layout mirrors around English
  text. This is the largest user-visible gap in the product.
- Retaking the screenshots after a UI change — `node infra/scripts/screenshots.mjs`, against a
  seeded demo stack. Both sets, English and `--fa`.
- Additional starter plans (upper/lower, full-body, 5×5…)
- Percentage / training-max programming (5/3/1-style) on top of the progression engine — the
  policy interface is already there
- Accessibility passes on the workout and chart screens

## Where to ask what

- **A bug, or a feature you want:** <https://github.com/kiagram/gymyar/issues>
- **A change you have written:** a pull request against `gymyar`, which is the default branch.
  `main` is the untouched openGym import and nothing lands there.
- **A security problem:** not either of the above — [SECURITY.md](SECURITY.md) has the private
  channel, and a public issue with a working exploit in it is a bad day for every instance
  somebody else is running.

## Reporting bugs

What you did, what you expected, what happened, and your browser and OS. If it is about sign-in
or passkeys, include your `RP_ID` and `ORIGIN` — most login problems are an origin mismatch. If
it is about coaching, say which side you were on and which scopes were granted.

**Security issues do not go in a bug report.** See [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree your work is licensed under the project's
[GNU AGPL v3.0](LICENSE) or later. GymYar is a derivative work of openGym and stays on its
licence; see [NOTICE.md](NOTICE.md) for the attribution chain you are contributing into.
