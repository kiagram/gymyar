# Releasing

## What actually ships, and where

GymYar is three products from one codebase, and they do not go to the same places.

| | What it is | How people get it |
|---|---|---|
| **Web / PWA** | The whole product — accounts, sync, coaching, subscriptions | Your server. Installed to a home screen from the browser. |
| **Android app** | Offline single-user tracker. No accounts, no sync, no coaching, no payments. | Direct APK, Cafe Bazaar, Myket |
| **iOS app** | The same offline tracker | Realistically: nowhere. See below. |

That split is not a limitation to fix before shipping — it is the shape of the product. The
native builds (`VITE_MOBILE=1`) never talk to a backend: state lives in a file in the app's
private storage, reminders are OS-local notifications, and there is no sign-in screen. So the
paid tier does not exist in them at all, and `/billing` is routed away in those builds
([App.jsx](../apps/client/src/App.jsx)) rather than left to fail against a server that is not
there.

**Coaching is a web product.** Anybody who wants it — coach or client — uses the PWA. That is
also, conveniently, the answer to every app store's rules about who may take money for digital
goods: a store build with no accounts and no payment surface raises none of those questions.

## The store situation, stated plainly

**The Apple Developer Program and Google Play Console are not available to Iranian developers
or Iranian companies.** US sanctions are the reason, there is no Iranian App Store storefront,
and Google Play is not usefully reachable from Iran either. This is not a step that has been
skipped — it is not a step that exists on this path.

What that leaves:

- **Android — direct APK.** Serve a signed APK from the marketing site. Ordinary in Iran and
  the only channel that depends on nobody.
- **Android — [Cafe Bazaar](https://cafebazaar.ir) and [Myket](https://myket.ir).** The
  Iranian Android stores, and where Iranian users actually look. Both take an APK; Bazaar
  wants its own listing and review.
- **iOS — the PWA.** Safari → Share → *Add to Home Screen*. Full screen, no expiry, and it is
  the *complete* product rather than the cut-down offline one, since the PWA has accounts and
  sync. Ironically the best iPhone experience here is the one that involves no app at all.
- **iOS — sideloading** (Xcode free signing, AltStore) re-signs every seven days. Fine for the
  maintainer's own phone; not a distribution channel.

If GymYar is ever operated by a non-Iranian entity, the App Store and Play paths open up —
and at that point the store builds would need either to stay free and account-less as they are
now, or to add the platform's own in-app purchase. Do not add a link to Zarinpal checkout
inside a native build shipped to Apple or Google; that is a guideline 3.1.1 rejection.

## One version, four files

The version lives in `package.json` and is stamped everywhere else from there:

```bash
node infra/scripts/version.mjs 1.1.0
```

That writes the workspace packages, `android/app/build.gradle`, the Xcode project and the PWA
manifest. `--check` verifies they agree and fails if they do not; CI runs it.

Android's `versionCode` is derived as `major*10000 + minor*100 + patch`, so 1.2.3 is 10203.
It must strictly increase or Android refuses to install the update. The fork inherited
openGym's `versionCode 5` and carried it for four commits; anything above 1.0.0 clears it.

## Signing the Android build

The keystore identifies the app. An update signed with a different key is a *different app* to
Android, and the only fix is asking every user to uninstall — losing their training, since the
native build keeps it on the device. **Back the keystore up somewhere that is not a git
repository, and never commit it.** `.gitignore` covers `*.keystore`, `*.jks` and
`keystore.properties`, but that is a safety net, not a plan.

One time:

```bash
keytool -genkeypair -v -keystore gymyar-release.jks -alias gymyar -keyalg RSA -keysize 4096 -validity 10950
```

Then either write `apps/client/android/keystore.properties`:

```properties
storeFile=/absolute/path/to/gymyar-release.jks
storePassword=…
keyAlias=gymyar
keyPassword=…
```

…or set `GYMYAR_KEYSTORE_FILE`, `GYMYAR_KEYSTORE_PASSWORD`, `GYMYAR_KEY_ALIAS` and
`GYMYAR_KEY_PASSWORD` in the environment, which is what CI uses. With neither, the release
build still compiles — unsigned, and it says so — so a contributor can check the build without
holding a key.

## Cutting a release

```bash
node infra/scripts/version.mjs 1.1.0      # stamp it everywhere
npm test                                   # needs a Postgres in DATABASE_URL
npm run sync:mobile                        # VITE_MOBILE build + cap sync into android/ and ios/
cd apps/client/android && ./gradlew assembleRelease
```

The APK lands at `apps/client/android/app/build/outputs/apk/release/app-release.apk`. For
Cafe Bazaar, upload that; for a store that wants a bundle, `./gradlew bundleRelease`.

Then, in order:

- [ ] `node infra/scripts/version.mjs --check` passes
- [ ] `npm test` green, including the database and API suites
- [ ] Install the APK **over the previous release** on a real device — this is the step that
      catches a wrong signing key, and nothing else does
- [ ] Check the app still works with the network off; that is the whole premise of this build
- [ ] Check one RTL language end to end. Farsi is the primary market and the layout mirrors
- [ ] Tag the commit, and keep the exact APK you uploaded
- [ ] Deploy the web app separately — `npm run build`, **not** `build:mobile`, which leaves a
      backend-less bundle in `dist/`

> After `npm run sync:mobile`, `apps/client/dist` holds the *mobile* bundle. Deploying that to
> a server ships an app with no sign-in to everyone who visits.

## Before the first paid release

Neither of these is code, and both still block taking money:

1. **Exercise media.** The 1,324 animations are © [Gym visual](https://gymvisual.com/) and the
   dataset grants us nothing. License them or replace them. The set that ships is
   `packages/domain/src/media-set.js`, and the gate is:

   ```bash
   npm run media:check
   ```

   which exits 1 for as long as the active artwork is not licensed for sale. It is not in CI,
   because it would fail every run today; it belongs in the release checklist, where failing is
   the point. This line used to say the swap was an `UPDATE` over `exercises.image_url` — it
   was not, and `media-set.js` explains what it is instead.
2. **Legal review** of the AGPL position, since we charge for hosting — and the repository has
   to be public before that happens. See [PUBLISHING.md](PUBLISHING.md).

Also worth knowing before a store submission: the AGPL sits badly with app-store terms on its
own, which is why [NOTICE.md](../NOTICE.md) carries the App Store additional permission
inherited from openGym. It is granted on the condition that the corresponding source stays
available under the AGPL at the project repository.
