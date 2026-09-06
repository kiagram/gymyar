# Legal brief: the facts, from the code

A brief for counsel, written by reading the code. It states what the software does and where
that is decided, with file references, so that a review is spent on judgement rather than on
discovery. It contains no legal conclusions. Where a fact is uncertain it says so; where a
document and the code disagree it says that too, because that is the thing most worth knowing.

Everything below is as of commit `6fb80ce` on branch `gymyar`, 2026-09-06.

## 1. What GymYar is, and who is behind it

- A coaching platform derived from openGym (Duarte Santos, AGPL-3.0). Two products from one
  codebase (`README.md` §"Three products, one codebase"):
  - **the web service** — accounts, sync, coaching, subscriptions; the only thing that takes
    money;
  - **the native Android build** (`VITE_MOBILE=1`) — an offline single-user tracker with no
    accounts, no server and nothing to buy. `apps/client/src/lib/api.js:32` throws on any
    server call in that build, and CI fails if the built bundle mentions a host not in the
    allow-list (`infra/scripts/check-mobile-hosts.mjs`).
- Copyright holder as stated: "GymYar — Copyright (C) 2026 kiarash" (`NOTICE.md`). An
  individual, in Iran. No company is named anywhere in the tree.
- Source is public at <https://github.com/kiagram/gymyar> (`apps/site/site.js:4`,
  `apps/client/src/lib/demo.js:22`).
- No production instance has been deployed and there are no users. Nothing below has happened
  to a real person yet.

## 2. The AGPL position

**The claim.** GymYar charges for hosting, not for the code. The subscription is on the coach
side of a *hosted instance* and buys three capabilities — taking on clients, proposing
programmes, messaging. With no `ZARINPAL_MERCHANT_ID` configured, coaching is free
(`README.md` §"What is paid for", `apps/api/src/entitlement.js`, `packages/domain/src/entitlement.js`).
The project site says the same in public (`apps/site/en/index.html` §pricing: "Hosting can be
charged for; the code cannot").

**The licence chain.**

- `LICENSE` is the AGPL-3.0 text. `package.json` declares `AGPL-3.0-or-later`. openGym's
  copyright and AGPL notice are carried in `NOTICE.md` §"Derived from openGym".
- **The App Store additional permission.** openGym granted, under AGPL §7, permission to
  distribute *the openGym mobile application* through app stores whose terms are otherwise
  incompatible with the AGPL, "provided the corresponding source code remains available under
  the AGPL at the project repository" (`NOTICE.md` §"App store exception", verbatim). The
  project's reading, recorded in the same file: the permission travels to derivative works
  unless removed, it is not removed, and the condition binds GymYar in turn.
- **Section 13 (network use).** The web app offers its source to remote users in three places:
  the sign-in screen ("Self-host it in a minute →", `apps/client/src/views/Login.jsx:340`), a
  Settings row ("Self-host GymYar", `apps/client/src/views/Settings.jsx:124,130`), and the
  project site's footer and source links (`apps/site/site.js`, `data-repo` attributes). All
  point at the GitHub repository root. The Settings footer credits openGym and links to its
  upstream (`Settings.jsx:296`). `docs/PUBLISHING.md` §"AGPL: this has to be public" records
  the project's understanding that the repository must be public before payment is taken.
- **Distribution channels.** The Apple App Store and Google Play are not reachable from an
  Iranian developer (`docs/RELEASING.md` §"The store situation"). The native build is intended
  for direct APK download and the Iranian stores Cafe Bazaar and Myket. The same document
  instructs that no Zarinpal link may ever be placed inside a native build.

**Third-party components and their terms** (`NOTICE.md`):

| Component | Where | Licence as recorded |
|---|---|---|
| openGym | the whole codebase | AGPL-3.0 + App Store §7 permission |
| Vazirmatn typeface | `apps/client/src/assets/fonts/` | SIL OFL 1.1, unmodified, reserved-font-name condition noted |
| MuscleMap body geometry | `apps/client/src/lib/body-paths.js` | MIT, converted from Swift to JSON |
| Exercise names, categories and instructions in 10 languages | `packages/domain/src/exercises-data.js`, `apps/client/src/instr/` | MIT (dataset `LICENSE`, "data files" included) |
| Exercise images and animations, 1,324 of each | fetched at first boot into `media/`; hotlinked from jsDelivr by the APK | © Gym visual, proprietary — see §4 |
| Persian exercise names | `packages/domain/src/names/` | project's own translations |

## 3. The privacy policy, cross-checked against the code

The policy is `apps/site/privacy.html` (Persian, canonical) and `apps/site/en/privacy.html`
(English). The two have the same structure — 14 list items, the same headings — and the
English text is what is quoted here. It was written from the code and has not been reviewed
by anyone qualified. Each claim below is marked **holds** or **drift**.

### 3.1 The Android app

| Claim | Code | Status |
|---|---|---|
| "Collects nothing and transmits nothing" — no sign-in, sync, analytics, crash reporting | `api()` throws under `MOBILE` (`apps/client/src/lib/api.js:32,71`); CI host check (`infra/scripts/check-mobile-hosts.mjs`) allows one fetched host | **holds** |
| "Exactly one kind of outbound request — fetching exercise illustrations from a public CDN — and that request carries no identifier" | `apps/client/.env.mobile` sets both media bases to `cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@<sha>/`; no credentials exist in the build. The request carries the IP address any HTTP request carries, which `docs/store/privacy.md` says and the policy does not | **holds**, with that nuance |
| Bluetooth scan "declared as never being used to determine location"; no location permission on Android 12+ | `AndroidManifest.xml:78–84`: `BLUETOOTH_SCAN` with `neverForLocation`; the two location permissions carry `maxSdkVersion` 28 and 30 | **holds** |
| Health Connect: "asks for those two things and nothing else" | `AndroidManifest.xml:98–99`: `READ_EXERCISE`, `READ_HEART_RATE` only | **holds** |
| "Uninstalling the app removes everything"; export via share sheet | data in app-private storage; `shareExport` in `apps/client/src/lib/mobile.js` | **holds** |

### 3.2 The web service — what it holds

| Claim | Code | Status |
|---|---|---|
| Name, and an email or phone to sign in; password stored only as a hash; nothing else asked | `users` table: `name, email, phone, password_hash, locale, units` (`001_init.sql:9–22`, `010_phone_auth.sql:56`); scrypt, N=16384 (`packages/db/src/users.js:5–11`); no DOB/address/ID columns | **holds** |
| Training: routines, sessions, sets, body weight, check-ins, habits | `SYNC_TABLES` in `packages/db/src/sync.js`; migrations 001, 007, 008 | **holds** |
| Heart rate: session avg/low/high, peak around a set, daily resting | `012_heart_rate.sql:39–41`, `014_set_heart_rate.sql`, `013_resting_hr.sql` | **holds** |
| Uploads: form-check video, progress photos, voice notes | `subject ∈ {form_check, progress, message}`, kinds `video/photo/audio` (`apps/api/src/routes/media.js:120,190`) | **holds** |
| Coaching: who coaches whom, scopes, proposals, messages | `coach_links`, `proposals`, `messages` (`packages/db/src/coaching.js`) | **holds** |
| Payment: "the amount, the date and the reference … Card details never reach this service" | `payments` stores `amount, currency, months, status, ref_id, settled_at` **and `detail jsonb`, "what the gateway said, kept verbatim"** (`002_billing.sql:26–46`). On verification the raw gateway response is stored in `detail` (`routes/billing.js:188`, `db/billing.js:95`), and Zarinpal's verify response includes `card_pan` — a masked card number — and `card_hash` (`payments/zarinpal.js:224`). The row is never rendered to the payer (`routes/billing.js:209`) but it is held | **drift** — a masked PAN and a card hash are stored; the policy says card details never reach the service |
| Also sent to the gateway: the payer's **email address**, as Zarinpal `metadata` | `routes/billing.js:124`, `payments/zarinpal.js:190` | not stated in the policy |

### 3.3 Health data, specifically

| Claim | Code | Status |
|---|---|---|
| Import file read in the browser, never uploaded | `packages/domain/src/import-health.js` runs client-side; no upload route accepts an export (`grep` of `apps/api/src/routes` finds none) | **holds** |
| iPhone shortcut: user-created key, last-used visible, revocable at any time | `health_tokens` with `last_used_at`, `revoked_at` (`015_health_shortcut.sql:42–43`); `routes/health.js` mints and revokes | **holds** |
| "Not analysed for any other purpose, not aggregated with anyone else's, not sold, not shared with anybody — no advertiser, data broker, insurer, analytics provider" | No analytics, advertising or export integrations exist. **But** see §3.5: when a model provider is configured, free text and training summaries are sent to it | **holds** for health data; **drift** in the general statement, see below |

### 3.4 What a coach can see

| Claim | Code | Status |
|---|---|---|
| "programmes, sessions, body weight, check-ins, habits, form-check video and progress photos are individual permissions" | `SCOPES = ['programmes','workouts','bodyweight','checkins','habits','photos']` (`packages/db/src/coaching.js:39`). **Form-check video is not its own scope: it rides `workouts`** (`routes/media.js:81–83`, and `docs/ARCHITECTURE.md` §Attachments says so). Progress photos are their own scope (`photos`) | **drift** — seven items are named, six scopes exist |
| Withdrawal takes effect immediately | scope checked on every read via `requireScope` | **holds** |
| A coach cannot edit training; proposals change nothing until accepted | `proposals` flow (`ARCHITECTURE.md` §Coaching) | **holds** |

### 3.5 Getting it out, and getting rid of it

| Claim | Code | Status |
|---|---|---|
| Export: everything, as a file, from Settings | `doExport` in `Settings.jsx:72–81`, client-side JSON of the state | **holds** (training state; it does not include uploaded media bytes or messages) |
| **"Deleting your account removes your training, your uploads and your account rows"** | **There is no account-deletion route and no account-deletion control.** The API has `DELETE /api/me/email` and `DELETE /api/me/phone` (unlink an identifier) and an admin `POST /api/admin/users/:id/disable` (sets `disabled_at`); nothing deletes a user. The client locale files contain no "delete account" string. The schema is ready for it (`on delete cascade` throughout; attachment bytes are swept when rows go, `packages/db/src/attachments.js:198`) but nothing invokes it | **drift — the policy promises a capability that does not exist** |

### 3.6 Statements about the operator and third parties

| Claim | Code | Status |
|---|---|---|
| "The software … makes no outbound request to us or to anyone else on your users' behalf" | It makes several, all operator-configured and all off by default: **email** via an SMTP relay (`packages/mail/src/smtp.js`, nodemailer) carrying the address and a sign-in/reset link; **SMS** via Kavenegar or sms.ir (`packages/sms/src/*.js`, `api.kavenegar.com`, `api.sms.ir`) carrying the phone number and a code; **web push** via the browser vendors' push services (`routes/push.js`, `notify.js`) carrying a sender's name and a routine title in the notification body; **payment** to Zarinpal carrying amount, description and the payer's email; and **a language model** (§3.7). None goes to the project's authors | **drift** in wording — nothing goes to "us", several things go to "anyone else" |
| Server logs | Fastify request logging is on at `info` (`apps/api/src/server.js:7`); its default request serializer records method, URL and **remote IP address** per request. No redaction is configured. Retention is whatever the host's log rotation does | **not stated** |
| Public counters on the site | `/api/public/*` serves counts and one tonnage sum, no row, no identifier (`routes/public.js:9,46–59`), switchable with `PUBLIC_STATS` | **holds** (aggregate only) |

### 3.7 The language-model path, which the policy does not mention

Off by default. With a key configured (`.env.example`; `packages/ai/src/index.js:55–70` supports
Anthropic, OpenAI, DeepSeek, any OpenAI-compatible endpoint, and a self-hosted Ollama), three
things leave the instance for that provider:

- **`interpretBrief`** — up to 2,000 characters of free text the person typed about their goals
  and circumstances (`index.js:213–218`);
- **`explainChange`** — the client's **name**, the routine name, exercise ids with before/after
  numbers, and the domain's worded findings (`index.js:236–250`, `clientName` is in the payload);
- **`parseLog`** — the typed training log (`index.js:289`).

Photographs go only to a model on the operator's own hardware (`visionFromEnv`, Ollama only;
`.env.example:94–103`), and progress photos are never sent to any model (`.env.example:97`).
`/api/ai/status` reports which provider answered. The privacy policy says nothing about a model
provider, and the "not shared with anybody" sentence in §3.3 is unqualified.

### 3.8 Things present in the schema but not in the product

- `identities (provider in ('apple','google'))` exists (`001_init.sql:36–43`) and nothing reads
  or writes it. There is no OAuth sign-in. Inherited shape, not a data flow.

### 3.9 Things the policy does not address at all

Retention beyond "deleted media is erased on the sweeper's next pass" (`docs/SELF_HOSTING.md`
§5, fifteen minutes); backup retention (deferred to the operator); minimum age; the legal basis
for processing under any regime; a controller identity; a contact address; the operator's own
logs. There is no terms-of-service page, no refund statement, and no page describing the
subscription's terms beyond the pricing section (`ls apps/site` — `index, about, docs, privacy`).

## 4. The exercise media

The full analysis is `docs/MEDIA_OPTIONS.md`. The facts counsel needs:

- The 1,324 images and animations are © Gym visual (Aliaksandr Makatserchyk, per
  <https://gymvisual.com/content/3-terms-and-conditions-of-use>). Gym visual's terms: licences
  are sold per account to "the account owner (person or organization)", are non-transferable,
  and "none of our Media may be resold or redistributed by any means, or made available for
  redistribution … by a third party" without separate written consent.
- They reach us through `hasaneyldrm/exercises-dataset`, whose `NOTICE.md` says the media is
  redistributed there **with Gym visual's separate written permission**, at 180×180 only, on
  condition that "every use must carry the copyright indication © Gym visual —
  https://gymvisual.com/", and that "this repository does not grant you any rights to the media
  beyond what Gym visual's terms allow — cloning this repo is not a license."
- **How we use it.** The hosted instance clones that repository at first boot and copies the
  files onto its own volume (`docker-compose.yml`, `media` service). The APK hotlinks jsDelivr's
  mirror of the same repository (`apps/client/.env.mobile`). The attribution string is stored
  in `exercises.attribution` (`packages/db/src/seed-exercises.js:26,56`) and in
  `packages/domain/src/media-set.js`, and **is not rendered anywhere in the client UI** —
  Settings credits "hasaneyldrm/exercises-dataset" by name (`Settings.jsx:296`), not Gym visual.
- **The machine-readable position.** `MEDIA_SET.commercial = false` (`media-set.js`), and
  `npm run media:check` exits 1 while that is so. It is in the release checklist, not CI.
- **The GitHub re-upload.** The tree this project was read from had committed 2,649 Gym visual
  media files that upstream deliberately does not ship (`CHANGELOG.md` §Security). They were
  removed from this tree; whether they persist in that other repository's history is not
  something this project controls.

## 5. Share-alike, if wger is adopted

- wger's images are CC-BY-SA 3.0 (88) and 4.0 (286), self-declared per record by some sixty
  uploaders; 43 are flagged AI-generated and the adapter excludes them. Verified against
  `https://wger.de/api/v2/exerciseimage/` and `/license/` on 2026-09-06; adapter comment in
  `infra/scripts/media-set.mjs`.
- **What adoption would look like in code.** A generated `media-set.js` mapping our ids to
  wger image URLs, each entry carrying `by` (the uploader's name) and `licence`. The images
  would be served by us (copied onto the media volume) or hotlinked. No image is modified;
  a cropped or recoloured one would be an adaptation.
- **Coverage if adopted.** 20 of 1,324 library exercises and 5 of the 67 the planner
  prescribes, by strict name matching; perhaps 35–40 of 67 after a hand-confirmed mapping.
- **The question underneath.** Whether displaying CC-BY-SA images in an AGPL web application
  and an AGPL Android app, with per-image attribution, creates any share-alike obligation on
  anything other than the images themselves — and what "attribution" must look like on a
  180-pixel thumbnail in a mobile screen.
- The earlier belief that Free Exercise DB's artwork was CC-BY-SA from Everkinetic was wrong;
  those are unattributed photographs of unknown ownership, and the adapter now says so. No
  question for counsel arises from a set that cannot be used.

## 6. The Iranian entity, Zarinpal and the AGPL, as one structure

- **Operator.** An individual in Iran (§1). Hosting is expected to be an Iranian VPS or a
  machine behind Cloudflare Tunnel or Caddy (`docs/SELF_HOSTING.md` §4). S3 and the CDNs are
  documented as unreachable from an Iranian entity, which is why the filesystem storage driver
  is the default (`docs/ARCHITECTURE.md` §Attachments).
- **Payments.** Zarinpal only (`apps/api/src/payments/zarinpal.js`), live and sandbox endpoints
  at `payment.zarinpal.com` and `sandbox.zarinpal.com`. Amounts in IRR, quoted to the buyer in
  Toman (`payments/pricing.js`, placeholders that "are not a recommendation"). No recurring
  billing exists at the gateway; a subscription is a paid-through date that a purchase extends
  (`002_billing.sql:15–17`). A `trial_ends_at` column exists (`db/billing.js:39`). Every attempt,
  including abandoned ones, is recorded. Prices are configured per deployment in the
  environment, not in code.
- **What is sold.** Three coach-side capabilities on a hosted instance; never anything to a
  client, and never in the native build (`README.md`, `docs/RELEASING.md`).
- **US-origin services the configuration offers.** `.env.example` documents Anthropic and
  OpenAI as model providers, AWS S3 as a storage driver, and web push goes to Google's and
  Apple's push services; the source is hosted on GitHub and the APK's media on jsDelivr. All
  optional except GitHub and jsDelivr. Whether an Iranian operator may lawfully contract with,
  or is in practice able to reach, any of them is outside what the code can say.
- **The AGPL and the store paths.** Cafe Bazaar and Myket are the intended Android channels
  (`docs/RELEASING.md`); `docs/store/listing.fa.md` carries a permission-by-permission
  justification. Whether those stores' terms are "incompatible with the AGPL" in the sense the
  inherited §7 permission contemplates has not been examined.

## 7. Questions for counsel

Numbered so they can be answered in order. Each names the code that raises it.

1. **AGPL §13 offer.** Is a link labelled "Self-host GymYar" on the sign-in screen and in
   Settings (`apps/client/src/views/Login.jsx:340`, `Settings.jsx:124`) a "prominent offer" of
   the Corresponding Source to users interacting through a network? Must it name the licence?
2. **The inherited §7 permission.** Does openGym's App Store additional permission
   (`NOTICE.md`) extend to GymYar's builds, to Cafe Bazaar and Myket specifically, and is its
   condition — source "at the project repository" — met by a GitHub repository under a
   different name from the upstream's?
3. **Charging for hosting.** Is the position in `README.md` §"What is paid for" and
   `apps/site/en/index.html` §pricing — a subscription gating coach-side features of a hosted
   AGPL instance, with the same features free on any self-hosted copy — consistent with the
   licence as counsel reads it?
4. **The exercise media as currently shipped.** Given Gym visual's terms and the dataset's
   `NOTICE.md` (§4): (a) does the hosted instance's first-boot copy constitute redistribution;
   (b) does the APK's hotlink; (c) is a licence bought by an individual in Iran assignable to a
   company later; (d) does the missing on-screen "© Gym visual" line already breach the
   dataset's redistribution condition, even for a free instance?
5. **The commercial licence's shape.** If Gym visual sells a licence, what must it say to cover
   a hosted web app, a native build that carries the files, and the mobile build's CDN hotlink?
6. **Share-alike.** If wger's CC-BY-SA images are adopted (§5): what, beyond the images, does
   SA reach; what does per-image attribution require in a mobile UI; is excluding AI-generated
   records the right line?
7. **Account deletion.** The privacy policy promises it (§3.5) and the software cannot do it.
   Which of the two changes, and is a policy that promises a non-existent capability a problem
   in itself under any regime that applies?
8. **Card data.** `payments.detail` stores Zarinpal's verify response verbatim, including a
   masked card number and a card hash (§3.2). Does holding it contradict the policy, and is it
   subject to any card-data rule that applies in Iran?
9. **Form-check scope.** The policy lists form-check video as its own permission; the code ties
   it to the `workouts` scope (§3.4). Which should change?
10. **Model providers.** When an operator configures a third-party model, a client's name and a
    person's free text about their training leave the instance (§3.7). What must the policy
    say, and does it differ for a self-hosted Ollama?
11. **The "no outbound request" sentence** (§3.6). It is false for email, SMS, push and payment.
    What is the accurate form?
12. **Server logs.** Request logs carry IP addresses (§3.6). Must the policy say so, and for how
    long may they be kept?
13. **Health data.** Heart rate, body weight and progress photographs are held (§3.2–3.3). Under
    Iran's data-protection framework as it stands, and under any regime that reaches a
    foreign user who signs up, does that classification impose anything the code does not do?
14. **Minors.** No age is collected and no minimum is stated (§3.9). Should one be?
15. **Terms of service and refunds.** None exist (§3.9). What is the minimum for a paid
    subscription sold in Iran through Zarinpal, given there is no recurring charge and a
    purchase extends a date?
16. **The operator identity.** The policy says "they hold your data, not us" for third-party
    instances. For the instance the project itself will run, who is the controller, and where
    must that be stated?
17. **Sanctions exposure of optional integrations** (§6). Is documenting Anthropic, OpenAI and
    AWS as configuration options — none used by default — a problem for an Iranian operator, and
    is publishing on GitHub and serving the APK's media from jsDelivr?
18. **The re-upload with secrets** (`CHANGELOG.md` §Security). A third party's public repository
    committed a live instance's signing secret, VAPID key and user records. Is there any
    obligation on this project toward the people whose records those were?
