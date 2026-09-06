# Exercise media: the options, measured

This is the document a person uses to decide what artwork GymYar ships. It does not decide.
Activating a set is a licence decision, made by changing
[`packages/domain/src/media-set.js`](../packages/domain/src/media-set.js) by hand, and nothing
here changes it — the active set is still Gym visual's and `npm run media:check` still exits 1.

Every number below was produced by `node infra/scripts/media-set.mjs coverage --all` on
2026-09-06 and can be reproduced with that command. The licence findings were produced by
following each source's claim upstream, and the trail is written on each adapter in
[`infra/scripts/media-set.mjs`](../infra/scripts/media-set.mjs).

## Two denominators, not one

The library has 1,324 movements. The programme generator (`planner.js`) does not draw from all
of them: it has 13 movement patterns with 68 named preferences between them, and
`plannerReach()` enumerates what those can produce —

| Set | Size | What it is |
|---|---|---|
| Library | 1,324 | Everything a person browsing the exercise list can open |
| Planner candidates | 201 | Every library exercise a pattern's named preferences admit at all — the ceiling of what a programme can contain |
| Planner picks | 67 | The first and second choice of every pattern against every plausible kit — what an ordinary brief actually lands in. Every one of 200 generated test programmes falls inside it |

So "does the AI feature have pictures" is a question about 67 movements, and "does the library
have pictures" is a question about 1,324. Until now only the second had been measured. They are
very different numbers, and a set can be good at one and useless at the other.

## The candidates

| Source | Licence, as verified | May be sold | Library (of 1,324) | Planner picks (of 67) | Planner candidates (of 201) | Animation | Obligations | Cost |
|---|---|---|---|---|---|---|---|---|
| **Gym visual** (active today) | Proprietary. Non-exclusive commercial royalty-free licence sold per account; media "may not be resold or redistributed" | Only under a purchased licence | 1,324 · 100% | 67 · 100% | 201 · 100% | Yes, all 1,324 | Licence bound to one person or organisation; no redistribution — see the note on the APK below | Quote required from gymvisual.com; not listed publicly |
| **wger** | CC-BY-SA 3.0 (88 images) and 4.0 (286), per record, self-declared by ~60 uploaders; 43 AI-generated images excluded by the adapter | Yes by the terms — see caveat | 20 · 1.5% | 5 · 7.5% | 7 · 3.5% | None. 78 CC-BY-SA 4.0 videos on 46 exercises, MOV/HEVC, 2 of which match our names | Name the author of every image; share-alike on the artwork and adaptations | Free |
| **Free Exercise DB** | **Unknown.** README says Unlicense; the images are unattributed studio photographs; maintainer: "no idea where the images are from" (issue #2) | No | 201 · 15.2% | 12 · 17.9% | 37 · 18.4% | None | Cannot be discharged — no rights holder to credit | Free, and worth it |
| **wrkout/exercises.json** | **Unknown.** The upstream of the row above, same files; no LICENSE file; README says "public domain" and sells a commercial set separately | No | 201 · 15.2% | 12 · 17.9% | 37 · 18.4% | None | As above | As above |
| MuscleWiki | Could not be read: the site answers 403 to non-browser requests, and no licence statement or open dataset was found | Unknown, presumed proprietary | not measured | — | — | Video | — | Unknown |
| ExerciseDB (exercisedb.io) | The commercial channel for the same Gym visual artwork our ids come from; terms behind the pricing page | Only under their subscription terms | 1,324 by construction | 67 | 201 | Yes | Whatever the subscription says | Subscription; "View pricing" on the site |
| Commission the planner picks | Whatever contract is signed | Yes | 67 · 5.1% (or 201 · 15.2%) | 67 · 100% | up to 201 · 100% | If commissioned as such | None beyond the contract | 67 (or 201) illustrations at whatever an illustrator charges |

**On wger's "may be sold".** Every licence the platform offers permits commercial use, and the
platform's README says its exercise data is "Creative Commons (see individual entries)". What
cannot be verified from outside is that each uploader owned what they uploaded — the ordinary
position of any user-contributed CC corpus. The adapter records `commercial: true` in the sense
"the terms permit it", not "nobody could object", and excludes the 43 AI-generated images because
whether a CC licence can be granted on one is unsettled. Whether share-alike on 20 images is an
acceptable obligation is question 6 in [LEGAL_BRIEF.md](LEGAL_BRIEF.md).

**On the two "free" photograph sets.** The repository this project used to describe as the best
open candidate is not licensed at all. Its README prints Unlicense; its artwork is not
Everkinetic's line drawings (those are on wger, 83 of them, credited and CC-BY-SA 3.0) but
photographs of one model in one gym in branded kit, restructured from a repository that has no
licence file and an open issue asking where they came from, and the maintainer answered the
question directly: usage is at your own risk. An earlier version of this project's adapter said
otherwise and set `commercial: true`; both are corrected. This is the same legal position as the
Gym visual set, with fewer pictures and no animation.

**On the APK specifically.** The native build does not copy the artwork onto anything of ours:
it hotlinks jsDelivr's mirror of a third party's GitHub repository (`apps/client/.env.mobile`).
Gym visual's terms prohibit redistribution and making media "available for use or distribution by
a third party". A licence, if bought, has to cover that shape of use or the mobile build has to
carry its own copy. The hosted instance copies the files onto its own volume at first boot
(`docker-compose.yml`, the `media` service), which is a different shape again.

## What each choice leaves uncovered

The planner list is the one to read. It is short enough that the remedy for it — commissioning
or hand-mapping — is an afternoon's work rather than a project, and it is what makes every
generated programme illustrated.

### wger — the 62 planner picks with no picture

barbell bench press · dumbbell bench press · push-up plus · lever chest press (×2) · smith bench
press · barbell standing wide military press · barbell seated overhead press · handstand push-up ·
dumbbell standing overhead press · dumbbell seated shoulder press · lever shoulder press (×2) ·
barbell bent over row · dumbbell bent over row · inverted row (×2) · lever seated row · pull-up ·
l-pull-up · barbell full squat (back pov) · sissy squat · split squats · weighted sissy squat ·
barbell deadlift · barbell romanian deadlift · low glute bridge on floor · glute bridge march ·
lever deadlift · dumbbell lunge · dumbbell lunge with bicep curl · barbell lunge · band step-up ·
dumbbell lateral raise · cable lateral raise · lever lateral raise · dumbbell biceps curl ·
dumbbell biceps curl squat · barbell curl · cable curl · ez barbell curl · cable pushdown (×2) ·
three bench dip · bench dip on floor · dumbbell lying triceps extension · dumbbell kickback ·
barbell lying triceps extension (×2) · weighted bench dip · lever standing calf raise · barbell
standing calf raise · bodyweight standing calf raise · dumbbell standing calf raise · weighted
front plank · power point plank · front plank with twist · dumbbell rear delt raise · dumbbell
rear delt row · cable rear delt row (×2) · band reverse fly

The five it does cover: push-up, cable seated row, barbell full squat, dumbbell goblet squat and
dumbbell romanian deadlift (by the strict rules; see the worksheet below for what a person could
add). For comparison, the unusable photograph sets cover twelve: dumbbell bench press, barbell
bent over row, inverted row, barbell full squat, split squats, weighted sissy squat, barbell
deadlift, barbell lunge, barbell curl, weighted bench dip, and the barbell and dumbbell standing
calf raises.

### wger — where the library holes are

Of 1,304 uncovered: by equipment, body weight 321, dumbbell 288, cable 154, barbell 149,
leverage machine 81, band 54. By body part, upper arms 291, upper legs 221, back 200, waist 166,
chest 158, shoulders 143. In other words: everywhere, evenly. wger's 274 illustrated exercises
are named the way a European gym-goer names them ("Bench Press", "Bent Over Rowing", "Butterfly")
and our library is named the way ExerciseDB names them ("barbell bench press", "barbell bent over
row", "lever pec deck fly"), and the strict matcher does not bridge that on purpose.

### The photograph sets — where the holes are

Of 1,123 uncovered: body weight 258, dumbbell 255, cable 142, barbell 117, leverage machine 81,
band 53; upper arms 260, upper legs 190, back 175, chest 143, waist 132, shoulders 112. Listed
for completeness only, since neither set can be used.

## The worksheet: what a person could add to wger by hand

`node infra/scripts/media-set.mjs suggest --source wger` prints, for each uncovered planner
pick, up to three wger names that share the most words with it. It is deliberately the generous
matcher the coverage report refuses to be, kept where it can do no harm: nothing in it is
applied, and a pairing becomes real only when somebody with both pictures open writes it into
a set by hand — which is the standard the planner already holds exercise selection to.

45 of the 62 have at least one candidate worth opening. Reading the list, roughly thirty look
right at a glance (bench press, overhead press, bent-over row, seated row, lateral raise,
biceps curl, cable pushdown, triceps extension, calf raise, rear-delt work, glute bridge, split
squat, lunge) and the rest are wrong at a glance ("barbell curl → Barbell Wrist Curl",
"dumbbell biceps curl squat → Dumbbell Side Squat"), which is exactly why the tool does not
apply them. A hand-confirmed wger mapping would plausibly illustrate 35–40 of the 67 planner
picks, all line drawings, none animated. That is an estimate from names, not a measurement; the
measurement is the afternoon with the pictures open.

Seventeen have no candidate at all and would need drawing or licensing whatever else is
decided: push-up plus, handstand push-up, inverted row, pull-up, l-pull-up, sissy squat,
weighted sissy squat, barbell deadlift, lever deadlift, band step-up, three bench dip, bench dip
on floor, dumbbell kickback, weighted bench dip, weighted front plank, power point plank, and
one of the two lever chest presses.

## What is *not* an option

- **A fallback to the current artwork for uncovered exercises.** `media-set.js` treats a set as
  authoritative including about what it omits, and that is preserved: an uncovered exercise
  renders the dumbbell placeholder, never the Gym visual picture. A fallback would make a swap
  look complete while leaving the licence exposure exactly where it was, invisibly.
- **A more generous matcher.** Token-subset matching on this data pairs `archer push up` with
  `push up` and produces 545 "matches", most of them a confident picture of a different
  exercise. A wrong picture is followed; a missing one is forgiven. The matcher is pinned by
  `infra/scripts/media-set.test.mjs` to the two rules it has.
- **Setting `commercial: true` on a set to make `media:check` pass.** The flag is a record of
  what was verified, and the gate exists to fail until that record is true.

## What the decision is

Three shapes, and the trade is the same in each: money against coverage against obligations.

1. **License what ships.** Ask Gym visual (or ExerciseDB) for terms that cover a hosted instance
   *and* a native build that carries the files, from an Iranian entity. Coverage stays 100%
   with animation. Cost unknown until asked; the licence's "one person or organisation" and
   no-redistribution terms are the things to read closely. This is item 1 in
   [NEXT_HUMAN_STEPS.md](NEXT_HUMAN_STEPS.md).
2. **Adopt wger and hand-map the planner picks.** Free, cleanly attributed, share-alike. Buys
   perhaps 35–40 of the 67 planner picks as line drawings after an afternoon's mapping, and
   about 1.5% of the library for browsing. Needs counsel's view on share-alike (question 6 in
   the brief) and an attribution line per image, which the built set carries as `by`.
3. **Commission the planner picks** — 67 illustrations, or 201 to cover every candidate — and
   ship the library without pictures for the rest. Fixed cost, no obligations, and the AI
   feature is fully illustrated on the day the last drawing lands. Combinable with 2.

Whichever it is, the mechanics are the same: `build --source <id> --out <path>` writes a
candidate set, a person edits the mapping, and `media-set.js` exports it. Then `media:check`
passes, which is the only thing that has ever been asked of it.
