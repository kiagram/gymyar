# Wearables — the next MVP

Get training data off the watch people already own, and into GymYar. Apple Watch and Zepp
first, because between them they are most of what is actually on wrists here.

Mostly a plan rather than a description of something that exists. **M1 is partly built** —
the reader and its heart-rate maths are in `packages/domain`, and the marker below says what
of it is still missing. M2, M3 and M4 are not started.

## The constraint, stated plainly

[RELEASING.md](RELEASING.md) already settled the hard part, and it decides this whole
document:

| Flavour | How people get it | Has a backend? |
|---|---|---|
| **Web / PWA** | your server | yes — accounts, sync, coaching |
| **Android native** | direct APK, Cafe Bazaar, Myket | **no** — offline, state in `gymyar-state.json` |
| **iOS** | realistically the PWA, and nothing else | it *is* the PWA |

Two consequences follow, and every rejected option below is rejected by one of them.

**On iPhone there is no native app, so HealthKit is unreachable.** A PWA cannot call
HealthKit, and Safari has no Web Bluetooth. Every plan that begins "read HealthKit" dies
here. This is not a step that has been skipped — as with the App Store, it is not a step
that exists on this path.

**The Android build has no server.** [MOBILE.md](MOBILE.md) promises that the native
flavour never talks to a backend and that state never leaves the device. Anything added
there has to be a *local* read, or the promise is a lie. Health Connect and Bluetooth both
are. That is why they are the two chosen, and it is worth saying so in the Bazaar listing
rather than burying it in a permission dialog.

## Do not integrate watches. Integrate two hubs.

There is no version of this where we write a Garmin integration, then a Polar one, then a
Fitbit one. Nearly every watch sold — Zepp included — already writes into **Apple Health**
on iOS and **Health Connect** on Android. Two integrations buy the whole market; a third,
Bluetooth, buys the one thing neither hub can give us, which is a live number during a set.

| Device | Android | iOS | Live HR |
|---|---|---|---|
| **Apple Watch** | n/a | Apple Health | ✗ — no native BLE broadcast |
| **Zepp / Amazfit** | Health Connect | Apple Health | ✓ Heart Rate Push |
| Xiaomi / Mi Band | Health Connect | Apple Health | some models |
| Samsung, Garmin, Polar, Fitbit, Whoop, Oura | Health Connect | Apple Health | Garmin, Polar |
| Any chest strap | — | — | ✓ standard GATT |

What was checked before committing to that, rather than assumed:

- **Zepp writes to Health Connect.** *Profile → 3rd-party account linking → Health Connect*,
  covering heart rate, sleep, weight, blood pressure. It is write-only — Zepp pushes out and
  never reads back, which is fine, because we only read.
- **Zepp writes to Apple Health** too: steps, sleep, heart rate, workouts, SpO₂. So the iOS
  work covers Zepp and Apple Watch at the same time, for the same effort.
- **Health Connect is part of the OS on Android 14+** — package
  `com.google.android.apps.healthdata`, in Settings, not uninstallable, no Play Store
  involved. That last clause is why this is viable for us at all. On Android 13 and below it
  is a Play Store app, so coverage is partial today and improves on its own as devices turn
  over.
- **Amazfit "Heart Rate Push"** makes the watch a standard BLE heart-rate monitor — Zepp OS
  3.0+, on Active 2, Bip 6, Balance, Balance 2, T-Rex 3, T-Rex Ultra, GTR 4, GTS 4. Standard
  protocol, so any GATT client reads it and we write no vendor code. Some models only
  broadcast while a workout is running on the watch.
- **Apple Shortcuts** has `Find Health Samples` and `Get Contents of URL`, and an Automation
  tab with a *when a workout ends* trigger. It is the only automatic Apple Watch path that
  needs no Developer Program, no Mac and no store — which on this path means it is the only
  automatic Apple Watch path.

## The MVP

Two slices. Roughly two and a half weeks. No new backend, no new recurring cost, nothing
that a sanctions decision can switch off.

### M1 — Apple Health import · 4–5 days

Extend the scanner that already exists. `parseBodyweight()` in
[`packages/domain/src/import-csv.js`](../packages/domain/src/import-csv.js) already streams
Apple Health's `export.xml` looking for `HKQuantityTypeIdentifierBodyMass`, precisely
because the file runs to hundreds of megabytes and building a DOM would kill the tab. Its
own comment notes that nearly all of the rest is step counts and heart rate.

So: same file, same technique, same tests — add `HKWorkout` and
`HKQuantityTypeIdentifierHeartRate`.

- Covers **Apple Watch and Zepp-on-iPhone in one stroke**, and Garmin, Polar, Fitbit, Whoop
  and Oura come along free, because they all write to Apple Health.
- Runs in the PWA *and* in both native builds. No native code, no permissions, no accounts,
  no relationship with Apple.
- The export arrives as `export.zip`, so unzip in the client, and show progress — the file is
  big enough that a silent spinner reads as a hang.
- Manual and retrospective. The user exports, then shares the file in. That is the honest
  limit of this slice, and M3 is the fix.

This is the best ratio of anything in this document, and it is first for that reason.

#### Where M1 actually stands

**Built.** `parseAppleHealth()` reads sessions, heart rate and weigh-ins out of one
`export.xml` in two passes — one for the rare elements, one that streams the heart rate past
the spans the first pass found, because Apple writes every `<Record>` before the first
`<Workout>` and holding a year of samples to wait for them is a hundred thousand objects on a
phone. A session becomes a workout on a library exercise where one honestly matches (running,
jump rope, elliptical, stair machine) and on a custom cardio exercise named after the activity
where none does. `packages/domain/src/heartrate.js` is the zone maths: maximum from age,
five zones, per-span aggregates, time-in-zone, and a daily resting figure taken as the mean of
a day's ten lowest readings — a count rather than a percentile so it can be computed from ten
numbers per day as the file streams past. Both are covered by `import-health.test.js` and
`heartrate.test.js`.

**Stored.** `012_heart_rate.sql` puts four columns on `workouts` — average, low, high and the
count behind them — and `statemap.js` carries them in both directions, so a session's heart
rate survives a sync instead of living until the first one. Four numbers and not a samples
table: a reading every few seconds is ~175,000 rows per person per year, for a curve nothing
draws yet, and the header of that migration argues the asymmetry. All four or none of them is
a check constraint rather than a convention, because three different writers will eventually
have to obey it. The session sheet shows the average and the peak once ten readings are behind
them.

**Not built.** *The zip, and progress.* The client still reads one text file. `export.zip` has
to be unzipped in the browser, which means a dependency — the app has none for this today —
and the progress reporting the plan already calls for. Until then this reads an `export.xml`
that has been unzipped by hand, which is a real thing a person can do and not a thing most
people will.

**Still homeless.** The parser also computes a daily resting heart rate, and there is nowhere
to keep it: `bodyweight_entries` is the shape it wants and not the table it belongs in, since a
day can have a resting figure without a weigh-in. That is a table, a sync surface and a chart
— a feature rather than a migration — so it is read and dropped for now.

### M2 — Live heart rate over Bluetooth · 7 days

`@capacitor-community/bluetooth-le` in the native builds, Web Bluetooth in Chrome on
Android. Heart Rate Service `0x180D`, characteristic `0x2A37`. One implementation reaches
every device that speaks the standard: Amazfit with Heart Rate Push enabled, Garmin, Polar,
Suunto, and every chest strap ever made.

It is the only item here that produces something an export file cannot — a live number
during a working set, feeding [`effort.js`](../packages/domain/src/effort.js). No account,
no cloud, no vendor, no store review, nothing to pay anyone, ever.

Not Apple Watch. Apple has no native broadcast mode, and asking users to install a
third-party watch app to fake one is not an MVP.

## After the MVP

Both worth doing. Neither is needed to answer the question users are actually asking, which
is whether they can get their watch data in at all.

### M3 — Shortcuts to the API, PWA only · 7 days

A new `apps/api/src/routes/health.js`, a published `.shortcut` file, and a setup guide in
Persian. The user installs the shortcut once, pairs it with a token from their account, and
sets a personal automation on **when a workout ends**. The shortcut reads the workout and
POSTs it.

This is what makes Apple Watch *automatic*, and it does so with no Developer Program, no
Mac, no store, and no dependency anyone can revoke. It is the same mechanism commercial
apps sell for this exact purpose.

PWA only, necessarily: the native builds have no server to POST to, and should not grow one.

Make the endpoint idempotent on `(user, workout_uuid)`. Automations re-fire, and users
re-run shortcuts by hand when they think nothing happened.

### M4 — Health Connect read, Android native · 10 days

`@capgo/capacitor-health` or `mley/capacitor-health`. Read workouts, heart rate, calories,
steps and weight.

Turns Zepp-on-Android from a manual export into a background sync, and brings Samsung
Health, Mi Fitness, Garmin Connect, Polar Flow and Fitbit with it. A local system read, so
the offline promise holds.

**Spike this for half a day before committing.** We are on Capacitor 7.6.8 and the current
`@capgo` line is 8.x. Confirm the peer range or pin an older major; do not discover this in
week two.

## What this touches

| Slice | Files |
|---|---|
| M1 | [`packages/domain/src/import-csv.js`](../packages/domain/src/import-csv.js), its tests, the client import flow |
| M1–M4 | `packages/domain/src/heartrate.js` — new; zones and per-set aggregates, wired into `effort.js` |
| M2 | `apps/client` — a connect sheet, and live BPM on the logging screen |
| M3 | `apps/api/src/routes/health.js` — new; a migration for external workout ids and pairing tokens. The heart rate half of what this row used to name is `012_heart_rate.sql`, which M1 needed first |
| M4 | `apps/client/android` — permissions, and the Bazaar listing's justification for them |

## Privacy, and what it costs elsewhere

Not optional, and not an afterthought at the end:

- [`docs/store/privacy.md`](store/privacy.md) has to cover biometric data before any of this
  ships. Health Connect additionally requires a declared privacy policy to function at all.
- Cafe Bazaar will want the new permissions justified in the listing.
- [MOBILE.md](MOBILE.md) should say plainly that Health Connect and Bluetooth are local
  reads and that nothing leaves the device — it is the true answer, and it is also the
  better pitch.

## Deliberately not built

**Native Wear OS or watchOS apps.** Wear OS installs only from Google Play on the watch, and
Bazaar and Myket have no Wear OS channel, so the app would reach nobody. watchOS apps ship
inside an iOS app bundle, and we do not have one. Two new native codebases, months of work,
no reach. This becomes possible only if GymYar is ever operated by a non-Iranian entity —
the same condition [RELEASING.md](RELEASING.md) already sets on the stores themselves.

**Vendor cloud APIs** — Garmin, Fitbit, Polar, Strava. Each needs a developer registration
and OAuth against a company whose signup and payment flows are exactly what sanctions break,
to reach an install base we do not have, in exchange for permanent maintenance as their API
contracts drift. The hubs already give us those devices for nothing.

## Done means

- [ ] An Apple Watch user can import a year of workouts and heart rate from `export.zip`
      — the workouts are read and kept, the heart rate is read and reported, and neither the
      zip nor a home for the heart rate exists yet (see *Where M1 actually stands*)
- [ ] A Zepp user can do the same on iPhone, and on Android via Health Connect after M4
- [ ] A live BPM is visible during a set with an Amazfit in Heart Rate Push mode, and with a
      generic chest strap
- [ ] Both native builds still make no network calls — assert it, do not assume it
- [ ] `privacy.md` and the Bazaar permission justification land in the same release
