# Building the mobile app (iOS / Android)

GymYar ships in two flavours from one codebase, and they are genuinely different products:

| | **Web / PWA** (the default) | **Native app** (`VITE_MOBILE=1`) |
|---|---|---|
| Runs | in any browser, against your server | natively on iPhone / Android, in a Capacitor shell |
| Accounts | passkey or password sign-in | none — the phone *is* the account |
| Data | rows in Postgres, synced to every device | a file in the app's private storage, never leaves |
| Coaching | the whole point | not present |
| Subscriptions | the coach side is paid | nothing to buy; `/billing` is routed away |
| Reminders | Web Push from your server | native local notifications, no server |
| Exercise media | served by your server (`img/`, `gif/`) | from the jsDelivr CDN |

The native flavour never talks to a backend: no sign-in screen, no sync, no telemetry. State is
mirrored from `localStorage` into `gymyar-state.json` in the app's private data directory on
every change — iOS may evict WebView storage under pressure, so the file is the durable copy
and is restored on launch. Backups go out through the OS share sheet rather than a browser
download.

That is why coaching is absent rather than hidden: there is no server to hold a roster, no
account to attach it to, and nobody to bill. [RELEASING.md](RELEASING.md) covers what follows
from that for distribution.

## The two things this build reads that the web one cannot

Both arrived with [WEARABLES.md](WEARABLES.md), and both are worth stating here because they
are the only permissions this flavour asks for beyond the reminder's alarm — and because a
permission dialog is a bad place to learn what an app is doing.

**A heart-rate strap, over Bluetooth.** A chest strap or a watch in broadcast mode, read
directly while a session is running. `BLUETOOTH_SCAN` is declared `neverForLocation`, which is
the app formally saying it will not use a scan to work out where somebody is — and is why no
location permission is requested at all on Android 12 and later.

**Sessions, from Health Connect.** The hub the OS ships from Android 14, holding whatever a
Zepp, a Samsung, a Garmin, a Polar or a Fitbit has already written. Two permissions,
`READ_EXERCISE` and `READ_HEART_RATE`, and deliberately not `READ_EXERCISE_ROUTE` — somebody's
route is a map of where they run and this app has nowhere to put one.

Neither is a network call. Both are the phone handing this app data the phone already holds,
which is what lets the promise above stay exactly as strong as it was: nothing leaves the
device, because there is nowhere for it to go.

## Prerequisites

- Node 20+
- **Android:** Android Studio (bundles the SDK). Java 21 for Gradle.
- **iOS:** a Mac with Xcode 15+ and CocoaPods (`brew install cocoapods`). A free Apple ID is
  enough to run the app on your own iPhone; the paid Developer Program is only needed for App
  Store distribution, which [is not available to Iranian developers](RELEASING.md#the-store-situation-stated-plainly).

## Build and run

From the repository root:

```bash
npm install
npm run sync:mobile         # VITE_MOBILE build + `cap sync` into android/ and ios/

cd apps/client
npx cap open android        # Android Studio → run on an emulator or device
npx cap open ios            # Xcode (Mac only) → set your signing team, then run
```

`npm run sync:mobile` bakes the CDN media base into the bundle and copies the web build into
both native projects. Re-run it after every web-code change, before building natively.

The mobile build's environment lives in [`apps/client/.env.mobile`](../apps/client/.env.mobile)
and is picked up by `vite build --mode mobile`. It is a file rather than a `VAR=value vite
build` prefix in `package.json` because that prefix is shell syntax, and npm runs scripts
through `cmd.exe` on Windows — where it is a syntax error rather than a build.

> **After `sync:mobile`, `apps/client/dist` holds the *mobile* bundle.** Run a plain
> `npm run build` before deploying `dist` anywhere — otherwise you ship an app with no sign-in
> to everyone who visits your site.

## App icons and splash screens

The identity lives in [`logo/`](../logo/README.md) — five SVGs and nothing else. Every raster
the apps ship is cut from them:

```bash
node infra/scripts/render-logo.mjs
```

That writes the Android mipmaps and splash screens, the iOS app icon and splash, the PWA icons
in `apps/client/public/`, and `apps/client/resources/icon.svg` — which is a *copy*, not a
source. Edit `logo/`, re-run, commit what changes. CI runs the same script with `--check` and
fails if a committed PNG has drifted.

It renders through headless Chromium — the rasteriser the browser tests already depend on —
rather than `@capacitor/assets`, which needs a working `sharp` native build and does not touch
`public/` at all.

The launch screen is not a drawing: it is the app-icon tile centred on the brand's off black,
sized to a share of the shorter side so it survives being centre-cropped to whatever shape the
device is. Android gets one per density and orientation, night variants included — the app is
dark whichever way the system is set, so a light launch screen would flash white before the
first paint. iOS gets one square for every device, and because cropping that to a tall phone
leaves less than half its width visible, the tile on it is drawn smaller.

## Permissions, and what asks for them

- **Notifications** are requested only when the workout-day reminder is switched on, not at
  launch. A permission prompt on first open, before anybody knows what the app is, is how you
  get denied permanently.
- **`SCHEDULE_EXACT_ALARM`** is declared on Android so the reminder fires at the minute where
  the user allows it.
- Nothing else. No location, no contacts, no camera, no analytics SDK, no network calls at all
  beyond fetching exercise media from the CDN.

That list is also the honest answer to Google Play's Data safety form and Apple's privacy
labels: the native build collects nothing and transmits nothing.

## Releasing

Versioning, signing, the distribution channels that actually exist, and the pre-release
checklist are in [RELEASING.md](RELEASING.md). The short version: stamp the version with
`node infra/scripts/version.mjs`, and guard the release keystore with your life — an update
signed with a different key cannot install over an existing one, and on this build that means
the user's training goes with it.
