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

Both ask for a privacy policy URL. Point it at the marketing site's privacy page, and make sure
that page distinguishes the app from the web service — a single policy that describes account
data and sync will read as a contradiction of the "collects nothing" declaration above.

## Permissions the app declares, and why

| Permission | When it is requested | Why |
|---|---|---|
| `POST_NOTIFICATIONS` (Android 13+) | Only when the user switches the workout reminder on | The reminder is a local notification |
| `SCHEDULE_EXACT_ALARM` | Declared; used if granted | So the reminder fires at the chosen minute |
| Notifications (iOS) | Only when the user switches the reminder on | Same |

Nothing else. No location, contacts, camera, microphone, storage or phone-state permission is
requested or declared. The reminder prompt deliberately does not appear at launch — a
permission dialog shown before anybody knows what the app is gets denied permanently, and the
reminder is the one feature that needs it.

## Content rating

No user-generated content, no in-app communication, no purchases, no advertising, no location
sharing. Every questionnaire should come out at the lowest rating.

Answer these from the native build, not the web app: the web app has coach-to-client messaging
and the native build has none.

## Account deletion

Google Play requires a deletion route for apps with accounts. This app has no account, so the
question does not apply — but if a form insists, the honest answer is that uninstalling the app
removes all of it, and the app can export everything first through the OS share sheet.
