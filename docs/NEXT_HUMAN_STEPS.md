# What needs a person

Everything on the roadmap that a coding agent cannot do, with enough attached to act on each
without re-reading the codebase. Ordered by what unblocks the most. Nothing here is code, and
adding code before these are done enlarges the exposure they exist to reduce.

State on 2026-09-06: nine engineering phases complete, ~1,380 test files green, no production
instance ever deployed, zero users, no device has run the APK, no real strap has been paired.

## 1. Get a quote for the exercise media, or choose a replacement

**Why first.** It is one of the two launch blockers, it gates `npm run media:check`, and every
option has now been measured — the decision is the only thing left. Read
[MEDIA_OPTIONS.md](MEDIA_OPTIONS.md) first; it is the decision table, and it does not decide.

**Gym visual** — <https://gymvisual.com/>, rights holder Aliaksandr Makatserchyk. What to ask
for, in one email:

- A commercial licence covering all 1,324 images and GIFs the app uses (ids from ExerciseDB /
  `hasaneyldrm/exercises-dataset`; the 180×180 thumbnails and animations), for:
  1. a hosted web application that copies the files onto its own server;
  2. an Android application distributed as an APK and through Cafe Bazaar and Myket, which
     either bundles the files or fetches them from a CDN we control;
  3. an unlimited number of end users, with no per-seat fee.
- Whether the licence can be held by an individual now and assigned to a company later, and
  whether it can be held by an Iranian person or entity at all (payment from Iran is itself a
  question).
- Whether the on-screen attribution "© Gym visual — https://gymvisual.com/" is required in the
  app, and where. Today it is stored in the database and shown nowhere in the UI.
- Their terms of use are at <https://gymvisual.com/content/3-terms-and-conditions-of-use>;
  read the "one-person licence" and no-redistribution clauses before writing.

**If the answer is no or too much**, the two remaining shapes are in MEDIA_OPTIONS.md §"What
the decision is": adopt wger's CC-BY-SA drawings and hand-map the planner's 67 picks (an
afternoon with `node infra/scripts/media-set.mjs suggest --source wger` open), or commission
67–201 illustrations. Either way the mechanics are `build --source <id> --out <path>`, edit,
and export the set from `packages/domain/src/media-set.js`.

**Do not** use Free Exercise DB or wrkout/exercises.json. They are not licensed; the adapters
record why.

## 2. Book the legal review

Attach [LEGAL_BRIEF.md](LEGAL_BRIEF.md). It contains every fact and file reference counsel
needs and eighteen numbered questions. Ask for answers by number.

Before the meeting, decide which of the five drifts in the brief's §3 you would rather fix in
code than in the policy, because counsel will ask:

| Drift | Fix in code | Fix in the policy |
|---|---|---|
| No account deletion exists (§3.5) | Add `DELETE /api/me` and a Settings row | Remove the promise |
| Zarinpal's masked card number is stored in `payments.detail` (§3.2) | Strip `card_pan`/`card_hash` before storing | Say it is held |
| Form-check video is not its own scope (§3.4) | Add a `formchecks` scope | Say it rides sessions |
| "No outbound request … on your users' behalf" (§3.6) | — | Rewrite to name email, SMS, push, payment, model |
| A configured model provider receives free text and a client's name (§3.7) | — | Add a paragraph, conditional on the operator's configuration |

The privacy policy is `apps/site/privacy.html` (Persian, canonical) and
`apps/site/en/privacy.html`; both change together. There is no terms-of-service page and no
refund statement; the brief's questions 15 and 16 cover what the minimum is.

## 3. Deploy a real instance on a real domain

Nothing about passkeys, push, HTTPS cookies or the media path is meaningful on localhost, and
none of it has ever run anywhere else. [SELF_HOSTING.md](SELF_HOSTING.md) is the procedure;
§4 has Cloudflare Tunnel (no open ports) and Caddy (automatic TLS). The short form:

1. A VPS reachable from Iran, with Docker. Register a domain; pick it carefully — `RP_ID`
   binds every passkey to it and cannot change later.
2. `cp .env.example .env`; set `SESSION_SECRET` (`openssl rand -hex 32`), `ORIGIN`, `RP_ID`,
   `SEED_DEMO=` (empty), `INVITE_ONLY=true` until you want strangers, and leave `RATE_LIMIT`
   on. [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) §3 is the full list.
3. `docker compose up -d --build`; put the tunnel or Caddy in front of port 8080.
4. `./infra/scripts/smoke.sh https://<domain>` — the whole coaching flow including a media
   upload, over the real origin.
5. On a phone, over the real domain: register a passkey, sign in with it, install to the home
   screen, allow notifications, receive one. Each of these is a first.
6. `./infra/scripts/backup.sh --verify` the same day, to somewhere that is not that machine.

## 4. Rotate the secrets from the re-upload

If anything you run descends from the GitHub re-upload this code was recovered from — the one
that had committed a live instance's `SESSION_SECRET`, VAPID private key and user records
(`CHANGELOG.md` §Security) — rotate before it faces the internet:

- `SESSION_SECRET`: new value in `.env`, restart. Every user is signed out once; the media
  signing key derives from it and rotates with it.
- VAPID: generate a fresh pair (`npx web-push generate-vapid-keys`), set both in `.env`;
  existing push subscriptions stop working and re-subscribe on next app open.
- If the re-upload's Postgres was ever used as a starting point, treat its user rows as
  compromised: those people's password hashes and emails were public.

## 5. Install the APK on a real Android phone

The cheapest possible retirement of the largest block of untested risk: the native build is the
shipping product for Android and no device has ever run it.

1. `npm run sync:mobile && cd apps/client/android && ./gradlew assembleDebug` — or use the
   existing `gymyar-1.0.0-debug.apk` if it is the current build.
2. Copy to the phone, allow install from unknown sources, install.
3. First run: the app opens with no sign-in screen; log a session; kill the app; reopen; the
   session is there. Turn on airplane mode and repeat.
4. Switch the phone to Persian; every screen mirrors; numbers are Persian digits where they
   should be.
5. Exercise pictures load (from jsDelivr — the licence exposure in item 1, visible here).
6. Settings → Export hands the file to the share sheet.
7. Health Connect: with a watch that writes to it, the permission sheet asks for exactly
   sessions and heart rate; a session imports.
8. Write down everything that is wrong. The first real device will find something
   (`docs/WEARABLES.md` says so in as many words).

Then a *release* build signed with a keystore you have backed up outside git
([RELEASING.md](RELEASING.md) §"Signing"), installed over the debug build.

## 6. Buy a Bluetooth chest strap

Any strap that advertises the standard Heart Rate service (Polar H10, Coospo, Magene, a
Wahoo TICKR — anything under the GATT `0x180D` service). The M2 path
(`docs/WEARABLES.md` §M2) has only been driven by a fake device.

1. In the web app on a phone browser that supports Web Bluetooth (Chrome on Android), start
   a workout, tap the heart-rate control, pick the strap.
2. Live BPM appears during a set; the session ends with avg/min/max and a per-set peak.
3. Same test in the APK.
4. Amazfit/Zepp users: enable "Heart Rate Push" (broadcast) mode on the watch and repeat.

## 7. A Zarinpal merchant id, and one real reconciliation

1. Register at <https://www.zarinpal.com/> as a merchant; obtain the merchant id.
2. Set `ZARINPAL_MERCHANT_ID` and unset `ZARINPAL_SANDBOX`; set real `PRICE_*` values — the
   defaults in `apps/api/src/payments/pricing.js` are placeholders in a currency that moves.
3. Buy the smallest term with a real card. Confirm the paid-through date advanced.
4. Start a second purchase and abandon it at the gateway. Run the reconciliation and confirm
   the row settles as abandoned rather than paid — `apps/api/src/routes/billing.js` and
   `packages/db/src/billing.js` `settleUnpaid`.
5. Refund it through Zarinpal's own console and note that the software has no refund path:
   the paid-through date has to be edited by an admin (`POST /api/admin/users/:id/subscription`).

## 8. Cafe Bazaar and Myket listings

Both take an APK; Bazaar reviews it. The copy is written:
`docs/store/listing.fa.md` (with the permission-by-permission table Bazaar asks for),
`docs/store/listing.en.md`, `docs/store/privacy.md` (the disclosures, answered for the native
build only — the web app collects more and answering from it would be a false declaration).

- Screenshots: `node infra/scripts/screenshots.mjs` renders them; set `CHROMIUM_PATH`.
- The App Store and Google Play do not exist on this path (sanctions; `docs/RELEASING.md`).
  **Never put a Zarinpal link inside a native build**, for any store.
- Item 5 first: a listing for a build no phone has run is a listing for a bug report.

## Not now

Nothing from `docs/WEARABLES.md` §"Deliberately not built", and none of the follow-ons named
there (heart-rate-into-effort, Health Connect on app start, the `.shortcut` file). Those come
after a paying coach exists, and each one is a screen that would need a picture.
