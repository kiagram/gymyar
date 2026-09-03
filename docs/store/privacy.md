# Privacy disclosures for the native app

Every store asks the same questions in a different form. The answers below are for the
**native build only** (`VITE_MOBILE=1`) — the thing that gets uploaded. The web app collects
more than this, and answering these questions from what the web app does would be a false
declaration.

If you are ever unsure which to answer for: the binary you are uploading is the one being
asked about.

## The short version

The native build collects nothing, transmits nothing, and has no account. It makes exactly one
kind of outbound request: fetching exercise images and animations from the jsDelivr CDN. It
holds no credentials, so that request identifies nobody beyond the ordinary IP address any HTTP
request carries.

This is enforced rather than assumed. `api()` in
[apps/client/src/lib/api.js](../../apps/client/src/lib/api.js) throws immediately when
`MOBILE` is set, so a future screen that forgets to check the build flavour fails loudly in
development instead of quietly calling a server that is not there. The API client is still
*present* in the bundle — grepping the built assets for `/api/` finds plenty of dead strings —
but none of it can run.

What is worth re-checking before a submission is whether anything new reaches the network by
some other route:

```bash
npm run sync:mobile
grep -rEo "https?://[a-z0-9.-]+" apps/client/dist/assets/*.js | cut -d: -f2- | sort -u
```

As of 1.0.0 that returns seven hosts and only one of them is fetched:

| Host | What it is |
|---|---|
| `cdn.jsdelivr.net` | **The one real request.** Exercise images and animations. |
| `gitea.com` | The openGym attribution link in Settings — an `<a href>`, followed only if tapped |
| `github.com` | A polyfill suggestion inside a library's warning message |
| `react.dev`, `reactrouter.com` | URLs in library error messages |
| `www.w3.org` | The SVG `xmlns` namespace. Not an address at all |
| `localhost` | React Router's internal base for parsing relative paths |

A host outside that list is a new outbound request, and this file stops being true until
somebody works out what it is.

## Google Play — Data safety

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **No** |
| Is all user data encrypted in transit? | Not applicable — no user data is transmitted |
| Do you provide a way for users to request that their data be deleted? | Not applicable — uninstalling removes it; in-app export exists |
| Data types collected | None |
| Data types shared | None |

Notes for the reviewer field, if there is one:

> The app has no account system and no backend. All training data is stored locally in the
> app's private storage and is never transmitted. The only network requests fetch exercise
> illustrations from a public CDN (jsDelivr). No analytics, advertising or tracking SDK is
> present.

## Apple — App Privacy ("Nutrition label")

Answer **"Data Not Collected"** for every category. Nothing here is linked to identity, and
nothing is used for tracking, so no further questions apply.

If a `SKAdNetwork`, advertising or attribution question appears, the answer is no — the app
contains no such framework.

## Cafe Bazaar / Myket

Both ask for a privacy policy URL, and so does Health Connect. It is
`https://<your-domain>/privacy.html`, which is `apps/site/privacy.html` in this repository —
Persian on the root, English at `/en/privacy.html`.

That page opens by separating the two products before it says anything else, which is not a
stylistic choice: a single policy describing account data and sync would read as a flat
contradiction of the "collects nothing" declaration above, and a reviewer comparing the two
would be right to reject it.

## Permissions the app declares, and why

| Permission | When it is requested | Why |
|---|---|---|
| `POST_NOTIFICATIONS` (Android 13+) | Only when the user switches the workout reminder on | The reminder is a local notification |
| `SCHEDULE_EXACT_ALARM` | Declared; used if granted | So the reminder fires at the chosen minute |
| Notifications (iOS) | Only when the user switches the reminder on | Same |
| `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT` | Only when the user taps to look for a heart-rate strap | Reading bpm off a chest strap during a session |
| `BLUETOOTH`, `BLUETOOTH_ADMIN` (`maxSdkVersion="30"`) | Same, on Android 11 and below | The old permission names, capped so they never apply on newer phones |
| `ACCESS_COARSE_LOCATION` (`maxSdkVersion="28"`), `ACCESS_FINE_LOCATION` (`maxSdkVersion="30"`) | Same, on Android 11 and below | **Not for location.** The OS required it for any BLE scan before Android 12 |
| `health.READ_EXERCISE`, `health.READ_HEART_RATE` | Only when the user opens the Health Connect sheet and allows it | Reading sessions and their heart rate out of Health Connect |

Nothing else. No contacts, camera, microphone, storage or phone-state permission is requested
or declared, and no location permission applies on any phone running Android 12 or later. The
reminder prompt deliberately does not appear at launch — a permission dialog shown before
anybody knows what the app is gets denied permanently, and the reminder is the one feature that
needs it.

Three of these deserve a sentence in the reviewer field, because each looks worse than it is:

- **`BLUETOOTH_SCAN` is declared `neverForLocation`.** That attribute is the app formally
  telling Android it will not derive location from a scan, and it is why no location permission
  is requested on Android 12 and later. `BleClient.initialize({ androidNeverForLocation: true })`
  makes the same claim from the code side.
- **The two location permissions are for Android 11 and below only**, where the OS itself
  refused a BLE scan without one. Both are capped with `maxSdkVersion`, so on a current phone
  they are not merely unused — they do not apply.
- **`READ_EXERCISE_ROUTE` is deliberately not requested**, though the Health Connect plugin
  offers it. A route is a map of where somebody runs and this app has nowhere to show one.

## Health data, which is the part that changed

The app now reads two kinds of health data — heart rate from a Bluetooth strap, and sessions
plus their heart rate from Health Connect. **Neither changes any answer above**, and it is
worth being precise about why, because "reads health data" and "collects health data" are
different questions and only the second one is being asked.

Play's Data safety asks what is *collected* — meaning transmitted off the device — and what is
*shared*. Both remain none. The strap talks to the phone; Health Connect is the phone handing
this app rows it already holds. Nothing goes out, because in this build there is nowhere for it
to go: the host list above is still the same seven, and the only one fetched is the exercise CDN.

Where a form asks whether the app *accesses* health data, the answer is yes, and the follow-up
is that it is used solely to show the person their own training back to them, is stored only on
the device, and is not used for advertising, analytics or any secondary purpose.

### Health Connect's own requirements

Google requires an app reading from Health Connect to declare a privacy policy, and the
permission sheet links to it. Two things follow:

1. **The policy URL must be live before a build with these permissions is submitted.** It is
   `https://<your-domain>/privacy.html` — `apps/site/privacy.html`, Persian on the root and
   English at `/en/privacy.html`.
2. **The rationale screen has to open.** `AndroidManifest.xml` declares both entry points, an
   activity for Android 13 and below and an alias for 14 and later, because Android changed the
   mechanism between them and a phone that finds neither shows a dead link at the exact moment
   somebody is deciding whether to trust the app with their heart rate.

## Content rating

No user-generated content, no in-app communication, no purchases, no advertising, no location
sharing. Every questionnaire should come out at the lowest rating.

Answer these from the native build, not the web app: the web app has coach-to-client messaging
and the native build has none.

## Account deletion

Google Play requires a deletion route for apps with accounts. This app has no account, so the
question does not apply — but if a form insists, the honest answer is that uninstalling the app
removes all of it, and the app can export everything first through the OS share sheet.
