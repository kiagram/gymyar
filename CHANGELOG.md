# Changelog

Two projects live in this file. GymYar's own releases come first; under
[openGym, before the fork](#opengym-before-the-fork) is the history of the project this one
was forked from, kept as it was written.

**About the version number.** GymYar starts again at 1.0.0. openGym had reached v1.2.4 by
the time of the fork, so the first version below is a lower number than the ones further
down the page — those are a different product's version line, not a release this one
regressed from. The reset is also load-bearing: Android's `versionCode` must strictly
increase or the OS refuses an update, and the fork inherited openGym's `versionCode 5`.
1.0.0 stamps as build 10000 and clears it.

---

## v1.0.0 — unreleased

GymYar is openGym with a second person in it. Everything openGym did for one person
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
  `proposals` and becomes real only when the client accepts it — at which point it
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
- 📱 **Signing up with an Iranian mobile number.** A code by SMS and no password, which is the
  identifier this product's market actually uses — an email address there is largely a thing
  you keep for signing up to foreign services, and a domestic gateway is the one delivery
  channel that does not have to cross a border to arrive. One flow rather than two: the account
  is created on the spot if the number is new, because holding the SIM is the whole credential
  either way. Kavenegar and SMS.ir, off unless a gateway is configured.
- 🐳 `docker compose up` really is the only command: the API container migrates and seeds on
  boot, and both are idempotent. `SEED_DEMO` creates a coach and three clients with twelve
  weeks of training each — including one who shares only programmes and one who stopped
  turning up, because a roster where everybody is at 100% demonstrates nothing.

### Two things that were quietly not true

- 🗑️ **Every `DELETE` the client made answered 400.** `api()` set
  `Content-Type: application/json` on every request including the ones with no body, and
  Fastify refuses that pairing before a route is reached — `FST_ERR_CTP_EMPTY_JSON_BODY`. So
  removing an attachment, an invite, a check-in schedule or a check-in template failed with a
  message about content types. Nothing caught it because the test client sends no header when
  it sends no payload, which is what the browser now does too.
- 🪞 **`matchExercise` was `undefined` from the package root.** Two functions had the name —
  `import-csv.js`'s, which matches a name out of somebody else's export and refuses unless it is
  certain, and `parse-log.js`'s, which takes a phrase somebody just typed and picks the shortest
  name containing every word. Opposite rules for opposite jobs, and a star export with two of the
  same name resolves to neither. Nothing broke, because the only caller imported straight from
  the file — and the build had been saying so in a `NAMESPACE_CONFLICT` line nobody reads. The
  importer's is `matchImportedName` now, and a test reaches for the other one through the package
  root so it cannot go quiet again.
- 🧪 **`npx vitest run` from the repo root was lying twice over.** It walked `.claude/worktrees`,
  where the agent tooling keeps scratch checkouts of this same repo — four full copies with their
  own tests, so the run took three times as long, reported counts nobody could reconcile with the
  source, and failed on abandoned work never meant to be green. Excluding those exposed the second
  half: `packages/db` and `apps/api` disable `fileParallelism` in their own configs because they
  share one Postgres, and a flat root run does not pick those up — three hundred failures that
  looked like broken code and were a missing flag. They are projects now, so one command behaves
  like eight. Each workspace gained a config of its own to anchor `root` at itself, because
  vitest searches upward and any root config would otherwise have turned every per-workspace
  script into a whole-repo run.

### The notifications nobody caused

The other half of push. Everything before this announced something a person had just done and
rode on that request; these fire because *nothing* happened — a check-in is due, a week has gone
quiet — which is exactly why somebody needs telling.

- ⏰ **The hour is the recipient's, not the server's.** A reminder at six in the evening is
  useful and the same reminder at three in the morning is an uninstall, so each candidate carries
  the timezone their app reported and the pass asks what hour it is *there*. An unknown timezone
  falls back to the instance's own, which for a product whose users are nearly all in one country
  is a good guess and is still a guess.
- 🗓️ **A reminder is about the row they would open** — the check-in filed under *their* week,
  which under fa-IR starts on Saturday. Verified against a real clock: the fire keys came out as
  the two Persian Saturdays, not the two Mondays.
- 🔑 **Sending twice is the failure mode, so the claim is a primary key.** Not a check before
  sending — that is a read-then-write two containers can both pass in the same millisecond.
  Migration 009's `notifications_sent` is claimed with `on conflict do nothing returning`, and a
  row coming back *is* the right to send. Four concurrent passes were raced against each other:
  one push, one row. Same reasoning as the unique index on `payments.ref_id`.
- ↩️ **A send that throws gives the claim back**, so one bad fifteen minutes costs a retry rather
  than a permanent silence.
- 🤐 **Nothing to say is not a notification.** A digest that reads "0 and 0" is why people turn
  digests off, so it is not sent at all.
- 🧾 **The preference is checked before the claim, not after.** `notify` checks it too and would
  have refused to send — but by then the claim is spent, so the row is written, the log says one
  went out and nothing did. Found by a test that expected zero and got one.
- ⏱️ **Its own timer, beside the sweeper's rather than inside it.** Deleting files and messaging
  people fail differently and belong in different log lines — and reminders are meaningless on
  the single-user self-hosted instance the sweeper still has to run on.

### Told, rather than found out later

Until now the only push this app sent was a rest timer, which the client schedules for itself. A
coach could send a message at midnight and their client would learn about it whenever they next
happened to open the app.

- 🌍 **The server writes the notification in the reader's language**, from a small pack beside
  the code that sends it — the same shape and the same reason as the planner's rationale
  strings. The rest timer dodges this by having the client send the text it wants shown; nothing
  server-initiated can, because there is nobody awake to ask.
- 🚫 **Language is a parameter, never module state.** This process serves a Persian lifter and an
  English one in the same second, and the domain's registered global `t` would hand one of them
  the other's language.
- 🔕 **The switch lives in the settings the client already syncs**, so the row somebody flips and
  the row the API reads before sending are the same row, with no second store to keep in step.
  Absent means yes — somebody who has never opened the screen has not opted out of anything —
  and switching one kind off leaves the others alone.
- 🛟 **A notification can never break what it is announcing.** Every one of them describes a row
  that has already been written, so the whole path swallows its own failures and returns how
  many devices it reached. That is also what makes it survivable that web push may not reach a
  device in Iran at all: nothing is ever *only* a notification.
- ↔️ **`otherSide` is a function rather than a ternary in a route**, because "the person who did
  not send it" is the one property here worth testing and, backwards, it pushes every coach
  their own messages.
- 🖼️ **Three icons were named and never drawn** — `chat`, and `archive` twice, which I had added
  myself earlier in this work. `Icon` renders null for a name it does not know, so each was a
  coloured square with nothing in it. There is now a check that every referenced icon exists.

### The coach's side of both

- ✍️ **A check-in is written once and put on whoever it suits.** Templates live on their own
  screen off the roster rather than under a client, because that is what they are: questions a
  coach writes, not a property of one relationship. Field keys are derived from the labels at
  save time — a Persian label leaves nothing behind an ASCII filter, so those get a positional
  key and the label is kept exactly as written.
- 📅 **Putting one on a client is two rows**: which questions, and which day. Both are on the
  client's own screen, next to the answers that come back, because "am I asking them anything"
  and "did they answer" are one question and splitting them across two taps is how the second
  half stops being read.
- ▪️ **Habits show as fourteen squares, not a percentage.** The grid says which days somebody
  missed; a number says only that they missed some.
- 🤲 **A coach suggests a habit and cannot write one.** The sheet says so, and the section still
  shows nothing until the client accepts — which is the proposal rule doing its job visibly.
- 🗓️ **The roster's week is the coach's own week.** `habitWeek` used Postgres's `date_trunc`,
  which starts on Monday for everybody — so a Persian coach's "this week" was two days out of
  step with the grid their client was ticking, and the disagreement would have read as a bug in
  the ticking rather than in the reporting. The weekday now comes from `users.locale` through
  `weekStartsFor`, which lives in the domain **once** and is read by both the client's i18n and
  the API. Two copies of that map would have disagreed the day somebody added a locale to one.
- 🔔 **"check-in due" appears on the roster only for clients who are being asked one.** A client
  with no check-in on them is not overdue for one, and neither is a client who did not share
  them — those are both null, and neither is a thing to chase somebody about.

### The two screens somebody actually touches

- ✅ **Habits are on the home screen, one tap deep.** A list that needs a screen of its own before
  anything can be ticked stops being ticked around day four, so the thing done every day is on
  the card and everything else — renaming, retiring, the history — is behind the row itself.
- 🔥 **What a habit says about itself depends on the habit.** A run of days leads when there is
  one, because it is the most motivating true thing available — but only for a daily habit,
  since a run means nothing against a target of three. A streak of weeks is the equivalent for
  the rest. With neither, the week's count; and nothing at all beats a decorated zero.
- 📝 **The check-in form is built from whatever questions apply**, and falls back to the built-in
  set when the server cannot be reached rather than showing an error — they are the same
  questions somebody with no coach answers, and a form that will not open on a bad connection is
  worse than one that asks slightly less.
- 🗓️ **An answer is filed under the week it is about**, so Sunday's edit lands on Saturday's row
  and one week never gets two. Sending is one button; a draft is the other, and reopening a week
  already sent edits it without withdrawing it.
- 📸 **A photo question draws no input.** It says where to add the picture instead, because the
  photo belongs behind the `photos` scope and a control here would file it somewhere nobody
  asked permission for.
- 🈳 **The built-in check-in has no title, on purpose.** A coach's template title is *their words*
  and is rendered exactly as written; the built-in one is a label the app names, so it comes out
  in the reader's language. It was a literal until the form was opened in Persian and had one
  English heading on it.

### Check-ins and habits, over HTTP

- 🧩 **A client answers through sync, not through an endpoint.** A filled-in check-in and a
  ticked habit are rows in `push` with everything else they own, which is what lets both be done
  on a phone with no signal. The one thing the server has to tell them is which questions they
  are being asked this week — `GET /api/checkin` — and it always answers with something, because
  somebody with no coach gets the built-in set.
- 👩‍🏫 **The coach side is templates, a schedule, and reading.** Saving a template and scheduling
  one are gated on `propose`, because editing a template already on a client changes what they
  are asked next week. Taking one *off* is not gated: a lapsed coach removing their questions
  harms nobody, and a paywall that traps somebody's form on a stranger's screen would be worse
  than no paywall.
- 📋 **Answers travel with the questions they answered.** Values under keys nobody can read are
  not a check-in, and the template may since have been reworded or archived.
- 🤝 **`POST …/propose` takes a `kind`.** `routineId` and a named payload still work exactly as
  before — every caller sends that, including the AI draft — and a habit names `kind` and
  `subjectId` instead.
- 🛡️ **Answers are shaped on the way in, not only in the form.** Found by driving a real server:
  the push path was storing whatever arrived, so a hand-made request could file a waist of
  4,000 cm and a sleep score of 11 out of 5. The domain had the rule and the phone was running
  it; the server was not. It runs on both ends now, which is the reason the validation lives in
  the domain in the first place.

### The days between sessions

Migration 008, and the first thing to use 006's seam for what it was built for. A programme says
what to do three times a week; most of whether it works happens on the other four days, and none
of it is a set.

- ✅ **A tick is a row, and its absence is the answer.** No `done` column — a boolean would have
  created a third state, a row saying false, meaning exactly what no row means. Unticking is a
  tombstone, because sync has to tell "they changed their mind" apart from "this device has not
  heard yet".
- 🔢 **No count column either.** "Eight glasses of water" is a number and numbers belong in a
  check-in's `measure` field, where they already have bounds and a unit. A habit is a yes.
- 🎯 **A target of one to seven days a week**, so a habit can have rest built into it. A streak
  counts weeks that met the target rather than days in a row, and the current week is allowed to
  be unfinished — a counter that reads zero until Friday is one that punishes people for looking
  at it. A run of days is reported only for a daily habit, and is null otherwise rather than a
  number that looks like a verdict.
- 📊 **Adherence is measured in days asked for, not habits completed.** Two of three habits fully
  done reads as 67%, which flatters somebody who skipped one entirely; six of nine days says what
  happened. An over-done habit cannot cover for another one, and a client with no habits is null
  rather than zero — the same rule the roster already follows for a client with no schedule.
- 🤝 **A coach proposes, the client accepts** — and everything above the dispatch was already
  written. `PROPOSAL_KINDS` gained a line, `APPLY` gained a function, and who may propose, what
  supersedes what and who may accept were untouched. The payload is re-validated on acceptance,
  because a target a coach wrote in March would otherwise fail at a check constraint under the
  client's accept button.
- 🔓 **`habits` is its own scope**, next to `checkins` and in the default invitation with it. Two
  scopes rather than one because they are two different pictures: a summary somebody composed,
  and a day-by-day record of what they did with their evenings.
- 🔒 **A tick can only be filed under a habit the pusher owns.** The foreign key alone would let
  somebody write a row in their own name pointing at a stranger's habit, so the insert selects
  from `habits` rather than taking the id on trust.

### The week, answered

Migration 007. Coaching until now was a coach reading numbers a client's app recorded on its
own — sets, loads, what they weigh — none of which says whether the week was any good. A stalled
lift and a stalled lift after four nights of no sleep are the same rows and opposite problems.

- ❓ **A coach owns the questions, a client owns every answer.** The template is the coach's row
  and they edit it freely. The answer is written through the client's own sync like any other
  row they hold, which is what makes it fillable on a phone with no signal and what stops a
  coach from ever authoring one. Same rule as a proposed programme, same reason.
- 📅 **One check-in per person per day**, keyed `(user_id, on_date)` exactly as a weigh-in is.
  Not per relationship: a client with two coaches describes their week once, and both read it if
  both were granted the scope. It is also the only key that survives two offline devices
  answering the same Saturday — a per-device id would push two rows and fail the transaction.
- 🔓 **`checkins` is a scope, and it is in the default invitation** — unlike `photos`, which is
  not and will not be. Answering questions you have read, in words you chose, *is* the consent;
  being photographed is not. So a check-in can ask for a picture, and the picture still arrives
  as an attachment behind the scope that asks properly. There is no photo column here.
- 👤 **A client with no coach can keep check-ins for themselves.** `template_id` null means the
  built-in set of questions, which lives in the domain — a table holding one identical row per
  user is a table holding a constant.
- 🪦 **A coach deleting their account cannot take their clients' answers with them.**
  `template_id` is `set null` rather than `cascade`; what is lost is the wording of the
  questions, not what anybody said. Templates are archived rather than deleted for the same
  reason: an answer is only readable next to the question it answered.
- 🙈 **A draft is never readable by a coach.** A check-in with no `submitted_at` is somebody
  halfway through a sentence about their week. It syncs so it survives a closed app, not so it
  can be read over their shoulder.
- 📆 **A due date belongs to the week it is about**, not the day the form was typed — otherwise
  a late reply lands in the next week and leaves a hole in the one it describes. Which weekday a
  week starts on stays a locale question and is not stored.

### A proposal is not always a routine

Migration 006, ahead of the three features that all need the same thing. A macro target a coach
sets and a habit a coach assigns are both a coach deciding something about a client, and both
are worthless if the coach can simply write it — which is the rule `proposals` already holds for
programmes.

- 🔤 **`routine_revisions` is `proposals`, and `routine_id` is `subject_id`.** A table named for
  routines holding a macro target is a schema that lies, and the next person to read it believes
  it. Renamed rather than left to drift; only `coaching.js` writes this table and one client
  screen reads the column.
- 🏷️ **`kind` names what is being proposed**, and the database's list of kinds is deliberately
  wider than what this build can create. The schema knowing the word first is what makes adding
  nutrition targets or habits a code change rather than another migration.
- 🚫 **Accepting a kind this build cannot apply is refused**, rather than applied as whatever the
  code happens to know how to write. The ordinary version of that is an API container still on
  last week's build while the schema has moved on; the bad version is a macro target appearing in
  somebody's programme list. Declining always works, so an inbox can never be stuck.
- 🔑 **One open proposal per subject is now keyed by the client too.** It was keyed on the routine
  id alone, which held only because ids are generated client-side from a timestamp and five
  random characters — unique across accounts by luck, not by construction. A kind whose subject
  is the same word for everybody, which is exactly what nutrition targets will be, would have
  turned that luck into one client blocking the whole instance.

### Programmes, review, and logging by typing

The division of labour matters more than the feature list: **the domain owns every number, a
language model owns language.**

- 🧮 **Sets, reps, loads, progression policies and exercise selection are computed** by
  `packages/domain/src/planner.js`, against the real library and the same progression rules
  the app already runs on. A model is asked to do exactly two things — turn free text into a
  structured brief, and write the note explaining a change — and both have deterministic
  implementations underneath.
- **With no API key configured, GymYar builds the same plans, finds the same stalls and
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

### A way back into an account

Email and password sign-in shipped without a reset, which made "I forgot my password" the end of
an account rather than an inconvenience. Passkeys have no equivalent problem — the authenticator
holds the secret and its recovery is the platform's job — but the whole reason for adding
passwords was that passkey-only is a dead end for a mainstream signup, and a password with no
reset is a different dead end at the same door.

- 📧 **One email, and there will not be a second.** A reset link, plain text, no HTML. Web Push
  already handles everything that needs to reach somebody, so there is no digest, no newsletter
  and nothing planned. `packages/mail` is the whole surface. (There is a second now — a
  confirmation code — and still no HTML and no third.)
- 🌍 **In the reader's language, all thirteen of them.** Which is only possible because
  `users.locale` is real now — it shipped as a column nothing ever wrote, and this would have
  been English for everybody. A test asserts there is a template for every language the picker
  offers, since a missing one is not a crash, it is an English email nobody notices.
- 🚫 **An instance that cannot send email does not offer the feature.** No transport configured
  means `passwordReset: false`, no link on the sign-in screen, and a 501 from the endpoint. Not
  a degraded mode — an honest one: an instance with no relay genuinely cannot reset a password,
  and a form that says "check your inbox" to somebody who will never receive anything is worse
  than no form. The same shape as billing.
- 🏠 **`MAIL_TRANSPORT=log`** writes the message to the server log instead of sending it, for
  the household instance where one person is both the only account and the only reader of the
  logs. Documented as exactly that, including the sentence about what it means anywhere else.

### What the reset does not tell you

- 🕵️ **The same answer for an address with an account and one without**, byte for byte. An
  endpoint that says "no such user" is one that turns a leaked address list into a membership
  roster — and for a coaching app, that roster is who trains with whom. A passkey-only account
  and a disabled one answer identically too. The cost is that somebody who mistypes their
  address gets no email and no explanation, which is the right side of that trade.
- 🤫 **A relay that is refusing connections does not change the answer either.** The failure is
  logged for the operator, who can act on it, and swallowed in the response — because a 500 for
  real addresses and a 200 for the rest is the enumeration oracle this endpoint was written not
  to be.
- 🔑 **The token is never stored.** What is kept is `sha256(token)`; the token itself exists in
  the URL and in the request that comes back with it, and nowhere else. A dump of the table, a
  replica, a backup on a laptop — none contains anything that opens an account. SHA-256 rather
  than the scrypt used for passwords is deliberate: the input is 256 bits of `randomBytes`, so
  there is nothing to guess and a slow hash would only slow the endpoint down.
- 1️⃣ **One use, one hour, and asking again retires the last link.** Spending it is a single
  UPDATE with every condition in the WHERE clause, so a mail client that prefetches the URL and
  a double tap race the database rather than each other — exactly one wins.
- 🚪 **A reset signs the account out everywhere else.** The reason somebody resets a password is
  often that another person has the old one, and a reset that leaves that person's cookie
  working has fixed nothing. It does not sign out the device doing the resetting, which is the
  one bug this had: `consume` returned the account row as it was read, one version behind the
  bump it had just made, so the cookie issued from it was dead on arrival. Caught by the test
  that signs in immediately afterwards.

### A third door, and the one this market walks through

The two ways in above both assume something a lot of the people this is built for do not have.
A passkey needs a device and a browser that will do WebAuthn. An email address in Iran is
largely a thing you keep in order to sign up to foreign services, most of which will not take
an Iranian card or address anyway — and the reset email above has to cross a border to arrive,
from a relay whose reputation is not ours, into filters that distrust the whole origin. What a
coach and their clients all have is a mobile number.

- 📱 **A number, a code, and no password.** `packages/sms` is the whole surface, deliberately
  shaped as a sibling of `packages/mail` rather than a variation on it: Kavenegar or SMS.ir, or
  `log` for the household instance, or nothing — in which case `phoneAuth: false`, no button on
  the sign-in screen, and a 501 from the endpoints. An instance that cannot text anybody does
  not offer to.
- 🧩 **The pattern, not the prose.** Both gateways deliver one-time codes through a body
  registered with them and approved by the operator, and that is not a formality: an
  unregistered bulk message to an Iranian handset is filtered, deprioritised or dropped, and a
  code that arrives eleven minutes later is a signup that does not work. So GymYar sends the
  code and the pattern's name; the text it composes itself is for the log transport and for an
  instance still waiting on approval.
- 🔢 **`۰۹۱۲۳۴۵۶۷۸۹` is a phone number.** It is what an Iranian phone's own keyboard produces
  with no effort from its owner, it is visually identical to the Latin form in most fonts, and
  `parseInt` gives up on it silently. `normalizePhone` in the domain reads it, along with
  Arabic-Indic digits, `+98`, `0098`, a bare `9…`, and the invisible marks a Persian keyboard
  leaves between them — and the same function runs on the client and the server, because the
  number stored and the number looked up drifting apart makes an account unreachable by the
  phone that created it. Codes typed on that keyboard are read the same way.
- 🚪 **One flow, not two.** There is no "sign up with a phone" separate from "sign in with a
  phone": the account is created on the spot if the number is new, because holding the SIM is
  the whole credential either way, and it is how every Iranian app already on these phones
  behaves.

- 🔗 **And a number can be added to an account that already exists.** A row in Settings, the
  same two steps, and the same component behind them. Removing it is refused when it is the
  only way in — an account created by phone has no password and no passkey, so that is not
  unlinking a contact detail, it is deleting the credential. A number already on another
  account is reported as such only after a correct code; the unique index is what refuses it,
  because a lookup before the write is a race this is the wrong place to lose.

### What the code flow does not tell you, and what it will not spend

- 🕵️ **`/api/phone/start` answers a registered number exactly as it answers an unknown one.**
  The convenient version reports `registered: true|false` so the next screen knows whether to
  ask for a name; it is also a way to ask this instance which of a list of phone numbers train
  here, which is the roster the reset endpoint already refuses to be for email. So the question
  is deferred to `verify`, and answered only to somebody who has just proved they hold the SIM.
- 🔐 **The code is stored as `HMAC(key, phone + code)`, never in the clear** — and the keyed
  hash is the point of difference from the reset token next door. A reset token is 256 bits of
  randomness, so a plain SHA-256 gives away nothing; six digits is a million-entry rainbow
  table and a few seconds, with the phone number sitting in the same row as a useless salt.
  What makes a stolen table worthless is a secret the table does not contain, derived here from
  `SESSION_SECRET`.
- 🎯 **Three ceilings, because they stop three different things.** Five wrong guesses kill a
  code, so the number of tries it ever faces is a constant rather than whatever the limiter
  lets through. One message a minute and five a day *per number* — not per caller, because the
  handset being buzzed may belong to somebody who did not ask for any of this, and the bill is
  the operator's either way. The rate limiter in front is a third thing, keyed on the
  canonicalised number so that three spellings of it are one budget.
- ↩️ **A code is spent only if what it was for worked.** The claim runs the whole signup inside
  its own transaction — the name check, the invite code, the INSERT — and a throw from any of
  them rolls back the spending too. Without that, leaving the name field blank costs a person
  another text message and another minute of waiting for it, and a mistyped invite code costs
  the same. It also makes the account and the code one atomic act, so a double tap is one
  account rather than two on the same number.

### The column that had never been written

`users.email_verified_at` shipped in the first migration and nothing ever set it — the same
latent state `users.locale` was in until two features turned out to need it. So every address
in every GymYar database was unproven, and the signup form had always accepted anybody's: it
checked that an address was well-formed and unclaimed, never that the person typing it could
read it.

- 📬 **A six-digit code, mailed.** The same code, ceilings and atomic claim the phone flow uses
  — one implementation with a `channel` column rather than two that drift, because the
  invariants here are the kind whose drift hands somebody an account. `phone_codes` became
  `verification_codes` to say so.
- 🚪 **Nothing waits on it.** Signing up by email works exactly as it did; the account is
  created, the session issued, and the code goes out behind it. A signup that dead-ends on
  somebody else's mail queue is a lost user, which is worse than an unproven address — and the
  account is no more dangerous today than it was last week.
- 🔒 **Except password reset**, which now needs a confirmed address. That is the one endpoint
  that mails a way *into* an account, and the one place where unproven is actively harmful
  rather than merely unproven.
- 🕰️ **Existing addresses were grandfathered**, and that is a claim migration 011 cannot
  actually support. Applying the rule retroactively would take the only way back in away from
  everybody already using an instance, to defend against an exposure that has already happened
  — whoever signed up with somebody else's address holds that account today, and refusing them
  a reset does not take it back. The timestamp is `created_at` rather than `now()`, so the row
  says when the address arrived instead of pretending somebody proved something during a
  deploy.

### Both ways in, from one screen

- ✉️ **An address can be added to an account that already exists**, which is the half of the
  phone work that was missing: somebody who signed up with a number had a single credential and
  no way to add another. The row sits next to the phone one and behaves the same way.
- 🔑 **And a password with it, always, when the account has none.** An address on its own signs
  nobody in — the server refuses with `password_required` after a correct code, which is the
  same trick the signup sheet uses to ask a new number for a name, and it costs nothing because
  the claim rolls back and the code stays live.
- ⛔ **Neither can be the last one removed.** Taking an address away takes its password with it,
  since a `password_hash` with no `email` beside it is a credential nothing can present — which
  is also what keeps the mirror-image guard on the phone row honest.
- 🧩 **One component for all three flows.** The sign-in sheet, the phone row and the email row
  differ in their first step and in nothing else, so the countdown, the guesses-remaining line
  and the Latin-digit handling live in one place instead of three.

### Video of the lift, and the first bytes that are not a row

A coach who can read the numbers still cannot see the rep. Everything GymYar held until now
was a row in Postgres — which is why the self-hosting guide could say "the database is the
backup" and mean it — and a form check cannot be one. So there is a volume now, and
`attachments` is the index into it.

- 🎥 **Film a set and file it under the lift.** A form check hangs off a session and an
  exercise, and a coach with the `workouts` scope sees it beside the sets it belongs to — in
  the same sheet they were already using to comment on that session, because "watch this" and
  "say something about it" are one action.
- 📸 **Progress photos, on their own scope.** Not a corner of `bodyweight`: sharing what you
  weigh says nothing whatsoever about sharing a photograph of your body, and a consent screen
  that folds those together has not obtained consent for the second. `photos` is granted
  separately, is not in the default invitation, and a coach without it is told it was not
  shared rather than shown an empty panel.
- 🎙️ **Files on a message**, either way round — a coach sending back a demonstration, a client
  sending a voice note. Attaching is gated exactly where writing a message is gated and on the
  same side, so a lapsed coach cannot author one and **a client is never blocked**.
- 🙅 **A coach never uploads into a client's account**, and cannot delete what a client filmed.
  It is the same rule that puts a proposed programme in `proposals`: there is one writer
  per row and it is the person the row is about. A coach who could delete a form check could
  delete the evidence of what they told somebody to do.

### The three decisions underneath that

- 🧾 **The row is written before the bytes, always.** An upload is two writes to two systems that
  cannot share a transaction, so one goes first and that choice decides which failure is
  survivable. Bytes first leaves, after a crash, an object nothing knows about — and nothing
  *could*: `packages/storage` has no `list` method on purpose, because a caller listing storage
  is a caller asking the volume what the database already knows. So a row is reserved with
  `uploaded_at` null, the bytes follow, the row is finished. Every object has a row naming it
  before it exists, which makes the sweeper's job finite instead of impossible.
- 🔍 **The type is read from the bytes, and the header is ignored.** A `Content-Type` on an
  upload is a claim by the uploader, and the whole consequence of believing it is downstream:
  the extension it is stored under, the type served back, and therefore what the browser
  *does* with it. These files come back from the app's own origin, so "the uploader picks the
  content type" is the same sentence as "the uploader picks whether their file runs as a
  script". A short magic-number check refuses everything that is not a format a real camera or
  recorder emits, `nosniff` goes on every response, and an HTML document uploaded as
  `video/mp4` is a 415 with nothing written.
- 🔗 **Two doors, and only one of them knows who you are.** `/api/attachments` asks who you are
  and whether this is yours. `/media/*` has no session at all — it takes an HMAC signature that
  expires in minutes, minted by whichever route just checked the permission. That is what lets
  nginx serve a 60 MB video with `X-Accel-Redirect` while Node touches none of it, ranges
  included, and it is why a leaked media URL is worth so little: it names one object and stops
  working shortly. The signing key is `HMAC(SESSION_SECRET, label)` — a sibling, never the
  secret itself — so rotating the session secret invalidates outstanding links and a leaked
  media link is never a forged session.

### Deleting means deleting

- 🧹 **A sweeper inside the API container**, every fifteen minutes, no cron to set up — a
  self-hosted instance is `docker compose up` and nothing else, and a sweeper that needs a
  second moving part is one that is not running on most instances that exist. Deleting sets a
  flag, so the file leaves every screen at the speed of one `UPDATE` rather than at the speed of
  whatever the volume is doing; the row and then the bytes go on the next pass. It also collects
  uploads that died halfway. A volume that is full, read-only or briefly missing is a delay and
  never a leak: the key stays on the list until the bytes are actually gone. Running it twice is
  the same as running it once, which is what makes it safe with two containers and no leader
  election.
- ⚰️ **A key outlives its row**, which is what makes deleting an account mean something. The
  row is the only index into the volume — storage has no `list`, on purpose — so a row removed
  by anything other than the sweeper takes the only record of its bytes with it. And rows are
  removed by other things: `owner_id` and `message_id` both cascade, so deleting a user erases
  every attachment row they had without this code being involved, leaving every file they ever
  uploaded on disk with nothing left that knows it exists. "We deleted your account and kept
  your photographs" is not a sentence to ship. So an `after delete` trigger writes the key to
  `orphaned_media`, and the sweeper works from that table rather than from a guess. It is also
  what makes the row safe to remove before the bytes rather than after — found by deleting a
  user on a running instance and counting the files left behind.
- 🗑️ **A quota, because an upload endpoint with no ceiling is a bill somebody else writes.**
  2 GB per account by default, checked before an upload starts rather than after the bytes have
  arrived. Zero is unlimited and is the right answer for a household instance.
- 🖼️ **An attachment whose bytes are missing renders as unavailable** and leaves the screen
  around it alone. That is not defensive coding for an impossible state: restoring a database
  next to an older media archive produces exactly it, and section 7 of the self-hosting guide
  promises this is what it looks like.
- 📉 **Attachments do not sync.** They are not in `SYNC_TABLES` and never reach `log_change()`.
  Sync exists to keep an offline copy of training on a phone; a synced attachment row would
  promise a video that cannot play with no signal. Screens fetch them when they open, which is
  the rule coaching data already followed.

### Also

- 🔗 **The "self-host GymYar" links point somewhere.** One constant gated all three — the line
  on the demo's sign-in screen, and the Settings row in the demo and mobile builds, each written
  as `{REPO && …}` so an unset value hides the link rather than shipping a dead one. That was
  the right default while there was nothing to point at and it stopped being true the day the
  repository went public; the constant had simply never been filled in. They point at
  <https://github.com/kiagram/gymyar>, which is the repository renamed to the product — it was
  `gymbuddy`, the name the fork was started under, and the site, `SECURITY.md` and
  `CONTRIBUTING.md` had all been written against the name it should have had. Verified live
  rather than assumed: the root, `/issues` and both of the site's `/blob/HEAD/` links answer 200.
- 🌳 **Two documents were describing a branch that does not exist.** `CONTRIBUTING.md` asked for
  pull requests against `gymyar` and `docs/PUBLISHING.md` said that was the default branch and
  put it in two `git push` examples. The branch was `gymbuddy`. Anyone following the publishing
  guide would have watched the push fail; anyone opening a pull request would have aimed it at
  nothing. It was reconciled the wrong way round at first — the documents were corrected down
  to the branch, on the argument that the repository name is what every source link resolves
  through while a branch name is in no URL at all, so the split cost nothing. It cost one
  thing: a second name for the same product, in the two files whose whole job is explaining
  that product to somebody who has not seen it. The branch is `gymyar` now, renamed through
  GitHub rather than pushed and deleted, so the old name still resolves and a clone taken
  before it keeps fetching.
- 🌐 **The four sharing descriptions are translated now.** Three of them never were: they reach
  `t()` as `t(SCOPE_INFO[key].detail)`, a dynamic argument `check-locales.mjs` cannot see, so
  every language read the English. They are the sentences somebody reads while deciding what to
  share, which makes them close to the worst 204th string to have missed.
- 🔁 **The smoke test can be run twice.** Its row ids were fixed strings, and a client-minted
  id is final — so `smoke-r1` written by one run is a row the next run's account cannot write,
  and the second run against any given database failed on the collision. Nobody noticed because
  CI stands up an empty Postgres every time; anyone smoke-testing their own deployment would
  have hit it immediately. Ids carry the run's stamp now, and the media path is checked there
  too — which is the only place `X-Accel-Redirect` is exercised at all, since every unit test
  runs with Node serving the bytes itself.
- ✅ **`@gymyar/storage`'s suite runs in CI**, which it did not — it was in the root `npm test`
  and missing from the workflow, so a break in it would have been found by whoever ran the whole
  suite locally next.

### Persian, and a week that starts where your locale starts it

Farsi is the twelfth locale and the first that is not written left to right. Adding it turned
up three things that were never about translation — and making it the *primary* audience turned
up four more, all of them the same mistake in different places: a date rendered by `Intl` is
Jalali, and a date taken apart with `getMonth()` is not.

- 📆 **A calendar that is actually the reader's calendar.** `domain/calendar.js` reads a stored
  Gregorian day in whichever calendar the locale resolves to, and every screen that lays out
  months goes through it: the calendar sheet is Shahrivar with 31 cells rather than August with
  31 cells, the heatmap's month bands fall where Persian months fall, a chart's gridlines land
  on the 1st of Mehr, and "this month" turns over on the day it should. Storage is untouched and
  must stay that way — a Jalali string in a `date` column cannot be compared, sorted or indexed
  as a date.
- 🧮 **No Jalali arithmetic anywhere, and no date library.** Every operation reduces to Gregorian
  arithmetic plus a Jalali reading of the result — the start of a month is "this day minus
  (day-of-month − 1) days", and a month's length is how many days fit before the month you read
  changes. Esfand having 29 days or 30 stays ICU's problem, which already knows.
- 🔢 **Numbers interpolated into a sentence take that language's digits.** `t('{0} week streak',
  3)` was rendering "3 هفته پیاپی" — one Latin numeral in a Persian sentence, two lines under a
  `fmtNum` that had already written ۵٬۲۰۰. Done in `t()` rather than at the call sites, so it is
  true everywhere instead of wherever somebody remembered. String arguments pass through
  untouched: most have been through `fmtNum` already, and formatting a formatted number eats its
  unit.
- 🗣️ **"پس‌کی‌ها از your fingerprint, face or PIN استفاده می‌کنند".** `BIO` and `VAULT` are picked
  by platform at import time, before a locale pack exists, and were being interpolated raw into
  a translated sentence. They are translation keys now, rendered through `t()` at the call site.
  `fmtDur` had the same shape — "1h 30m" is not a value, it is a sentence with the units glued
  on, and no scan for `t('…')` could ever have found it.

A Gregorian locale keeps exactly what it had. Only a non-Gregorian calendar reads its structure
from `Intl`, because Intl's month names disagree with this app's own translations in most of the
languages it ships — 'Sept' against 'Sep', 'janv.', lowercase Spanish, a trailing dot in Russian
— and restyling twelve correct languages to fix a thirteenth is not a fix.

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

### The Farsi the AI layer already had, made reachable

- 🗣️ **`users.locale` was never written.** The column shipped in 001 with a default of `'en'`
  and nothing in the app ever set it, so it was `'en'` for every account that has ever existed.
  Two places read it, both commented as doing the obvious right thing — `interpretBrief` takes
  "the language this person set on their profile", and a drafted note takes "the client's
  language, not the coach's — they are the one who reads this note". Both were reading a
  constant. A Farsi lifter's coach drafted a change and their client got it in English, from a
  layer with Persian prompts and a Persian note template sitting in it unreachable.
- ✍️ **The client says which language it is being read in** — at signup, so the first note an
  account is sent is already right, and on every launch, because the alternative is that anyone
  who never touches the language setting stays on the default forever, which is the bug. The
  endpoint writes nothing when the value has not moved.
- 📋 **One list, checked.** The languages the picker offers and the languages the server will
  record are now the same list, in the domain package where both can reach it, with a test that
  fails if they drift. A language added to the picker and not the allowlist would be a language
  the server silently refuses to record, and the only symptom would be prose staying English.
- 🏋️ **And the lift is named in Persian too.** The exercise names lived in the client, which was
  right while the only thing rendering a name was a screen — and stopped being right the moment
  the server started assembling sentences containing them. A coach's note is built server-side
  and arrives as finished text, so there is nothing left for the client to translate: the first
  Persian note this produced read "پرس سینه هالتر" nowhere and `barbell bench press` twice. The
  pack moved to `packages/domain/src/names/`, one copy, reached from both sides and still
  lazy-loaded on each. Coverage is unchanged — the 66 exercises the planner can emit — so a lift
  outside that set still reads in English inside an otherwise Persian sentence, which is the
  same deliberate trade the library screen makes.
- The AI layer's own scope is unchanged and deliberate: English and Persian are the two
  languages it writes prose in. The register of a coaching note is not a translation job — see
  the comment above `LANGUAGE_NAME` — and ten more half-supported languages would be a worse
  promise than none.

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

- 🟢 **The mark**: a Persian calligraphic stroke that doubles as a lifter under a barbell —
  the bar and its plates across the top, the head and raised arm inside the curve, a diamond
  resting at the foot of the descender. One continuous gesture, strength held still at the top
  and motion in the tail. It is a real vector traced from the brand system's guide sheets
  rather than upscaled from them, drawn as filled contours with `fill-rule="evenodd"` so the
  counters stay open at any size.
- 🎨 **Emerald `#1FA774`, ivory `#F3F0E8`, onyx `#0B0D0E`**, read off the brand system's own
  colour sheet rather than sampled by eye, and flat everywhere — there is no gradient anywhere
  in the identity. Emerald is a token of its own, `--brand`, identical in both themes; `--red`
  stays Apple's, because that is the *error* colour and a destructive action should look the
  way the platform says it looks.
- ♿ **Emerald is a mid-tone, and the type on it knows that.** White on emerald is 3.07:1 —
  the large-text bar and nothing smaller. A filled control carrying normal-size white text
  steps one shade darker to `--brand-2` (`#177D57`), which clears AA at 4.74:1 and reads as
  the same colour.
- 🏭 **One source, twenty-odd outputs.** `infra/scripts/render-logo.mjs` cuts every raster
  from the vectors — PWA icons, the SVG favicon, twenty-four Android mipmaps, the iOS app
  icon, both platforms' launch screens. Nobody edits a PNG by hand, so they cannot drift, and
  CI fails a build where a committed one has. `--check` compares per-pixel with a tolerance
  rather than byte-for-byte, because a PNG rendered by Chromium on Linux is not the same file
  as one rendered on Windows, and a check that fails on the developer's own operating system
  is a check that gets deleted.
- 🖼️ **The launch screen is a layout rule, not a drawing**: the icon tile centred on onyx at
  26% of the shorter side — 14% on the single square iOS uses for every device, where cropping
  to a tall phone throws away more than half the width — with night variants, since the app is
  dark whichever way the system is set and a light launch screen would flash white before the
  first paint.
- ✒️ **The wordmark and lockups are vectors too.** `GYMYAR` is emerald in every colourway;
  only the tagline changes, onyx on light surfaces and ivory on dark, because the brand colour
  does not become something else on a different background. The `A` is drawn without its
  crossbar, as a bare `Λ` — the system's letterform, not a rendering fault.
- 📐 **Traced, and the trace is measured.** Marching squares at the 0.5 iso-level of the source
  anti-aliasing, simplified with Douglas–Peucker, fitted with corner-aware Catmull-Rom → cubic
  Béziers so the barbell keeps hard corners while the calligraphy stays smooth. The mark
  matches its source raster at 0.983 IoU. The tagline is the one element whose fidelity is
  capped by the source rather than the trace — it is 18px tall on the sheet, sits at about
  0.945, and wants re-cutting from larger artwork if any ever turns up.

### Release engineering

- 🔢 **One version, four files.** They had drifted to three answers: the workspace said 0.1.0,
  Android said 1.2.4 with openGym's `versionCode 5`, and iOS said 1.0. `infra/scripts/version.mjs`
  stamps one version into the workspace packages, the Gradle file, the Xcode project and the
  PWA manifest; `--check` fails on drift, and CI runs it.
- 🔐 **Release signing**, reading a gitignored `keystore.properties` or `GYMYAR_KEYSTORE_*`
  from the environment — and building unsigned with a warning when it has neither, so a
  contributor can check the release build compiles without holding a key.
- 💾 **Backups are a command rather than a paragraph.** `infra/scripts/backup.sh` takes the
  dump *and* the media volume — the pair that section 7 of the self-hosting guide had been
  asking people to remember — and writes a manifest of what was in the instance at the time.
  `--verify` restores the dump it just took into a throwaway Postgres container and counts
  users, sets and applied migrations against the live ones, because a backup nobody has
  restored is a hypothesis and a truncated upload looks like a success. `restore.sh` is the
  inverse: it validates the archive *before* it drops anything, refuses a database that
  already holds accounts unless told twice, stops the API so nothing writes mid-restore, and
  recreates the schema rather than restoring over it — a plain dump does not remove rows it
  does not contain, so restoring in place resurrects every account closed since it was taken.
  `backups/` is gitignored, because a dump holds every passkey credential in the instance.
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
- **The app id** moved from `ch.duartesantos.opengym` to `com.gymyar.app` across Capacitor,
  the Android package and the iOS project.

### The deployment nobody had run

Every test in this project passed against Node running the code directly. `docker compose up -d
--build` — the one command the README opens with, and the only way anybody but the maintainer
will ever run this — did not work. Five separate faults, none of which a unit test could see,
found by running it.

- 🖼️ **Every uploaded photo 404'd, and video did not.** A storage key ends in the extension its
  type implies, so an attachment is served from `/media/…/<uuid>.jpg` — and the block that
  caches exercise artwork hard matches `\.jpg$`. nginx tries regex locations *before* prefix
  ones, so the photo was matched by the cache block, looked for under the static root and
  answered 404, while `.mp4` and `.webm` — not in that list — went to the right place and
  worked. `location ^~ /media/` stops the match before the regexes, and the internal
  `X-Accel-Redirect` target needed the same, because an internal redirect is matched against
  these locations too. Caught by the media step of `smoke.sh`, which is the only test in the
  project that runs against nginx rather than against Node serving the bytes itself.
- 📦 **The API image was missing three of the five packages it imports.** Its Dockerfile copied
  `packages/domain` and `packages/db`; the API also imports `@gymyar/ai`, `@gymyar/mail` and
  `@gymyar/storage`. That is not a build error — the image builds, starts, and dies on the
  first `import`. All five are copied now, and every workspace manifest goes into the
  dependency layer so npm can resolve the links at all.
- 🧱 **The web image could not build.** `npm ci` was failing — the lockfile describes seven
  workspaces and the Dockerfile copied three manifests — and the failure was swallowed by
  `2>/dev/null || npm install`, which resolves the tree afresh and walks into npm's
  optional-dependency bug (npm/cli#4828): the linux-musl rolldown binding is in the lockfile
  and does not get installed, and `vite build` dies claiming it cannot find a native binding.
  Two changes: every manifest is copied, and the fallback is gone. A lockfile that does not
  match its manifests is a bug to fix, not a condition to route around — routing around it is
  what turned a one-line omission into an error message about native modules.
- 🖼️ **Every exercise image and animation 404'd — all 1,324 of them, on every hosted
  instance.** The seeder built `image_url` as `/img/<id>.jpg` out of the exercise id, and the
  dataset's files are named `<id>-<hash>.jpg` — `0001-2gPfomN.jpg`. The filename was never a
  mystery: it is already on the record, as `e.img`, and `imgSrc` in the domain has always read
  it. So the mobile build's artwork worked, off a CDN, while the web app's came from a column
  nobody had ever followed. That is what made it survive: a URL is a string, every string
  inserts, and the failure is a picture that is simply not there. The seeder reads `e.img` and
  `e.gif` now; because it re-runs on every boot and upserts, an existing instance repairs
  itself on the next `docker compose up`. Two checks were added rather than one — a unit test
  in `packages/db` that the stored filename is the dataset's filename and not something
  rebuilt out of a neighbouring column, and a step in `smoke.sh` that takes an exercise from
  `/api/exercises` and follows both of its URLs, because the unit test would have been just as
  happy with a name that is wrong in some other way.
- 🚫 **A `.dockerignore`, which there had never been.** Without one, `COPY apps/client/` also
  carried the host's `apps/client/node_modules` into the image — a Windows tree, with that
  platform's native bindings, landing on top of the linux ones npm had just installed — along
  with 42 MB of Gradle intermediates, the built APK, and `.env`.

### The front door, and the numbers on it

`apps/site` had been written and was served nowhere. The compose stack put the application at
`/`, so the first thing anybody saw at a GymYar address was a sign-in screen — and the site
explaining what they were signing in to existed only as files in the repository.

- 🚪 **One origin, three things on it.** nginx now serves the project site at `/`, the app at
  `/app/` and the API at `/api/`. One origin because a passkey is bound to one, a session
  cookie is scoped to one, and the app reaching `/api` with no CORS anywhere is a property of
  `infra/web/nginx.conf` rather than of any code. "Open the app" is a link, not a second
  deployment: somebody who signs in from the site is looking at the same database.
- 🪜 **Moving the app was a line in that file.** The client is built with `base: './'` and
  routes through a HashRouter, so every asset is relative and every route is after the `#`.
  Nothing inside it knows or cares that it is one level down. The two things that did know
  were the web manifest's `id`, which was the absolute `/`, and the service worker.
- 🪦 **`/sw.js` is now a tombstone.** Every browser that opened an earlier build has a service
  worker scoped to the whole origin, and while it lives it is the thing answering for `/` —
  it would keep handing returning visitors a cached copy of the application where the site
  now is. The file at that address deletes the origin's caches, unregisters itself and
  reloads the page. Nothing registers it; only a browser that already has the old one ever
  asks for it. Links from before the move are rescued in the other direction: `site.js`
  forwards any `/#/route` to `/app/#/route`, which is the only layer that can, because a
  fragment never reaches the server.
- 📊 **The counters are read from the database.** `GET /api/public/stats` takes no account and
  answers with counts and one sum — accounts, coaches, finished sessions, working sets,
  tonnage, library size — recomputed at most once every five minutes and served from memory
  in between. That is also why it is off the rate limiter's ledger: the cost of the ten
  thousandth request in a minute is a property lookup, and keying an anonymous endpoint by
  address is the carrier-NAT failure `rate-limit.js` exists to avoid. Warm-up sets and
  unfinished sessions are excluded, because a landing page that counts them is flattering
  itself. Aggregates only, and the route file is deliberately the one with no session check
  in it so that anything added to it later has to be read as public. `PUBLIC_STATS=off` and
  it stops existing.
- 🙈 **The section hides itself.** It ships with the `hidden` attribute and appears only once
  an instance has answered with at least one logged session — so the same files serve
  correctly with no backend at all, on an instance that publishes nothing, and on a brand new
  one where every honest number is zero. Persian digits on the Persian page, which is the
  rule the rest of `/fa/` already followed.
- 🖼️ **The screenshots moved to `/assets/`.** They had been at `/img/`, which is where the
  exercise media volume is mounted — five screenshots at the document root would have
  shadowed 1,324 exercise images, and nothing else in the project would have noticed.
- ✅ **`smoke.sh` checks the web layer now**, when there is one: the site at `/`, the app at
  `/app/`, `/app` redirecting, a wrong path being a 404 rather than the application, the
  screenshots having shipped, and the counters answering without a cookie and naming nobody.
  The API-only run of the same script skips the block rather than pretending to pass it.
- 🧪 **CI had been standing in a directory of the wrong shape.** The compose job skips the
  140 MB media clone by leaving one file called `.ci-placeholder` where the artwork goes —
  which was harmless for exactly as long as nothing followed an exercise's URL. The check
  above does, so every run would have failed on a picture that was never downloaded rather
  than on anything about this code. `infra/scripts/media-placeholders.mjs` writes the empty
  files under the dataset's own names instead. It still catches the bug it was written for —
  a seeder that rebuilds `<id>.jpg` finds nothing at that name either — and it is honest
  about the one thing it cannot show, which is that upstream still ships those bytes.

### The language that front door is in

The site went up with English on the root and Persian under a prefix, which is backwards for a
project whose market is Iran. The page somebody gets before they have chosen anything should be
the one the site is actually for.

- 🇮🇷 **Persian is the root now, English is `/en/`.** A mirror one level down rather than an
  afterthought — the two are the same site — but only one of them can be the address people are
  handed. nginx forwards `/fa/…` to `/…` permanently, so every old link, bookmark and search
  result still resolves; the optional group in the rewrite is what makes a bare `/fa` work
  instead of 404ing on a directory that no longer exists. The English move cannot be redirected
  the same way, because `/docs.html` is a live Persian address now — an old English link lands
  on the Persian page of the same name, where the language switch is the way back.
- 🔤 **Vazirmatn is shipped, not merely named.** The old stylesheet asked for it and shipped
  nothing, which on a Persian-first site means the primary language falls through to whatever
  Arabic face the visitor's machine happens to carry: a different typeface per visitor, and no
  type scale that can be set against any of them. One variable file covers 100–900 for both
  scripts, which is also why there is no second Latin face — the site mixes scripts inside single
  lines (AGPL, `docker compose`, ۱٬۳۲۴) and a Latin-first stack sets each half of such a line in
  a different typeface. Self-hosted rather than Google Fonts, which is not reachable from Iran.
- ✏️ **One stylesheet for both.** Every rule with a side to it is written with logical properties,
  so `dir="rtl"` mirrors the page on its own; what is left as genuinely language-specific is a
  handful of rules at the foot of the file — the Persian line heights, and a tracking reset,
  because letter-spacing tuned for a Latin scale is wrong for a script that joins.
- 📐 **Editorial rather than a landing page.** Hairlines instead of rounded cards; a ruled index
  instead of fifteen boxes with a pictograph apiece, since an emoji is drawn by the reader's
  machine and so is a different shape and colour on every platform and none of those colours is
  ours; one typeface at four sizes. Brand emerald is 2.7:1 on ivory, so it draws lines and never
  carries a word — there is a second, deeper green for anything that has to be read. Nothing on
  the page is below AA.

### Two scripts that failed without saying so

`backup.sh` and `restore.sh` are the only things standing between an instance and a bad day.
Four faults, each of which made the script lie rather than stop.

- 🔤 **`.env` was executed, not read.** `. ./.env` runs the file, and on one saved by a Windows
  editor it assigns values with a trailing carriage return — which is what reported `FATAL: role
  "gymyar" does not exist` on an instance whose role is plainly `gymyar`. The name actually sent
  ended in a CR, and a CR is invisible in the very error message you would use to debug it. Both
  scripts read the file now, with the shell environment winning, which is the precedence compose
  itself uses.
- 🧭 **The compose project name was asked of `node`.** It is what the media volume is named
  after, so getting it wrong means archiving nothing — and `node` is not on the PATH of a
  non-interactive ssh session, which is exactly how anything automatic runs a backup. When it was
  missing the fallback answered `gymyar` without comment: correct on most instances and silently
  wrong on any that had been renamed. Asked of compose now, then of `.env`, then of the directory
  name.
- 🗑️ **A failed backup left a plausible one behind.** The redirection creates the `.sql.gz` before
  `pg_dump` writes a byte into it, so every failure left twenty bytes decompressing to nothing,
  filed by date beside the real ones and indistinguishable from them until the day you reached
  for it. The script's own header says the failure it exists to prevent is somebody taking half
  of a backup. A failed run now removes what it wrote, checks the media archive arrived at all —
  a Docker daemon inside a VM mounts a directory it cannot see as an empty one, takes the tar
  happily and leaves it in the VM — and writes its timestamp in a spelling BSD `date` accepts,
  since `date -Is` is GNU and left every manifest written on a Mac blank.
- 🛡️ **The restore guard could not stop anything.** Every way the question "how many users are
  in here" can fail to be asked — the stack down, the wrong database, the wrong role, a role name
  ending in the carriage return above — came back `0` through a swallowed error, which reads as
  "empty, nothing to protect", and the next thing the script does is drop the schema. It refuses
  to restore into a database it cannot query now, and tells a missing `users` table (a fresh
  database, the ordinary case) apart from one that exists and cannot be counted. It also verifies
  the media archive is readable *by the daemon* before the `rm -rf` that would otherwise destroy
  the volume with nothing in reach to replace it.

### The watch people already own

Phase 9. Four ways into the same place, because no single one reaches everybody: a file, a strap,
a shortcut and a hub. What none of them is, is a vendor integration — Garmin, Polar, Fitbit and
Whoop all write into Apple Health and Health Connect, so integrating the two hubs buys the whole
market, while integrating twelve companies buys the same thing plus twelve OAuth registrations
against signup flows that sanctions break. The reasoning is in
[docs/WEARABLES.md](docs/WEARABLES.md).

- 📥 **An Apple Health export reads in whole.** `parseAppleHealth()` takes `export.zip`, finds the
  `export.xml` inside it, and reads sessions, heart rate and weigh-ins out of a file that
  routinely runs to hundreds of megabytes. Two passes rather than one, because Apple writes every
  `<Record>` before the first `<Workout>` — so the spans a heart-rate sample might belong to are
  not known until the file has been read once, and holding every sample until the sessions show
  up is a hundred thousand objects on a phone. Pass one takes the rare elements; pass two streams
  the heart rate past those spans and keeps only what lands inside one, plus ten numbers per day
  for a resting figure.
- 🗜️ **The zip is opened in a worker, with a bar that moves.** Reading, inflating and scanning are
  seconds of work and all of it is synchronous once it starts; on the main thread that is a
  frozen app and a progress bar that cannot repaint. In a worker the half-gigabyte string never
  enters the window's heap at all. `fflate` rather than the platform's `DecompressionStream`,
  which a 2021 Android WebView does not have — and this project ships to phones that may never
  have seen the Play Store.
- 📡 **A heart-rate strap, live, during the set.** The one thing an export file can never give: a
  number *now* rather than a summary of a session that ended an hour ago. GATT characteristic
  `0x2A37` is a standard, so one decoder reaches a Polar, a Garmin, a Suunto, a Wahoo, every
  chest strap ever made, and an Amazfit with Heart Rate Push switched on. Two transports behind
  one call — Web Bluetooth in the PWA, `@capacitor-community/bluetooth-le` in the Android build,
  which cannot use Web Bluetooth because an Android WebView has never shipped it. Sensor contact
  is read as three states rather than two: a strap that has slipped keeps transmitting, and what
  it sends is whatever it can pick up off a sleeve.
- 📲 **An iPhone sends its own sessions.** There is no native iOS build to read HealthKit from and
  there is not going to be one, so the phone pushes instead: a Shortcuts automation on *when a
  workout ends*, a bearer token minted in Settings and revocable per device, and an endpoint that
  is idempotent on the HealthKit UUID — because automations re-fire, and people re-run a shortcut
  by hand when they think nothing happened. No Developer Program, no Mac, no store review,
  nothing anybody can revoke. There is no `.shortcut` file to download, for the same reason there
  is no iOS app; [docs/HEALTH_SHORTCUT.md](docs/HEALTH_SHORTCUT.md) is the twelve minutes of
  tapping that replaces it.
- 🤖 **Health Connect, on the Android build.** From Android 14 the hub is part of the OS — package
  `com.google.android.apps.healthdata`, in Settings, not uninstallable, no Play Store involved,
  which is the whole reason it is viable for a project that ships through Cafe Bazaar and Myket.
  Zepp, Samsung Health, Mi Fitness, Garmin Connect, Polar Flow and Fitbit all write there. It is
  a local system read, so [MOBILE.md](docs/MOBILE.md)'s promise that nothing leaves the device
  holds exactly — and that is worth saying in the listing rather than leaving somebody to infer
  it from a permission dialog.
- 🧩 **One shape, whichever way it arrived.** A run imported from a file, pushed by a shortcut or
  read off a hub lands on the same library exercise, in the same columns, and nothing downstream
  knows which it was. `healthActivity` reads both dialects — Apple's camel case and Health
  Connect's upper snake — because a second copy of that mapping is how one person's history comes
  to hold two kinds of running that never merge. Where the library has no honest match, and
  *traditional strength training is one of those*, the session is recorded under its own name
  rather than filed under a guess.

#### Four migrations, because the reader was written first

Each of these exists because something was already being read and had nowhere to be put.

- ❤️ **`012_heart_rate.sql` — four numbers on a session.** Average, low, high, and the count
  behind them. Not a samples table: a reading every few seconds is ~175,000 rows per person per
  year, by a wide margin the largest table in this database, for a curve nothing draws yet — and
  a samples table can be added the day something needs the shape of the curve, where adding it
  now costs every row of every import forever. All four or none is a check constraint rather than
  a convention, because three different writers will eventually have to obey it.
- 😴 **`013_resting_hr.sql` — one figure per day.** The number in a health export that most
  repays being plotted: it falls over months of training and rises before somebody gets ill or
  has been sleeping badly, whether or not they trained. Not a column on `bodyweight_entries`,
  though that would have cost no table — a day can have a resting figure and no weigh-in, and
  inventing a weigh-in row to hold it means "how many days did they weigh themselves" stops being
  answerable. It is plotted in Stats beside the weight curve and shares that card's range
  control, because the two are read together and two range pickers a few pixels apart would be
  two controls for one question. The card is absent for a profile with no readings, which is
  most of them: it arrives with a health import or from a watch, and a card that is always
  present and always empty teaches people to ignore it.
- 📈 **`014_set_heart_rate.sql` — the peak around one set.** A set's window closes twenty seconds
  *after* it is checked off, because a working set's heart rate peaks after the bar is racked — a
  window that ends on the checkmark reports a number from the middle of the set and files the
  real peak under the set after it. That is not a rounding error; it is every number on screen
  belonging to the wrong set, and there is a test that runs the same session with no lag and
  asserts both come out wrong. The same migration makes `done_at` true: it has existed since
  `001` and had been carrying the workout's *end* for every set in a session, so twelve sets an
  hour apart all claimed one instant.
- 🔑 **`015_health_shortcut.sql` — a token, and an id from outside.** The token is stored as an
  HMAC under `SESSION_SECRET`, never in the clear, and shown to its owner exactly once.
  `external_id` is unique per user rather than globally, because two accounts on one family phone
  can legitimately hold the same HealthKit UUID and a global constraint would let the first of
  them lock the second out of their own session.

### What that work found on the way

Three things only findable by doing it, and two of them corrected something this project already
believed.

- 🔌 **The plugin the plan named cannot read a workout.** [docs/WEARABLES.md](docs/WEARABLES.md)
  said to spike the Health Connect plugin for its Capacitor peer range before committing, and
  that warning was right and was the smaller problem: `@capgo/capacitor-health`'s data types are
  `steps | distance | calories | heartRate | weight` — samples, with no notion of a session, and
  the milestone is about sessions. `capacitor-health` (mley) has `queryWorkouts` and returns every
  heart-rate sample inside each session with it. The price is body weight, which it cannot read
  and which no plugin on the Capacitor 7 line offers alongside workouts.
- 📦 **Two native plugins were shipping to browsers.** An earlier commit in this release claimed
  `BleClient` appeared nowhere in the web bundle; that check had run against a stale `dist/`, and
  a later one grepped a string this project's own code contains. On a clean build both plugins
  were in there. Guarding the callers does not help — Rollup will not reason across a call
  boundary — and nor does `MOBILE ? import(…) : …`, because that constant is computed in another
  module. Testing `import.meta.env.VITE_MOBILE` at the import itself does: Vite substitutes a
  literal and the branch folds away.
- 📅 **`Date.parse` is not a validator.** It takes `03/09/2026` and reads it the American way, so
  a September session pushed from a phone that writes dates the way most of the world does would
  have landed in March, with no error and nothing to notice. The endpoint matches ISO 8601 before
  parsing now — and requires the offset, because an ISO date-time without one is *the server's*
  local time by the spec, which puts a 21:00 session in Tehran on the following day.

### Nothing to send anywhere, said on a page

- 🔒 **A privacy policy, in both languages.** [`apps/site/privacy.html`](apps/site/privacy.html)
  and `/en/`. It opens by separating the two products, which is not a stylistic choice: the
  Android build has no account and no server, and a single policy describing account data and
  sync would read as a flat contradiction of the "collects nothing" declaration the store
  listings make about it. Health Connect additionally refuses to work at all for an app whose
  declared policy URL does not resolve, so `smoke.sh` asserts both addresses serve — a 404 there
  is a submission blocked by a reviewer rather than by us.
- 📋 **The store disclosures caught up.** `docs/store/privacy.md` still said no location
  permission was declared; the strap added four Bluetooth permissions and two location ones, and
  Health Connect two more. All are listed, with the three that look worse than they are given a
  line for the reviewer field — `neverForLocation` is the app formally declining to derive
  location from a scan, the location permissions are capped so they cannot apply on Android 12 or
  later, and `READ_EXERCISE_ROUTE` is deliberately not requested at all.
- 🧾 **Seven hosts, still.** The host list in that document is re-derived from a clean mobile
  build rather than assumed, and two milestones of native plugins added no outbound request to
  it. The only one actually fetched is still the exercise CDN. That fact is what the whole
  "collects nothing" claim rests on, so it is checked rather than remembered.

### The exercise media, and the escape hatch that was not one

The launch blocker says the artwork is © Gym visual and has to be licensed or replaced, and
four places — `001_init.sql`, `seed-exercises.js`, its test and README.md — all reassured the
reader that replacing it was cheap: `exercises.image_url` and `animation_url` are stored rather
than derived, so a swap is "an `UPDATE`, not a migration". Going to build that swap found that
it had never been true.

- 🖼️ **Nothing that draws a picture read those columns.** `Media.jsx` renders through
  `imgSrc`/`gifSrc`, which were `IMG_BASE + ex.img` — and `ex.img` is a Gym visual filename
  compiled into `exercises-data.js` and shipped in the bundle. The client does not call
  `/api/exercises` at all; the endpoint exists for the server side. An `UPDATE` over that table
  would have changed 1,324 strings in Postgres and not one pixel on anybody's screen. The
  columns were not wrong, and the seeder filled them correctly — they were simply not the
  mechanism, and had been described as one since the first migration.
- 🎛️ **So there is now a media set**, [`packages/domain/src/media-set.js`](packages/domain/src/media-set.js):
  one object naming the artwork, its licence, its attribution and whether it may be sold,
  imported by the client and by the seeder so the column and the screen cannot disagree about
  which set is active. Replacing the media is replacing that file. `media: null` means the
  dataset names its own files, which is the behaviour that has always shipped.
- 🚫 **A set is authoritative about what it omits.** An exercise a replacement set does not
  cover renders no artwork rather than falling back to `ex.img` — because a fallback would make
  a swap look finished while every uncovered exercise carried on serving the pictures the swap
  was performed to stop serving. That is the licence exposure surviving its own remedy, and
  invisibly. The dumbbell placeholder written for custom exercises is what shows instead.
- 🧪 **`node infra/scripts/media-set.mjs check`** exits non-zero for as long as the active
  artwork may not be sold — the README paragraph as an exit code, in the release checklist
  rather than in CI, where it would fail every run.

#### What replacing it would actually cost

`media-set.mjs coverage` measures a candidate against our library, and the answer is worse than
"find a free dataset" suggests.

- 📉 **The best open candidate covers 201 of 1,324 movements** — 15.2%, and **no animations at
  all**. [Free Exercise DB](https://github.com/yuhonas/free-exercise-db) has 873 illustrated
  exercises, but they are keyed by name against our ExerciseDB ids, and the honest matchers are
  the strict ones: 132 identical names, 69 more that are the same words in a different order.
  The holes are not evenly spread — 258 bodyweight and 255 dumbbell movements, 260 of the upper
  arm work — so it is not a set you could ship with a shrug about the tail.
- ⚠️ **A generous matcher is worse than no matcher**, which is why the script refuses to be one.
  Token-subset matching on this data pairs `archer push up` with `push up` and `curl-up` with
  `palms up barbell wrist curl over a bench` — 545 "matches" of which most are a confidently
  wrong picture of a different exercise. A missing picture is forgiven; a wrong one is followed.
- ⚖️ **And that candidate's licence is not what it says.** The repository is published under the
  Unlicense, but its artwork descends from Everkinetic under CC-BY-SA, and share-alike with
  attribution cannot be relicensed into the public domain by a downstream repackager. The
  adapter records CC-BY-SA and credits Everkinetic rather than repeating the README's claim.
  Adopting it means taking on share-alike, which is a question for the legal review that is
  already a launch blocker. [wger](https://wger.de)'s images are cleanly licensed and properly
  attributed per record, and there are 374 of them across 273 exercises — 21% of our library
  before any name matching, and static PNGs rather than animations.

### The S3 driver stops being a stub

`packages/storage/src/s3.js` shipped as five methods with real signatures and no bodies. It was
not laziness — it existed to prove that the interface in `index.js` was shaped by what storage
*is* rather than by what a directory on a disk makes easy, on the theory that an abstraction
with one implementation is a guess. Writing the second implementation is how you find out, so
the bodies are now written and the guess was mostly right.

- 🪣 **`STORAGE_DRIVER=s3` works**, against AWS, R2, or a MinIO on the same machine. Uploads go
  through lib-storage's `Upload` rather than a plain `PutObject`, because the upload route hands
  the driver a `Readable` of unknown length — it streams the request body through a size check
  and never holds it — and `PutObject` wants a `ContentLength` that does not exist yet.
- 📏 **`put` reports the size the bucket holds**, via a HEAD after the write, the way the
  filesystem driver stats the file it just renamed. A truncated upload cannot be recorded as a
  whole one.
- 🗑️ **`delete` still answers whether it deleted anything**, which S3 declines to say: it
  succeeds identically against a key that was never there. The driver buys the answer with a
  HEAD first, because the caller is a sweeper reconciling rows against bytes and "deleted 400"
  when the real number was 3 sends somebody looking for a leak that does not exist.
- 🐢 **The SDK is imported on first use, not at module load.** `index.js` imports this driver
  unconditionally, and the overwhelming majority of deployments run `fs` — a static import would
  make every one of them load the AWS SDK in order not to use it. Construction stays synchronous
  and still fails at boot naming the missing variable.

#### What the second implementation found

One thing, and the stub had explicitly predicted it would not happen: its own comment said
"nothing above this file would have to change".

- ⏳ **`signedUrl` had to become awaitable.** `getSignedUrl` is async because resolving
  credentials can be — an instance role or an STS assumption is a network call before a byte is
  hashed. So `withUrl` in `apps/api/src/media.js` is now `async` and nine call sites await it,
  all of them already inside async handlers. The alternative was hand-rolling SigV4 presigning
  to keep the signature synchronous, which is possible with static credentials and was rejected:
  it trades a mechanical change for hand-written signing code in a security-adjacent path, and
  would have ruled out every credential source that is not two strings in the environment. The
  filesystem driver still returns a plain string, and awaiting a string is a string.

Everything else held. `signedUrl` being a driver method rather than a shared helper is what let
S3 use its own presigning instead of fighting the HMAC in `sign.js`; `internalPath` being
*absent* from the interface is what let `/media/*` answer 501 for this driver rather than
pretending it can serve bytes that never pass through this origin.

#### Tested against something that speaks S3, not against a double

The file that tests the filesystem driver opens by saying why it uses a real directory rather
than a mocked `fs`: a fake agrees with the implementation about exactly the things worth
doubting. That argument is stronger for a remote store, because the questions are S3's answers
and not ours — whether a missing object is a 404 or a named error, whether `DeleteObject` says
what it did, whether a presigned URL actually fetches and actually expires.

So the 10 driver tests run against **MinIO**, and CI stands one up beside the Postgres. Without
`STORAGE_S3_TEST_ENDPOINT` they skip rather than pretend — but skipping in CI would mean the only
place the driver is exercised is a laptop that happens to have MinIO running, which is the same
as not testing it.

### Known limitations

- 💾 **Uploaded media is not in the database dump.** Form-check video and progress photos live
  on a volume and only the rows describing them are in Postgres, so a backup is two things
  rather than one. `infra/scripts/backup.sh` takes both and `restore.sh` puts them back;
  restoring the dump alone gives you an instance where every attachment is a broken link.
- ⌚ **None of the wearables work has touched real hardware.** No chest strap, no iPhone running
  the shortcut, no Android phone with Health Connect. Every path is verified against a fake device
  driving the real code — the real transport, the real store, the real endpoint — which catches
  logic and cannot catch a device that answers differently from its own specification. The first
  real one will find something.
- ⚖️ **Body weight does not come from Health Connect.** No plugin on the Capacitor 7 line reads
  both weight and workouts; the one that reads sessions has no weight permission at all. Weight
  arrives through the file import, which already works. A plugin limitation rather than a
  decision.
- 📄 **The privacy policy has not been reviewed by a lawyer.** It is an accurate description of
  what the software does, written from the code. That is not the same thing, and the legal review
  this release already lists as a launch blocker still covers it.
- 🖼️ **The exercise media is not licensed for a commercial deployment.** The 1,324 animations
  are © [Gym visual](https://gymvisual.com/) and the dataset grants us nothing; they are
  fetched from upstream on first run rather than redistributed here. Exercise rows carry
  `image_url` and `animation_url`, so replacing the source is an `UPDATE` — but until that
  happens or a licence is obtained, this cannot ship as a paid product.
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

GymYar is **AGPL-3.0-or-later**, inherited from openGym and kept deliberately. `NOTICE.md`
carries openGym's attribution and its AGPL section 7 App Store permission verbatim, with a
note that the permission travels to this work — and that its condition, corresponding source
available under the AGPL, binds us too.

---

# openGym, before the fork

Everything below is openGym's changelog as it stood at the fork, by Duarte Santos. Canonical
upstream: <https://gitea.com/DuarteSantos/openGym>. It describes openGym, not GymYar — the
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
