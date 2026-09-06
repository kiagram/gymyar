# Release checklist

A runnable list. Every item is a command or a thing to look at, in the order to do them, and
the ones that are supposed to fail today say so. It is assembled from
[RELEASING.md](RELEASING.md) §"Before the first paid release" and §"Cutting a release", and
[SELF_HOSTING.md](SELF_HOSTING.md) §5 and §7 — those explain *why*; this is only *what*.

Copy it into the release's issue or PR and tick as you go.

## 0. Once, before the first paid release

These are not code and no command below makes them pass. Both are launch blockers.

- [ ] **Exercise media is licensed for sale, or replaced.** Decision table:
      [MEDIA_OPTIONS.md](MEDIA_OPTIONS.md). Human steps: [NEXT_HUMAN_STEPS.md](NEXT_HUMAN_STEPS.md).
      The gate below (`npm run media:check`) exits 1 until `packages/domain/src/media-set.js`
      exports a set whose `commercial` is true — and that flag is a record of a licence actually
      held, not a switch.
- [ ] **Legal review done.** Brief: [LEGAL_BRIEF.md](LEGAL_BRIEF.md). Its §3 lists five places
      the privacy policy and the code disagree; either the policy or the code changes before
      anyone is asked to accept it.
- [ ] The repository is public at the URL in `apps/site/site.js` and `apps/client/src/lib/demo.js`
      (AGPL §13, and the condition on the inherited App Store permission — `NOTICE.md`).

## 1. The tree

```bash
git status --porcelain          # empty
git fetch origin && git status  # not behind
```

- [ ] `npm run version:check` — the four files carrying the version agree. If cutting a new
      version, stamp it first with `node infra/scripts/version.mjs <x.y.z>`; Android's
      `versionCode` is derived from it and must rise.
- [ ] `npm audit` reports zero advisories (the last seven all came from one unused dependency).
- [ ] `node apps/client/scripts/check-locales.mjs` — no locale key missing from `fa`.

## 2. The gates

```bash
npm run media:check
```

- [ ] **Expected today: exit 1**, printing the active set and `commercial: false`. That is the
      launch blocker in item 0 expressed as an exit code. It passes only after item 0 is done.
      Do not add it to CI — it would fail every run, which is the point of it being here.

```bash
npm test                          # needs a Postgres in $DATABASE_URL; db and api suites use it
```

- [ ] Green across domain, ai, db, storage, mail, sms, api, client and the release tooling.
- [ ] Storage: with `STORAGE_S3_TEST_ENDPOINT` unset the S3 driver's tests *skip*. If the
      release will run on S3, run them against a MinIO first (CI does).

```bash
npm run build                     # the web bundle — not build:mobile
```

- [ ] `apps/client/dist` is the *web* app (it has a sign-in screen). `npm run sync:mobile`
      overwrites it with the backend-less mobile bundle; run the web build last.

## 3. The instance (`SELF_HOSTING.md` §5)

`.env` on the server, checked by reading it:

- [ ] `SESSION_SECRET` set — 64 hex characters from `openssl rand -hex 32`. The API image runs
      `NODE_ENV=production` and refuses to boot without one (`apps/api/src/config.js`).
- [ ] `SEED_DEMO` empty. Demo accounts on a real instance are four accounts with a public password.
- [ ] `RATE_LIMIT` unset or `on`. Counted per signed-in account, per identifier for sign-in,
      per address only for anonymous requests (`apps/api/src/rate-limit.js`).
- [ ] `ORIGIN` and `RP_ID` are the real domain, over HTTPS. Passkeys are bound to `RP_ID` and
      changing it later invalidates every one registered.
- [ ] `MAX_MEDIA_BYTES_PER_USER` set if anyone but you can sign up (default 2 GB).
- [ ] `INVITE_ONLY=true` unless open signup is intended.
- [ ] If billing: `ZARINPAL_MERCHANT_ID` set and `ZARINPAL_SANDBOX` **unset**; real prices in
      `PRICE_*` — the defaults in `apps/api/src/payments/pricing.js` are placeholders.
- [ ] `VAPID_*` set if push is wanted; `MAIL_*` / `SMS_*` if sign-in codes and resets are.
- [ ] Nothing derived from the GitHub re-upload is still in use: rotate `SESSION_SECRET` and
      the VAPID private key if it is (`CHANGELOG.md` §Security).

Then:

```bash
docker compose config -q
docker compose up -d --build
./infra/scripts/smoke.sh https://<your-domain>
```

- [ ] Smoke passes end to end, including the media step, over the real origin.
- [ ] `https://<domain>/api/health` answers, `/api/ai/status` says which provider answered
      (or that none is configured), `/api/public/*` answers or 404s as `PUBLIC_STATS` intends.
- [ ] Register a passkey on a phone against the real domain and sign in with it. This cannot
      be tested on localhost and nobody has done it on a real domain yet.

## 4. Backups (`SELF_HOSTING.md` §7)

```bash
./infra/scripts/backup.sh --verify -o /somewhere/that/is/not/this/disk
```

- [ ] Both files and a manifest are written, and `--verify` restored the dump and counted.
- [ ] `./infra/scripts/rehearse-backup.sh` passes locally — it restores a two-part backup onto a
      fresh stack and opens the attachments. CI runs it too; run it here if anything about
      storage, the compose file or the two scripts changed.
- [ ] A schedule exists for `backup.sh`, on a machine that is not the instance, and somebody
      knows where the archives go.

## 5. The native build (only if an APK ships)

```bash
npm run sync:mobile
node infra/scripts/check-mobile-hosts.mjs
cd apps/client/android && ./gradlew assembleRelease
```

- [ ] The host check passes: the mobile bundle mentions no host but the allowed ones.
- [ ] The keystore is the one every previous release was signed with, and it is backed up
      somewhere that is not a git repository.
- [ ] Install the APK **over the previous release** on a real device — the only step that
      catches a wrong signing key. As of 1.0.0 no device has run any build; see
      [NEXT_HUMAN_STEPS.md](NEXT_HUMAN_STEPS.md).
- [ ] With the network off: log a session, close and reopen the app, the session is there.
- [ ] Farsi end to end: the layout mirrors, the numbers are right, nothing overflows.
- [ ] No Zarinpal link, no billing screen, no sign-in screen anywhere in it.
- [ ] `docs/store/listing.fa.md` and `docs/store/privacy.md` still describe this build.

## 6. Ship

- [ ] Tag the commit: `git tag v<x.y.z>` and push the tag. Keep the exact APK uploaded.
- [ ] Deploy the web app from the web build (item 2), not from `dist/` after `sync:mobile`.
- [ ] `CHANGELOG.md` has the release's section and date.
- [ ] Take a backup of the new instance right after the first real signup, with `--verify`.
