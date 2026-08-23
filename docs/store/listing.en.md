# Store listing — English

**This describes the native app, which is the offline tracker.** It has no accounts, no sync
and no coaching, and the listing must not imply otherwise — a store listing that promises
features the binary does not have is a rejection, and a user who installs expecting their
coach to be in there has been misled by us rather than by the store.

The coaching product is the web app. It may be *mentioned* as a separate thing, once, at the
bottom. It may not be the pitch.

---

## Title

Field limits: Google Play 30 characters, App Store 30, Cafe Bazaar 50.

```
GymBuddy — Workout Tracker
```
25 characters.

## Subtitle / short description

Google Play short description: 80 characters. App Store subtitle: 30.

**Short description (80):**
```
Log every set. Follow a programme. Works with no account and no internet.
```
72 characters.

**App Store subtitle (30):**
```
Offline workout log
```
19 characters.

## Full description

Under 4000 characters everywhere that matters.

```
GymBuddy is a gym and body-weight tracker that stays out of your way.

No account. No sign-up. No internet connection. Open it and start logging — your training
lives on your phone and never leaves it.

WHAT IT DOES

• Log sets, reps and weight as you lift, one tap at a time
• Build routines and a weekly plan, or start from a template
• 1,324 exercises with animations, searchable by muscle and equipment
• Progression that suggests the next weight from what you actually lifted
• Rest timer that keeps the screen on mid-session
• Charts for volume, estimated 1RM and body weight over time
• A reminder on the days your plan has a session
• Export everything as a file, any time, through the share sheet

THIRTEEN LANGUAGES

English, Persian, German, Spanish, French, Italian, Portuguese, Polish, Turkish, Russian,
Chinese, Korean and Hindi — including full right-to-left layout in Persian, and a Jalali
calendar rather than a converted Gregorian one.

WHAT IT DOES NOT DO

It does not collect anything. There is no account, no analytics, no advertising ID, no
tracking, and nothing is uploaded anywhere. The app makes exactly one kind of network request:
fetching exercise animations. Turn the network off and everything else still works.

It is also free, with nothing to buy inside it.

OPEN SOURCE

GymBuddy is AGPL-3.0 and the source is public. It is built on openGym.

If you train with a coach, there is a web version at [SITE URL] that adds accounts, sync
across devices and coach-to-client programming. This app is the offline half, and it is
complete on its own.
```

`[SITE URL]` — fill in at submission. Do not link to a checkout page; see
[RELEASING.md](../RELEASING.md).

## Keywords (App Store, 100 characters, comma-separated)

```
gym,workout,tracker,lifting,strength,log,routine,offline,fitness,training,weights,progress
```
90 characters.

## Category

- Google Play / Cafe Bazaar: **Health & Fitness**
- App Store: **Health & Fitness**, secondary **Sports**

## Content rating

No user-generated content, no communication features, no purchases, no ads, no location. Every
questionnaire should come back at the lowest rating — Everyone / 3+.

The native build genuinely has no messaging in it. Do not answer the "users can interact" or
"shares location" questions from what the web app does.

## Screenshots

Needed at phone size, and the store will reject a set that shows placeholder data. Capture
against the demo seed so the charts have something real in them:

1. A session in progress — the set logger with the rest timer running
2. Today's plan
3. The exercise library with an animation playing
4. Progress charts — volume and estimated 1RM
5. The same session screen in Persian, showing the mirrored layout

The fifth is worth including even in the English listing: it is the fastest way to show the app
is genuinely translated rather than machine-labelled.
