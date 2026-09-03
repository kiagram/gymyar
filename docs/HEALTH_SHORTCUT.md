# Apple Watch → GymYar, with a shortcut

Every workout that ends on an Apple Watch lands in the Health app on the paired iPhone. This is
how you get it from there into GymYar automatically, once, and then never think about it again.

**Why it works this way.** An app can read HealthKit only if it is a native iOS app, and
[RELEASING.md](RELEASING.md) explains at length why there is not going to be one of those — it
needs an Apple Developer Program membership, which needs a payment method that sanctions break.
So the phone pushes instead of us pulling. Shortcuts can do that with no developer account, no
Mac, no App Store review and nothing anyone can withdraw. It is the same mechanism several
commercial apps sell for exactly this purpose.

**There is no `.shortcut` file to download.** Building one needs a Mac and signing one needs
that same developer account, so a downloadable shortcut would run into the same wall the app
does. What follows is the twelve minutes of tapping that replaces it. If somebody with a Mac
wants to build and share one, the shape below is all it has to do.

**Self-hosters:** nothing here needs configuring. The endpoint is part of the API and the keys
are rows in your own database.

---

## 1. Make a key

In GymYar: **Settings → Data → Apple Watch, automatically → Make a key**.

It is shown once. Copy it before you close the sheet; if you lose it, revoke it and make
another. One key per device is the intended shape — an iPhone and an iPad get one each, so
either can be revoked without breaking the other.

The screen also shows when each key was last used, which is the only way to tell a working
automation from one that quietly stopped.

## 2. Build the shortcut

**Shortcuts → Automation → New → Workout → When a workout ends → Run Immediately.**

Then one action: **Get Contents of URL**.

| Field | Value |
|---|---|
| URL | `https://your-instance/api/health/workout` |
| Method | `POST` |
| Header | `Authorization` = `Bearer YOUR_KEY` |
| Request Body | `JSON` |

And the body fields. Only the first two are required:

| Field | From | Notes |
|---|---|---|
| `uuid` | the workout's UUID | what stops a re-run recording the session twice |
| `start` | start date | ISO 8601 **with time zone** — see below |
| `end` | end date | same format |
| `type` | workout type | e.g. `HKWorkoutActivityTypeRunning` |
| `distanceKm` | distance | kilometres |
| `minutes` | duration | only if you want to exclude paused time |
| `hrAvg` `hrMin` `hrMax` `hrSamples` | Find Health Samples → Heart Rate, between start and end | all four or none |

### The date format is not optional

In the **Format Date** action choose **ISO 8601** and turn **Include Time Zone** on.

The endpoint refuses anything else rather than guessing, and both halves of that matter. A date
like `03/09/2026` is the 3rd of September to most of the world and the 9th of March to a
JavaScript date parser, so a guess there files sessions six months out with nothing to show for
it. And an ISO date with no zone means *the server's* local time — a 21:00 session in Tehran
pushed to an instance running in UTC would land on the following day.

### Heart rate is all four or none

`hrAvg`, `hrMin`, `hrMax` and `hrSamples` are stored together or not at all: an average with no
range and no count is a number nobody can weigh. If you wire up only some of them the session
still arrives, just without a heart rate. Add the rest later and re-run the shortcut — see
below.

## 3. Test it

Run the shortcut by hand. You should get back `201` the first time.

Run it again. You should get `200`, and there should still be exactly one session in GymYar.
That is the point of `uuid`: automations re-fire, people re-run a shortcut when they think
nothing happened, and neither may produce a duplicate. Re-running after you have added more
fields updates the session you already have.

---

## What arrives, and what does not

A session lands as a workout with its name, its start and end, and its heart rate.

Where the exercise library has an honest match for the activity — running, jump rope,
elliptical, stair machine — it also gets a set with the duration and distance on that exercise.
Where it does not, and *traditional strength training is one of those*, the session is recorded
with no sets rather than filed under a guess. The lifting itself is what you log in GymYar; what
the watch adds is that it happened, how long it took, and what your heart did.

None of this reaches the Android build. It has no backend by design — see
[MOBILE.md](MOBILE.md) — and this endpoint is part of the server, so the row in Settings does
not appear there.

## If it stops working

- **Check when the key was last used.** Settings → Apple Watch, automatically. A key that has
  never been used means the shortcut has never successfully run.
- **`401`** — the key is wrong or was revoked. Make a new one and paste it in.
- **`400`** — almost always the date format. Check that Include Time Zone is still on.
- **Nothing at all** — iOS suspends automations that error repeatedly. Open the shortcut and run
  it by hand; if that works, the automation should resume.
