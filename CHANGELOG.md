# Changelog

Two projects live in this file. GymBuddy's own releases come first; under
[openGym, before the fork](#opengym-before-the-fork) is the history of the project this one
was forked from, kept as it was written.

**About the version number.** GymBuddy starts again at 1.0.0. openGym had reached v1.2.4 by
the time of the fork, so the first version below is a lower number than the ones further
down the page — those are a different product's version line, not a release this one
regressed from. The reset is also load-bearing: Android's `versionCode` must strictly
increase or the OS refuses an update, and the fork inherited openGym's `versionCode 5`.
1.0.0 stamps as build 10000 and clears it.

---

## v1.0.0 — unreleased

GymBuddy is openGym with a second person in it. Everything openGym did for one person
tracking their own training is here, and none of it is gated. What is new is a coach on the
other side of it — and the storage rewrite that had to happen first, because two people
could not touch the same training without one of them silently erasing the other.

### Rows instead of one JSON document

openGym stored a user's entire account as a single JSON document and synced it with a
whole-state `PUT`, last write wins. For one person on their own server that is an elegant
design: no schema, no merge logic, nothing to get wrong. For coaching it is fatal. A coach
editing a programme while their client is mid-session destroys one of those two edits and
tells nobody, and a server that never parses what it stores can never answer a question
about it — so "which of my clients has stalled?" is not a slow query, it is a question that
cannot be asked.

- 🗄️ **Postgres, and a delta sync.** Every write to a syncable row goes through
  `log_change()`, which bumps a per-user counter and records what changed at that value. A
  client remembers the last counter it saw and asks for what came after it, instead of
  sending its whole account and hoping.
- The app still holds the entire state in memory as its working copy — that part was never
  the problem, and it is what keeps training working with no signal. One mapper
  (`packages/domain/src/statemap.js`) sits between the two worlds and is imported by both
  sides, so there is one of it rather than two that drift.
- 🧱 **One `exercises` table** with a nullable owner replaces the library/custom split, so
  every set carries a real foreign key and the exercise media sits behind swappable URLs.
  A licence refusal on the artwork becomes an `UPDATE` rather than a migration.
- 📥 **An openGym account comes across.** The code that turns an openGym state file into
  rows is part of the project rather than a one-off script, and the demo seeder runs through
  the same path — so the migration is exercised every time anyone seeds.

### Coaching: a coach proposes, a client accepts

The whole design rests on one rule, and it is a property of the schema rather than a promise
in a settings screen.

- 🤝 **A coach never writes a client's rows.** A proposed programme lands in
  `routine_revisions` and becomes real only when the client accepts it — at which point it
  is written as the client's own row, through the ordinary sync path. There is exactly one
  writer per row, so there is nothing to merge, and a client's own edit cannot be erased by
  a coach's sync.
- 🔒 **Scopes gate every coach-side read**, section by section. Sharing a programme does not
  share what you weigh, and a scope can be withdrawn later.
- 📊 **A roster sorted by what needs attention**, not by name: adherence per client, who has
  gone quiet, whose loads have stalled.
- 📨 **An inbox that shows the diff.** A client sees sets and reps before and after, so
  accepting a proposal is a decision rather than a click.
- 💬 **Messaging** attached to the client and the week it concerns.
- 🔑 **Email and password sign-in alongside passkeys.** Passkey-only is a dead end for a
  mainstream signup — "create an account" cannot fail on a device whose browser will not do
  WebAuthn.
- 🐳 `docker compose up` really is the only command: the API container migrates and seeds on
  boot, and both are idempotent. `SEED_DEMO` creates a coach and three clients with twelve
  weeks of training each — including one who shares only programmes and one who stopped
  turning up, because a roster where everybody is at 100% demonstrates nothing.

### Programmes, review, and logging by typing

The division of labour matters more than the feature list: **the domain owns every number, a
language model owns language.**

- 🧮 **Sets, reps, loads, progression policies and exercise selection are computed** by
  `packages/domain/src/planner.js`, against the real library and the same progression rules
  the app already runs on. A model is asked to do exactly two things — turn free text into a
  structured brief, and write the note explaining a change — and both have deterministic
  implementations underneath.
- **With no API key configured, GymBuddy builds the same plans, finds the same stalls and
  parses the same logs.** It phrases things from a template instead of writing prose, in
  whichever language the person is using, and `/api/ai/status` says so. Nothing here can
  invent a lift that is not in the library, or put 140 kg on a beginner's bar.
- 🔍 **Selection resolves patterns by name against the live data** and requires a named
  match rather than treating one as a tie-break. Going by target muscle alone was putting
  "left hook. boxing" into overhead-press slots and "rear deltoid stretch" into rear-delt
  slots — the dataset tags both as delts. Heavy compounds vary across the week, so a
  four-day split no longer prescribes barbell deadlift 5×5 twice; accessories do not vary,
  because reaching for variety there finds "dumbbell biceps curl squat".
- 📉 **Training review reads logged sets only**, never self-report. Stalls come from the same
  `stallCount` the progression policies use, attendance counts finished sessions, and "this
  is too easy" needs four rated sessions before it will say so.
- ✍️ **Nothing is ever applied for you.** A review's worst finding becomes a routine in the
  app's own shape — which is exactly the payload the propose endpoint takes — so a coach
  reviews a filled-in composer and sends it. Nothing reaches a client that a coach did not
  send, and there is no endpoint that writes training.
- ⌨️ **Log a session by typing it.** "deadlift 100x5" is one set of five at a hundred, not a
  hundred sets. A model only ever rewrites phrasing the parser could not read; the parser
  still does the naming, so a model cannot put an exercise into a log that is not in the
  library.

### Persian, and a week that starts where your locale starts it

Farsi is the twelfth locale and the first that is not written left to right. Adding it turned
up three things that were never about translation.

- 🗓️ **The week grid was anchored to Monday.** Iran's week starts on Saturday, and a Monday
  anchor does not fail visibly — it shifts every heatmap cell, every streak and every "this
  week" count by two days. `weekKey` is now the start of the week as a calendar day, computed
  from the locale, so a cell and the offset that positions it cannot disagree.
- 🌍 **The domain was building user-facing sentences out of English fragments** the client had
  no way to translate. Those moved to `domain/messages.js`, behind the adapter the rest of the
  domain already used.
- ↔️ **The layout mirrors under `[dir="rtl"]`.** Two things cannot be mirrored by CSS logical
  properties alone — a transform and a directional glyph — and those are handled explicitly
  rather than left to look almost right.
- 🏋️ **Exercise names are translated for the 66 the planner can actually emit**, found by
  sweeping `buildProgramme` across the brief space rather than by guessing. The generator
  refuses to write the file if the planner ever reaches one that is missing; everything
  outside that set falls back to its English name.
- 🌐 **The whole app is translated, not just the parts a solo lifter sees.** 204 strings — the
  roster, client detail, the proposal composer, the inbox, the plan builder, the training
  review, typed logging, sign-in and the admin screen — called `t()` correctly and had no
  entry in any of the twelve locale files, so they rendered in English everywhere, worst in
  Farsi where the layout mirrors around them. They are translated now, in all twelve.
- 🔎 **The check that missed it, fixed.** `scripts/check-locales.mjs` only ever compared the
  locales against each other, which is why 204 strings missing from *all* of them passed
  every run. It now also reads the source: a `t('…')` with no entry anywhere fails CI, so
  the next screen cannot ship the same way.
- 🔢 **Plurals, for the languages where "the plural" is not one form.** Call sites pick their
  key the way English works — `t(n === 1 ? '{0} set' : '{0} sets', n)` — which quietly hands
  Russian and Polish a single string to cover 2, 5 and 21. It is not a translation that was
  missing, it is a shape: 2 подхода, 5 подходов, 21 подход. A locale can now give an object
  keyed by CLDR category instead of a string and `t()` selects through `Intl.PluralRules`,
  with `n` naming which argument the noun agrees with when it is not the first ("{0} of {1}
  sessions" follows the second). No call site changed; 68 entries across `ru.js` and `pl.js`
  did, and `check-locales.mjs` fails a plural object that is missing a category its language
  distinguishes, drops a placeholder, or appears in a language that has only one form.
- 🔔 **Push notifications speak the reader's language too** — inherited from openGym, where
  the text was written server-side and shipped English to everyone. Nothing stores a
  language for a user, and the locale packs live in the client bundle, so the fix is not a
  second dictionary on the server: the client sends the words with the request that schedules
  the timer, at the one moment it is awake and knows both. English is what the server sends
  if a client omits them, which is what an older build looks like from there.

### A choice of model, and limits that do not punish a neighbourhood

- 🔌 **The model layer stopped being Anthropic-shaped.** One OpenAI-compatible adapter covers
  DeepSeek, Ollama and the rest, in two tiers: the fast one answers the jobs the domain
  re-validates anyway, the deep one writes the note a person reads verbatim. A local model is
  the failover, since an outage, a lapsed key and a blocked route are indistinguishable from
  inside the process.
- 🚦 **Rate limiting is on by default and keyed by account, not by address.** Users behind
  carrier-grade NAT share an address, so an IP-keyed limit lets one abuser lock out a
  neighbourhood. Sign-in is keyed by the identifier being tried, so failing to guess one
  person's password cannot lock anyone else out.

### Subscriptions, on the coach and never on a client

Training is free and stays free — logging, programmes, history, stats, all ungated. What a
subscription buys is the coach side: taking on clients, proposing programmes to them, and
messaging them.

- 🙅 **A client is never gated.** Not to accept a proposal, not to answer their coach, not to
  change a scope. They are not the customer, and a coach whose payment lapses cannot take
  their clients' training away — it was never the coach's to take, since a client's rows are
  written through their own sync.
- 👀 **Reading survives every state.** A lapsed coach still opens the roster they built and
  the conversations they had. What stops is growth and authorship. Grace keeps messaging on,
  because the week somebody's payment fails is the week they most need to explain it.
- 🏠 **No merchant id means no billing.** A self-hosted instance gets coaching free and never
  writes a subscription row; `describeEntitlement` answers null, so the roster grows no
  subscription row and the app has no idea the concept exists. The paid tier is a property of
  a *deployment*, not of the software — which is the only honest reading of a licence that
  lets us charge for hosting rather than for code.
- 💳 **Zarinpal**, because Stripe and Paddle are available to neither Iranian merchants nor
  Iranian cardholders. It has no recurring billing, so a subscription is a **paid-through
  date** that a purchase extends — stacked onto whatever is left, so paying early is never
  punished — rather than a state machine something upstream drives.
- 🔁 **It cannot bill twice.** There are no webhooks either, so payment is confirmed when the
  payer's browser returns — and browsers come back twice: a refresh, a retry, a link opened
  on two devices. The unique index on `ref_id` is what stops a second verify being credited,
  and `credit()` writes first and treats the violation as the success it is, because a
  read-then-check loses that race and an index cannot. Verifying always sends the *stored*
  amount, so a tampered callback is a rejection from the gateway rather than a cheap year.
- 🔎 **The ones that never come back are found, not hoped for.** `stalePayments()` and
  `unverified()` exist to find people who paid and got nothing.
- 🧾 **A subscription screen at `/billing`** that says what you have, what it costs to keep
  it, and what you have paid. Its wording is a decision table in `lib/billing.js` rather than
  a conditional per screen, because the same five states are described in three places and
  three screens disagreeing about whether a trial has "ended" or "run out" reads as three
  bugs.
  - **A 402 is a destination, not an error message.** Proposing a change or messaging a
    client on a lapsed subscription sends the coach to the screen that fixes it. A red
    sentence with no way forward is how you lose a customer who was trying to pay you.
  - **Nobody's training is ever implied to be at risk.** The expired state leads with the
    fact that clients keep their training and lose nothing. A paywall that leaves the reader
    unsure whether their own logged sets are hostage deserves to lose the sale.
  - `pending` gets its own wording and its own tone. We asked the gateway and could not get
    an answer, so calling it a failure would be a lie about their money — it says we are
    checking, and not to pay again.

### Two products from one codebase

The native builds were always a different product. This makes that deliberate rather than
incidental.

- 📱 **The mobile build has no accounts, no backend, no coaching and nothing to buy.**
  Training data lives in a file in the app's private storage.
- 🚫 **`api()` now throws in the native build.** Every caller was already behind a check, but
  "should never run" is not what you want underneath a privacy declaration that says the app
  transmits nothing. A screen that forgets the check now fails loudly in development instead
  of quietly reaching out. `/billing` is routed away in mobile and demo builds rather than
  left to fail against a server that is not there.
- ✅ **A check standing behind that declaration.** `infra/scripts/check-mobile-hosts.mjs`
  builds the mobile bundle and fails on any host not accounted for, with a written reason for
  each of the seven that are. Six are link targets, error-message URLs and an SVG namespace;
  exactly one — jsDelivr — is actually fetched.
- 🌐 **Coaching is a web product.** Anyone who wants it uses the PWA, which is also the whole
  answer to every store's rules about who may take money for digital goods: a build with no
  accounts and no payment surface raises none of them.

### A visual identity, cut from one vector

- 🔴 **The mark**: the figure with its arms crossed, one silhouette with the muscle contours
  cut out of it as negative space. On the red field it reads white with red lines; on paper,
  red with white lines. One shape, two colourways, no second piece of artwork. It is a real
  vector traced from the brand artwork rather than upscaled from it.
- 🎨 **GymBuddy red `#E63935`** (Pantone 185 C), read off the brand system's own colour sheet
  rather than sampled by eye. It is a token of its own, `--brand`, identical in both themes —
  `--red` stays Apple's, because that is the *error* colour and a destructive action should
  look the way the platform says it looks.
- 🏭 **One source, twenty-odd outputs.** `infra/scripts/render-logo.mjs` cuts every raster
  from the vectors — PWA icons, the SVG favicon, twenty-four Android mipmaps, the iOS app
  icon, both platforms' launch screens. Nobody edits a PNG by hand, so they cannot drift, and
  CI fails a build where a committed one has. `--check` compares per-pixel with a tolerance
  rather than byte-for-byte, because a PNG rendered by Chromium on Linux is not the same file
  as one rendered on Windows, and a check that fails on the developer's own operating system
  is a check that gets deleted.
- 🖼️ **The launch screen is a layout rule, not a drawing**: the icon tile centred on off
  black at 26% of the shorter side, with night variants, since the app is dark whichever way
  the system is set and a light launch screen would flash white before the first paint.
- ✒️ **The wordmark and lockups are vectors too**, traced off the hero render's alpha channel
  — a letterform is exactly its alpha, so the shading inside it stops mattering. `BUDDY` is
  red in every colourway; only `GYM` and the tagline change.

### Release engineering

- 🔢 **One version, four files.** They had drifted to three answers: the workspace said 0.1.0,
  Android said 1.2.4 with openGym's `versionCode 5`, and iOS said 1.0. `infra/scripts/version.mjs`
  stamps one version into the workspace packages, the Gradle file, the Xcode project and the
  PWA manifest; `--check` fails on drift, and CI runs it.
- 🔐 **Release signing**, reading a gitignored `keystore.properties` or `GYMBUDDY_KEYSTORE_*`
  from the environment — and building unsigned with a warning when it has neither, so a
  contributor can check the release build compiles without holding a key.
- 📄 **Store listings in English and Persian**, written separately rather than translated, and
  both describing the offline app — a listing that promises coaching the binary does not have
  is a rejection. Plus privacy answers for Play Data safety, Apple's labels and Cafe Bazaar.
- 📸 **The screenshots are generated, not collected.** `infra/scripts/screenshots.mjs` drives a
  real browser over a seeded demo stack and captures the five screens the listings are written
  around, at 1170×2532. Both languages: `--fa` switches the app to Persian through its own
  settings and asserts the layout actually mirrored before shooting anything, because a
  silently-failed language switch produces an English set under a Persian filename. Shooting
  against the seed rather than a fresh account is what keeps a store from rejecting the set as
  placeholder data — and the Persian home screen is also the clearest evidence the
  locale-aware week works, since it starts on Saturday.
- 🌏 **The store situation is stated plainly.** The Apple Developer Program and Google Play
  Console are not available to Iranian developers or Iranian companies. That is not a step
  that was skipped — it is not a step that exists on this path, and `docs/RELEASING.md` says
  so rather than leaving the next person to discover it at signup. What exists instead: a
  signed APK, Cafe Bazaar and Myket, and the PWA on iOS.
- CI gained the version check, the locale check, the release-tooling suite and the mobile host
  check, ordered so the *web* bundle is what is left in `dist/` rather than the backend-less
  one.

### Under the hood

- **Fastify** replaces openGym's 554-line hand-rolled HTTP server. Passkey registration and
  login carry across unchanged in substance; sessions keep openGym's signed-cookie scheme,
  including the `session_version` bump that revokes every device at once. Routes throw
  `{ status }` and one error handler turns that into a response, so permission rules read as
  rules and a 500 logs its detail instead of leaking it.
- **The tree is an npm workspace**: `apps/client`, `apps/api`, `apps/site`, `packages/domain`,
  `packages/db`, `packages/ai`, `infra`.
- **`packages/domain` is runtime-agnostic** — no DOM, no React, no Vite-only syntax — so the
  same code that computes a prescription on a phone in a basement computes it on the server
  when a coach or the planner proposes a programme. Translation goes through an i18n adapter
  seam that the client registers its runtime into and that falls back to English elsewhere.
- **The exercise library is served, not only bundled**, since a coach picking movements for
  someone else has no local catalogue for them.
- **The app id** moved from `ch.duartesantos.opengym` to `com.gymbuddy.app` across Capacitor,
  the Android package and the iOS project.

### Known limitations

- 🖼️ **The exercise media is not licensed for a commercial deployment.** The 1,324 animations
  are © [Gym visual](https://gymvisual.com/) and the dataset grants us nothing; they are
  fetched from upstream on first run rather than redistributed here. Exercise rows carry
  `image_url` and `animation_url`, so replacing the source is an `UPDATE` — but until that
  happens or a licence is obtained, this cannot ship as a paid product.
- 📦 **There is no public repository yet**, and the AGPL requires one before a hosted instance
  takes payment. See `docs/PUBLISHING.md`. Until there is one, the app's "self-host GymBuddy"
  links are hidden rather than pointed somewhere, `SECURITY.md` has no private reporting
  channel to name, and `CONTRIBUTING.md` has no issue tracker to send anyone to.

### Fixed, inherited from openGym

- 🪟 **`npm run build:mobile` had never worked on Windows.** It used a `VAR=value cmd` prefix,
  which is shell syntax, and npm runs scripts through `cmd.exe` — where it is a syntax error.
  Documented in two places and broken the whole time. The environment moved to
  `apps/client/.env.mobile` and `vite build --mode mobile`.
- 🔢 **Android's `versionCode` was 5**, inherited at the fork and never reset. It must strictly
  increase or Android refuses to install an update at all.
- 🧩 **`exercises.js` read `import.meta.env`**, which is Vite-only, so the extracted domain
  package threw on import in plain Node. Media bases now go through a setter, and a test runs
  the package in a real Node process — vitest's transform would have hidden it.
- 📚 **`truncate users cascade` took the shared exercise library with it**, because
  `exercises` has an FK to `users`. Deletes cascade properly; there is now a test that fails
  if anyone reintroduces it.
- 🔴 **`.err` was used by every view that can fail to load and had never been given a colour**,
  so a failure rendered as ordinary body copy.
- 📖 **`docs/MOBILE.md` was still entirely openGym's** — `frontend/` paths,
  `opengym-state.json`, and a download link to somebody else's site.

### Security

- 🚨 **`data/` and `media/` were dropped from the tree and gitignored.** The GitHub re-upload
  this code was read from had committed a live instance's **session signing secret, VAPID
  private key and user records**, along with 2,649 Gym visual media files that upstream
  deliberately does not ship. If you are running anything derived from that re-upload, rotate
  those secrets.
- The remote it came from is named `source` rather than `origin`, so a reflexive `git push`
  cannot send this work to a stranger's public tree.

### Licence

GymBuddy is **AGPL-3.0-or-later**, inherited from openGym and kept deliberately. `NOTICE.md`
carries openGym's attribution and its AGPL section 7 App Store permission verbatim, with a
note that the permission travels to this work — and that its condition, corresponding source
available under the AGPL, binds us too.

---

# openGym, before the fork

Everything below is openGym's changelog as it stood at the fork, by Duarte Santos. Canonical
upstream: <https://gitea.com/DuarteSantos/openGym>. It describes openGym, not GymBuddy — the
storage model, the sign-in options and the distribution channels it refers to have all since
changed. It is kept for provenance and for the attribution trail.

## v1.2.4 — 2026-08-01

The effort ratings you have been recording since v1.2.3 now answer questions, and bodyweight
training stops being treated as barbell training with the weight left at zero. Plus: creating a
profile from Settings works on an invite-only instance, which it never has.

### The effort ratings, read back as statistics

v1.2.3 let you rate how hard a set was. Nothing then read that rating back — it lived in the set
label and nowhere else. Stats now answers the question the number was recorded for.

- 📊 **An Effort card in Stats** over 30d / 90d / 1Y / all time: average effort, the share of sets
  taken close to failure, and — always alongside them — how much of your training was rated at
  all. Rating is optional and off by default, so a partly rated history is normal; an average
  without its denominator would quietly speak for sets you never rated.
- **Week by week.** The weekly average with that week's set count in the tooltip, because the
  pair is the reading: volume up with effort up is fatigue accumulating, volume up with effort
  flat is the adaptation you were training for. Weeks resting on a single rated set are dropped
  rather than drawn.
- **Where the sets land.** The spread across the scale, not just the middle of it. Half your sets
  at failure and half in warm-up territory average out to a healthy-looking number; this is the
  chart that shows it.
- 🔥 **Hard-sets mode on the muscle map.** The same body diagram, counting only sets taken near
  failure — "where did the stimulus go" rather than "where did the volume go". A muscle can lead
  on set count and still never be trained hard.
- **Effort on the exercise curve.** Each session's dot on the top-set chart fills in as less is
  left in the tank, so the same weight moved with more in reserve stops reading as a flat line.
  Exercises with enough ratings also get an Effort curve of their own.
- **One history, whichever scale you use.** Everything aggregates internally in RIR and converts
  back for display, so a history that mixes your own RIR logs with imported RPE averages as one
  series instead of two half-empty ones. RIR charts count downward on the axis, so harder sets
  sit higher.
- Translated into all 12 UI languages.

### Bodyweight training, logged the way it is done

A push-up has no weight to type, and the app asked for one anyway — every set, on a quarter of
the catalogue. Three reports (#31, #32, #33) turned out to be the same gap: the app assumed
progress lived in the load. It doesn't, for the exercises most people actually start with.

- 💪 **Exercises know they are bodyweight.** Seeded from the equipment the dataset already
  records, so push-ups, pull-ups, dips and 300-odd others arrive marked. The weight column is
  not shown, the set row is one stepper instead of two, and the "confirm your working weight"
  prompt at the end of an exercise stops asking about a weight that was never there. (#32)
- **Added weight when there is any.** A dip belt or a weighted vest is entered once in the
  exercise settings and reads as an addition — "+10 × 8", not "10×8" — everywhere it is shown
  back. With load on the belt the normal progression rules take over again, because now there
  is something to add.
- 📈 **Reps and sets are the progression.** Clean session, one more rep. Set a top of the range
  and reaching it adds a set and starts the reps over instead of climbing forever; at six sets
  it says what it should have said all along, which is that it is time for weight or a harder
  variation. No ceiling set keeps the old behaviour exactly. (#33)
- ↔️ **Reps per side.** For lunges, single-arm rows and every other unilateral movement. You
  log what you did — 16, the total — and the app shows the split, "8 per side", so the set in
  front of you is unambiguous without the rep count meaning one thing here and another there.
  The target steps in twos, 16 → 18 → 20, because half of an odd total is a rep one side never
  gets. (#31)
- Both settings travel with a shared plan, and are written to a plan file only when they
  disagree with the catalogue — every existing plan, workout and backup is read unchanged and
  none of it needs migrating.
- Translated into all 12 UI languages.

### Fixed

- **Creating a profile from Settings on an invite-only instance.** The sign-in screen asks for
  the invite code when the server needs one; the same registration reached from Settings never
  did, so it was refused with nothing on screen explaining why. It now asks on the same terms.
- **A long value no longer runs through its own label** in a settings row — "Follow the routine
  (Linear progression)" overlapped "Rule" rather than shortening itself.

## v1.2.3 — 2026-07-31

How hard a set was, in whichever of the two scales you already think in — and the ratings your
old app recorded come across with the rest of your history. Plus: the phone stops locking itself
mid-workout, the rest timer can hand time back as well as take it, and Settings is grouped by
what each thing actually affects.

### The screen stays on while you train

- ☀️ **Keep screen awake — Settings → *During a workout*, on by default.** Locking, unlocking
  and finding your place again between every set was the single most annoying thing about
  logging on a phone. The screen now stays lit for as long as a workout is running and lets go
  the moment you finish it, so nothing is held while you are not training.
- **It survives a tab switch.** Browsers release the lock whenever the page stops being visible,
  which is exactly what happens when you glance at a message. The lock is taken again each time
  the app comes back, rather than dying the first time you look away.
- **It follows the workout, not the screen you are on.** Checking Stats mid-session keeps the
  screen awake.
- **Where it isn't available, it says so.** iOS grants no wake lock in Low Power Mode, and older
  browsers have no Wake Lock API at all — the first is silent, the second shows the row disabled
  rather than offering a switch that does nothing. Needs HTTPS, like every other modern browser
  capability.

### Rest timer: take 15 seconds off, too

- ⏳ **A −15s button next to +15s.** The timer could only ever be extended or skipped outright;
  now it goes both ways. Taking off more than is left finishes the rest rather than counting
  into the negative — the same thing Skip does.
- **Rearranged so three controls fit.** The clock and the progress bar take the top row and the
  controls sit underneath: −15 and +15 together in number-line order, Skip pushed to the far
  edge so the button that ends the rest is not next to the one you tap to buy more time. On a
  wide screen it stays on one line. Tap targets are bigger than they were.
- **The bar is nearly opaque.** The set rows underneath were reading through it and making the
  clock hard to pick out.

### Settings, grouped by what it affects

- **General** (language, units) · **During a workout** (rest timer, keep screen awake, sounds,
  effort per set) · **Notifications** · **Appearance** (theme, body diagram, accent) · **Data**.
- The old grouping mixed axes: "Units & timer" put a display preference next to two workout
  behaviours, language sat under Appearance, and *Load starter plan* was buried between the
  backup actions and the destructive reset. Data now reads in the order you would use it — fill
  the plan, bring history over from another app, restore a backup, export one, wipe everything.
- Nothing was removed and no setting changed its meaning.

### Effort per set: RIR or RPE (#21)

- 🎯 **A third column on a working set, off by default.** Settings → *Effort per set* switches
  it between **Off**, **RIR** and **RPE**. It only appears on weighted rep sets: a plank or a
  treadmill row has nowhere to put it.
- **Two names for the same judgement.** RIR counts the reps you left in the tank; RPE reads the
  same effort off a 10-point scale, so RPE ≈ 10 − RIR. The setting has an (i) that lays the two
  scales side by side in a conversion table rather than explaining them in a paragraph.
- **Each set keeps the scale it was logged with.** Switching the setting changes what new sets
  ask for and nothing else — history is never silently rewritten, and a set logged as RIR 2
  still reads back as RIR 2 years later.
- **An unrated set stays unrated.** Blank and 0 are different things: RIR 0 says the set went to
  failure. So `−` on an untouched cell leaves it empty, `+` starts at the bottom of the scale
  and walks up in even steps, and stepping back off the bottom clears the cell again — a mistap
  is always undoable.
- **Nothing else reads the value.** Progression rules and estimated 1RM are unaffected; the
  rating is yours to look at, not an input to the maths.
- Upgrading keeps the column you had: a profile still carrying the old `showRir` flag — from
  this device, a sync, or a backup restored later — comes across as RIR.

### Import brings your ratings with it

- 📥 **The RPE Hevy and Strong export is no longer dropped.** An `RPE` column is read into the
  set, as is an `RIR` column if a file has one, and the import summary says how many sets
  arrived with a rating — plus where to switch the column on if it's off.
- A blank cell stays unrated rather than becoming 0. A written-out `0` counts as a rating on the
  RIR scale (a set to failure) but not on RPE, which starts at 1 — apps write 0 there to mean
  "nothing here", and reading it as an effort would stamp one on every unrated set in the file.
- Ratings above the scale are capped instead of thrown away, and junk in the column is ignored
  without losing the set.
- Backups already carried both fields and the setting, since a backup is the whole state — there
  are now tests pinning that, so it can't quietly stop being true.

## v1.2.2 — 2026-07-25

Training that moves on its own: an exercise can now be logged by time instead of reps, the
next weight follows a progression rule you choose rather than a single hard-coded hint, and
every lift carries an estimated 1RM. Plus a standalone mobile app, a shareable plan, and an
importer for your history from other apps.

### Timed sets and a timer for the set itself (#16)

- ⏱️ **Reps or time, per exercise.** Planks, hangs, wall sits, dead hangs and loaded
  carries no longer have to be filed under cardio to be timed. Each exercise in a routine
  picks its own mode, and a timed set can still carry weight for a weighted plank or a
  farmer's walk.
- ▶️ **A work timer, separate from the rest timer.** Start a timed set and it counts the
  hold down, beeping and buzzing at zero exactly as the rest timer does, then checks the
  set off itself. The two timers can never run at once — they mean opposite things.
- Finishing a hold early logs **the time you actually held**, not the target. A 38-second
  hold against a 45-second target is recorded as 38 seconds.
- The mode travels everywhere it should: routine editor, workout, history, exercise
  statistics (timed exercises chart their longest hold), the printable plan and the shared
  plan file.
- Plans made before this release are read exactly as they always were — nothing to migrate.

### Progression rules you can read (#17)

- 📈 **Pick a rule per routine, override it per exercise.** Linear progression, **Greyskull
  LP** (two straight sets plus an AMRAP final set, with double jumps and a 10 % reset),
  double progression through a rep range, or adding time for timed work. Or none at all.
- 🧾 **Every target explains itself.** "Every rep last time — 2.5 kg more." "Missed reps
  3 sessions running — reset to 55 kg and work back up." The rule is visible before you
  train, not after.
- The session opens with the right weights already in the rows, instead of suggesting them
  once you are standing at the bar.
- 🚫 **A bad session can't look like a good one.** Short reps count as a miss even when you
  checked the set off; a set you never checked counts as a miss because you did not do it.
  Nothing advances the load on a session that fell apart.
- Stalls and deloads are worked out from your log every time they are needed. Nothing is
  written back into a finished workout and no counters are stored, so fixing a mistyped set
  immediately produces the right next target.
- Lower-body lifts step up in larger jumps than upper-body ones by default, and any
  exercise can set its own step.
- Bodyweight exercises progress in **reps**, because there is no load to add to a push-up
  and no load to take off it either.

### Estimated 1RM (#18)

- 💪 **An estimated one-rep max for every lift**, in the exercise progress card (with its
  own curve you can switch to) and in the exercise detail sheet.
- It always names the set it came from — "from 90 kg × 5 on 15 Jul" — because an estimate
  off a heavy triple and one off a set of ten are very different claims.
- 🧮 **A calculator** for a set you have not done yet, so the number is reachable before
  there is any history.
- Epley by default, and it **refuses to guess above 12 reps**, where the common formulas
  disagree by double digits.
- A new best estimate is reported at the end of a workout separately from a weight PR —
  same weight for more reps is real progress, but it is not a heavier lift.

### Share a plan

- 📤 **Send someone your plan.** Plan → *Share your plan* writes a small file with your
  routines, the week schedule and any custom exercises they use — and nothing else. No
  workouts, no weigh-ins, no settings.
- Importing **merges**: shared routines arrive as new ones with fresh ids, custom exercises
  are matched by name so they are not duplicated, and your own plan is never overwritten.
  Taking the week schedule with it is optional.
- 🖨️ **A printable plan** (Save as PDF) laid out so a single exercise never breaks across
  a page.

### Fixes

- A shared plan file naming an exercise this build doesn't have can no longer take the app
  down. Unknown ids are dropped on import, anything that slips through renders as a
  placeholder you can delete, and an error boundary around the screens means a bad state is
  recoverable by switching tabs instead of reloading.
- Importing from another app converts weights **per row**, not per file. FitNotes writes the
  unit on each set, so a mixed export used to land 185 lb as 185 kg.
- Numbers follow the UI language instead of a hardcoded locale, which was putting Swiss
  apostrophes ("7'535 kg") in front of everyone. Volume stays in your own unit rather than
  switching to tonnes, which was wrong for pound profiles.
- Taking over a week schedule from a shared plan now really replaces Monday–Sunday instead
  of only the days the shared file happened to fill.
- The body-weight slider's ceiling follows your unit (300 kg / 660 lb).
- "Best: 85 Kg" is capitalised correctly again.

### One codebase, two flavors

openGym is also a standalone mobile app — and it ships as a direct APK download, not
through app stores.

- 📱 **Standalone mobile app.** The same frontend now also builds as a native iPhone /
  Android app (Capacitor) — the install-and-done flavor of openGym: no account, no server,
  no sync. Everything stays on the phone.
  - State is mirrored into a file in the app's private storage on every change, so your
    log survives even when the OS evicts WebView storage (iOS does).
  - The workout-day reminder becomes a **native notification** scheduled on the weekdays
    your plan actually has a routine — no push server involved.
  - Backups go out through the OS **share sheet** (Files, AirDrop, mail…).
  - Exercise images/animations load from the same CDN as the live demo.
  - `npm run build:mobile`, then open `android/` in Android Studio or `ios/` in Xcode —
    see **docs/MOBILE.md**. `NOTICE.md` now carries an AGPL §7 app-store exception.
- 🤖 **Android APK, no Play Store.** The official build is a signed, sideloadable APK
  (~4.5 MB) from [opengym.duarte-santos.ch](https://opengym.duarte-santos.ch) — deliberately
  store-free. docs/MOBILE.md covers building and signing your own.
- 🍎 **iOS reality check.** Apple permits no installs outside the App Store, so there is no
  iOS download; the docs explain the free options (self-hosted PWA on the home screen, or
  running the native app onto your own iPhone from Xcode).

- 📥 **Import your history from another app.** Settings → Data → *Import from another app*
  reads an export from **FitNotes** (both the Android and the FitNotes 2 iOS format),
  **Strong** and **Hevy**, and pulls body-weight history out of an **Apple Health** export.
  Anything else with a date, an exercise name and weight/reps columns is read too.
  - Every row becomes a set, grouped into workouts by date, so your history arrives with
    its real dates rather than as one lump. Hevy and Strong also carry session length, so
    the activity heatmap fills in properly.
  - Exercise names are matched against the 1,324-exercise library — parenthetical
    qualifiers like "(Barbell)" and shorthand like BB/DB are normalised, and a curated
    table covers the plain names people actually log ("Bench Press", "Squat", "RDL").
    Where a name is genuinely ambiguous it is *not* guessed at: it becomes one of your own
    exercises instead, because filing years of training under the wrong lift is worse than
    an unmatched name you can see and fix.
  - A summary shows what will happen — workouts, sets, how many exercises matched, which
    ones didn't, and whether weights need converting — before anything is written.
  - Importing is idempotent: days you already have data for are left alone, so running it
    twice, or importing from two apps, never duplicates a workout.

## v1.2.1 — 2026-07-23

A muscle map across the app, and a live demo you can try without installing anything.

- 💪 **Muscle map.** Three places now show which muscles your training actually reaches, drawn on a
  front-and-back body diagram shaded like the activity heatmap — more accent means more work.
  - **Stats → Muscle balance** aggregates a week, 30 days, 90 days or everything, lists your
    hardest-worked muscles with their set counts, and names the ones that got *nothing* in that
    period. That last list is the point of the card: the gaps are what you'd otherwise never notice.
    Tap any muscle to read its name and volume.
  - **Routine editor** previews what a session hits as you build it, so a hole in the plan shows up
    before you train around it for a month.
  - **The finish screen** shows what you just trained.
  - Load is counted in *effective sets* — a set counts fully for the exercise's target muscle and
    partially for its supporting ones — not in kilograms, because 100 kg of leg press and 12 kg of
    lateral raise say nothing about which muscle worked harder. Shading is relative within the
    period you're looking at, so the map always reads as a balance rather than an absolute.
  - Settings → Appearance → **Body diagram** switches between a male and female figure.
  - The exercise dataset spells muscles inconsistently ("delts", "deltoids" and "shoulders" are one
    muscle); all 50 spellings it uses are normalised onto the 18 the diagram can draw. Custom
    exercises, which only carry a body part, fall back to it. The geometry is ~90 kB and loads on
    demand, so the initial bundle is unchanged.
- 🐛 **Fixed: finishing a workout from its last exercise could blank the whole app.** The
  per-exercise weight sheet read the running workout without checking it was still there, and
  finishing clears it while that sheet is still on screen.
- ▶️ **Live demo** at [duartesantos8.github.io/openGym](https://duartesantos8.github.io/openGym/) —
  a browser-only build (`VITE_DEMO=1`) published to GitHub Pages on every push to `main`. It boots
  into guest mode with a seeded example profile (12 weeks of Push/Pull/Legs, weigh-ins, PRs) so
  every screen has something to show, and it never talks to a server. Passkeys, sync and the admin
  dashboard stay exclusive to self-hosted instances, which is where the backend lives.
- 🖼️ Builds can point the exercise media elsewhere via `VITE_IMG_BASE` / `VITE_GIF_BASE` — the demo
  serves the ~140 MB dataset from a CDN instead of shipping it. The default (`img/` and `gif/` next
  to the app) is unchanged.

## v1.2.0 — 2026-07-23

A complete visual redesign. Same app, same data — every screen redrawn.

### A designed interface, not an assembled one

- 🎨 **Rebuilt design system.** One type scale carrying hierarchy through size instead of making
  everything bold, a neutral surface ramp instead of saturated blue-greys, hairline separators
  instead of outlined boxes, and motion that acknowledges a press rather than animating for
  decoration. Light and dark are both first-class, and the eight accent colours now pick their
  label colour by measured contrast — the default green in light mode was failing WCAG AA on
  every primary button before.
- ✏️ **A hand-drawn icon set** (77 icons, single stroke weight, drawn on one 24×24 grid) replaces
  every emoji in the interface. Emoji render differently on each platform, sit on their own
  baseline and can't take a theme colour, which is what made the old UI feel stitched together.
  Icons inherit the surrounding text colour and optical size.
- 🏋️ **Routine icons.** Picking an icon for a routine now offers a grouped set — strength,
  equipment, cardio, recovery — instead of an emoji keyboard. Routines you already made keep
  their look: the old emoji are mapped forward automatically, so nothing to migrate and nothing
  to redo.
- ▶️ **New tab bar** with a raised Start button that turns into a pulsing orange Resume while a
  workout is running.
- 🏠 **Home reads as a plan for today** — week strip, today's session as one tappable row, body
  weight, and your streak.

### Charts

- 📈 **Axis labels, gridlines and the target-weight line are visible again** in dark mode. They
  were painted with colour variables that no longer existed, which silently fell back to black
  on black — and to no stroke at all for the lines.
- 💬 **The hover readout stays on screen.** It used to be positioned with a fixed offset that
  assumed one label width, so the first and last point pushed it under the chart's clip; it's now
  placed from its measured size and kept inside the frame, dropping below the point when the
  point sits high enough that the label would cover the value it reports.
- 🖱️ **It also goes away again** — moving off the chart now clears the readout, crosshair and
  marker, which previously stayed until you hovered somewhere else.

## v1.1.3 — 2026-07-22

Admin dashboard for self-hosters (opt-in — off by default), equipment filtering, and
workout-screen fixes.

### Admin dashboard

- 🛠️ **Admin dashboard** (Settings → Admin dashboard) for whoever runs the instance: a users
  overview with workout counts and last-active times, plus a per-user drill-down into their full
  workout history and body-weight log.
- 🟢 **Live "training now"** — see who's mid-workout in real time, with their current exercise and
  set progress, updated by a lightweight heartbeat while a workout is on screen.
- 🚫 **Disable / enable accounts** — a disabled account is signed out and locked out everywhere
  until you re-enable it.
- 🔑 **Invite-only signup** (optional) — require an invite code to create a profile; generate and
  revoke codes from the dashboard. Existing accounts are unaffected.
- ⚙️ Configured via environment: `ADMIN_UIDS` (comma-separated user ids who are admins) and
  `INVITE_ONLY=1`; both default off, so a fresh instance stays open with no admin. See
  `.env.example`. Admin access is gated by your passkey and enforced server-side.

### Exercises & workout

- 🏋️ **Filter exercises by equipment** (#6). A second filter row under the body parts lets you
  narrow the list to what you actually have — body weight, dumbbell, barbell, cable, band, and so
  on — in both the Exercises library and the exercise picker. The options adapt to what you've
  already selected and are ordered by how many exercises use them, so every combination on screen
  has results behind it and the row stays short. Building a bodyweight-only plan is now two taps
  per body part.
- 🔎 **Minimize the exercise animation during a workout** (#12). A ⤡ Minimize / ⤢ Expand button
  on the animation shrinks it to a thin strip so the set rows sit right under your thumb — no more
  scrolling past a big GIF to tick off a set. Your choice is remembered and applied to every
  exercise and future workout until you change it, so you set it once. Tapping the animation still
  pauses/plays it as before.
- ⏱️ **Fixed: the rest timer froze at 0:01** (#14) instead of counting down to the end. It also
  meant the timer could only be cleared with Skip, and a redundant "rest over" push notification
  could still fire.

## v1.1.2 — 2026-07-22

Custom exercises, full localization, and input fixes.

### Custom exercises (#11)

- ✨ **Create your own exercise** from the exercise picker or the Exercises tab: a name and a
  body part is all it takes. Your search text is pre-filled as the name, so "no match" flows
  straight into "create it".
- 📝 **Optional description** — setup, cues, anything you want to remember. It shows on the
  exercise's detail and config sheets (where a built-in exercise would show its animation),
  and it's searchable, so you can find your own exercises by their cues too.
- 🏋️ Custom exercises behave like built-in ones everywhere — routines, supersets, workout
  logging, weight suggestions, PRs, stats and history. The animation stays blank by design.
- 🏃 Pick the *cardio* body part and it logs time + speed instead of weight × reps, like the
  built-in cardio exercises.
- ✏️ Edit (rename, change body part or description) or delete your custom exercises — from
  their detail sheet in the Exercises tab, or straight from the exercise inside a routine via
  "Edit or delete this exercise". Deleting removes them from your routines; already-logged
  workouts keep their sets and still show the exercise name. (The routine sheet's old "Remove
  exercise" button is now labelled "Remove from routine", so the two are no longer confusable.)

### Localization (#7)

- 🌍 **12 UI languages**: English, Deutsch, Español, Français, Italiano, Português, Polski,
  Türkçe, Русский, 中文, 한국어, हिन्दी. Pick yours under Settings → Appearance → Language;
  the choice syncs with your profile like the theme does.
- 📖 **Localized exercise instructions** for 10 of those languages (all except German and
  Portuguese, which the upstream dataset doesn't cover yet — those fall back to English),
  covering all 1,324 exercises. Body-part filters, equipment and muscle tags are translated
  too; exercise *names* stay English (upstream limitation). Custom exercises are translated too.
- 📅 Dates, weekday and month labels follow the selected language.
- ⚡ Zero cost when unused: the app still ships English-only by default. Each UI language is a
  ~7 kB chunk and each instruction pack ~80–120 kB (gzipped), downloaded only when you switch —
  the initial bundle size is unchanged.
- 🛠️ New `scripts/build-instructions.mjs` regenerates the instruction packs from the upstream
  dataset; translations live in `frontend/src/locales/` (PRs welcome — it's one flat
  English-string → translation map per language).
- Known gaps: push notification texts (sent by the server) and plural forms in some languages
  are approximated; happy to take corrections from native speakers.

### Fixes

- ⌨️ Weight and other numeric fields now accept a comma as decimal separator ("33,5") — iOS
  decimal keyboards in many locales only offer a comma, which previously reset the field to 0.
  Partial input like "33," no longer snaps to 0 while typing. (#13)
- 📱 Fixed the exercise-config sheet (Sets / Reps / Weight, and the cardio variant) overflowing the
  screen edge on narrow phones — the Weight stepper was clipped and could make the whole page pan
  sideways in iOS Safari. Steppers now shrink to fit the viewport. (#10)
- 🛡️ Added a global horizontal-overflow guard so a single too-wide element can no longer knock the
  page layout off-scale.

## v1.1.1 — 2026-07-21

Reliability fixes for the push notifications shipped in v1.1.0, found through live testing:

- 🌍 Workout day reminder now fires by each user's own browser-detected timezone instead of a
  single server-wide one — works correctly regardless of where the server runs, and follows you
  automatically if you travel.
- 💾 Settings changes (like the reminder time) are flushed to the server immediately when the tab
  backgrounds or closes, instead of relying solely on a 1.5s debounce that could get cut short.
- ⏱️ Reminder check tightened from a 60s to a 10s interval, and pushes are now marked
  `urgency: 'high'` — cuts avoidable delay on top of it, though delivery time is ultimately up to
  Apple/Google's push relay.
- 🪵 Push send failures are now logged instead of silently swallowed.

## v1.1.0 — 2026-07-21

- 🐳 Prebuilt Docker images published to `ghcr.io/duartesantos8/opengym-{api,web}` (amd64 + arm64)
  via GitHub Actions, so self-hosting no longer requires building from source. `docker compose pull`
  grabs them; `docker compose up -d --build` still builds locally if you'd rather.
- 🔔 Push notifications: rest-timer-over alert (fires even if the app is closed) and an optional
  daily reminder on days you have a workout planned but haven't logged one yet. Opt in per-profile
  in Settings — requires a signed-in passkey profile. Backend gains one dependency (`web-push`);
  VAPID keys are generated on first run.
- 🐛 Fixed the rest timer stalling when the tab/app is backgrounded — it's now anchored to a real
  timestamp instead of a plain per-second counter, so it stays accurate after you come back.

## v1.0.0 — 2026-07-20

First public release. A complete, self-hostable gym & body-weight tracker.

**Highlights**
- ⚖️ Body-weight tracking with an interactive chart + goal line
- 🏋️ Weekly routine planner over 1,324 exercises with animated demos
- ▶️ Guided workouts: body-weight check-in, pre-filled weights, rest timer, PR detection, per-exercise weight tracking
- 🔗 Supersets and 🏃 cardio (time + speed) logging
- 🗓️ Per-day rescheduling without touching your weekly plan
- 🟩 GitHub-style activity heatmap (by time trained)
- 🔑 Passkey (WebAuthn) login with per-profile data that syncs across devices
- 🎨 Light/dark themes + 8 accent colors, synced to your profile
- 📦 JSON export/import, guest mode, PWA install, no telemetry

**Stack**
- React 19 + Vite (React Router, Zustand)
- Node backend, no framework, single dependency (`@simplewebauthn/server`), JSON-file storage
- nginx + multi-stage Docker so `docker compose up` builds and serves everything

**Notes**
- Exercise media (~140 MB) is fetched from [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset) on first run.
- Licensed under GNU AGPL v3.0.
