/* Measure a candidate replacement for the exercise artwork, and write it out as a media set.
 *
 *   node infra/scripts/media-set.mjs check
 *   node infra/scripts/media-set.mjs coverage [--source wger] [--all] [--json]
 *   node infra/scripts/media-set.mjs suggest [--source wger]
 *   node infra/scripts/media-set.mjs build --source wger --out <path.js>
 *
 * `check` is the release gate: it fails if the artwork the build would ship is not licensed
 * for something somebody pays for. That is a one-line assertion standing in for a paragraph in
 * README.md that a release has to remember to re-read.
 *
 * `coverage` and `build` answer the question underneath the launch blocker, which is not "is
 * there a free exercise dataset" — there are several — but "how much of *our* movements does
 * it actually depict". And that question has two denominators, because the library is not one
 * thing:
 *
 * - **the library**, 1,324 movements, which is what somebody browsing the exercise list sees;
 * - **what the planner can prescribe**, which is thirteen movement patterns with sixty-odd
 *   named preferences between them — `plannerReach()` in the domain enumerates it. A set that
 *   covers 15% of the library can cover most of a generated programme or none of it, and only
 *   the library number had ever been measured.
 *
 * Both are reported for every source, side by side, and the uncovered planner picks are listed
 * by name rather than counted, because sixty names is a list a person can read and act on.
 *
 * ## Why the matching is deliberately stupid
 *
 * Our library is keyed by ExerciseDB ids; every candidate is keyed by its own names. So a swap
 * is a name-matching problem, and name matching here is far more dangerous than it looks: a
 * generous matcher will pair `archer push up` with `push up`, and `curl-up` with `palms up
 * barbell wrist curl over a bench`, because every word of the shorter name appears in the
 * longer one. Both were produced by a token-subset matcher on this exact data. The result is
 * not a missing picture, which a reader forgives, but a *confidently wrong* picture of a
 * different exercise, which a reader follows.
 *
 * So only two rules, both of which preserve meaning: identical names once punctuation and case
 * are normalised, and identical *sets of words*, which catches `bench press barbell` against
 * `barbell bench press` and nothing else. Everything beyond that is left uncovered and
 * reported as such, because the honest form of the remainder is a list for a human, not a
 * number that flatters the tool.
 *
 * ## What a source adapter owes
 *
 * A `{ id, name, url, licence, commercial, attribution, load() }`, where `load` returns
 * `[{ name, img, gif }]` with absolute URLs. Optional on an entry: `video` (footage the app
 * cannot play in an `<img>` — counted, never put in the `gif` slot), `by` and `licence` (the
 * record's own author and licence, carried into the built set so that a per-image attribution
 * obligation can actually be discharged), and `alias: true` on a second name for the same
 * artwork.
 *
 * `commercial` is the adapter author's reading of what actually governs the files, and it is
 * the field worth arguing with. The rule this file follows: a licence claim is what survives
 * following it upstream, not what a README prints. Two of the three sources below fail that
 * test, and the comments on each record what was found and where.
 */
import { writeFile } from 'node:fs/promises'
import { EXDB, mediaSet, plannerReach } from '@gymyar/domain'

const FEDB = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main'
const WRKOUT = 'https://raw.githubusercontent.com/wrkout/exercises.json/master'
const WGER = 'https://wger.de'

export const SOURCES = {
  'free-exercise-db': {
    id: 'free-exercise-db',
    name: 'Free Exercise DB',
    url: 'https://github.com/yuhonas/free-exercise-db',
    /* The repository is published under the Unlicense. An earlier version of this adapter
     * said the artwork "traces to Everkinetic under CC-BY-SA" and set `commercial: true` on
     * that basis. Following the claim upstream found that it was wrong in a way that matters.
     *
     * The images are not line drawings — Everkinetic's are, and wger holds 83 of those
     * credited to Everkinetic under CC-BY-SA 3.0 — they are studio photographs: the same
     * model, the same red wall and power rack, in branded kit, across the whole set. The data
     * is a restructuring of wrkout/exercises.json, whose exercise text and photographs match
     * a large commercial exercise guide's; that repository has no licence file at all and an
     * open issue (#305) asking where the images came from. And the maintainer of this
     * repository answered the same question directly, in its issue #2: "I actually have no
     * idea where the images are from or if they are royalty free so usage would be at your
     * own risk."
     *
     * So the Unlicense covers the JSON somebody restructured and nothing about the pictures.
     * What is on offer is unattributed photography of unknown ownership, which is the same
     * position as the Gym visual set with less to show for it. `commercial: false`, and the
     * adapter stays because the numbers it produces are still the honest answer to "what
     * would this buy if it *were* licensed" — which is nothing an animation, either. */
    licence: 'unknown — unattributed photographs (repo states Unlicense; maintainer: "no idea where the images are from", issue #2)',
    commercial: false,
    attribution: 'via github.com/yuhonas/free-exercise-db — photographer and rights holder unknown',
    async load() {
      const r = await fetch(`${FEDB}/dist/exercises.json`)
      if (!r.ok) throw new Error(`free-exercise-db: HTTP ${r.status}`)
      /* Two frames per exercise, a start and an end pose, and no animation at all. So `img`
       * is the first and `gif` is null — this source cannot fill the animation the app plays,
       * and a set that quietly put a still frame in the GIF slot would make that invisible. */
      return (await r.json()).filter(e => e.images?.length).map(e => ({
        name: e.name,
        img: `${FEDB}/exercises/${e.images[0]}`,
        gif: null
      }))
    }
  },

  'wrkout-exercises-json': {
    id: 'wrkout-exercises-json',
    name: 'wrkout/exercises.json',
    url: 'https://github.com/wrkout/exercises.json',
    /* The upstream of free-exercise-db, and the same files: the fork's ids are this
     * repository's directory names and its `0.jpg` is this repository's `images/0.jpg`. Its
     * README calls itself an "Open Public Domain Exercise Dataset" and points commercial users
     * at a paid product of the same author's. There is no LICENSE file in the tree (the link in
     * the fork's issue #2 is a 404), and no statement anywhere about who took the photographs.
     *
     * Kept as its own adapter for one reason: anybody searching for a free exercise dataset
     * finds this one and its fork within minutes of each other, and a decision table that
     * lists only the fork invites the question "what about the original". The answer is that
     * it is the original of the same problem. `commercial: false`, for the reasons on the
     * adapter above; the coverage it reports is identical by construction. */
    licence: 'unknown — no licence file; README says "public domain"; photographs unattributed',
    commercial: false,
    attribution: 'via github.com/wrkout/exercises.json — photographer and rights holder unknown',
    async load() {
      /* One request for the whole tree rather than 870 for the per-exercise JSON. The names
       * are the directory names with underscores for spaces, which is how the repository
       * formed them in the first place, so this is the same mapping run backwards. */
      const r = await fetch('https://api.github.com/repos/wrkout/exercises.json/git/trees/master?recursive=1',
        { headers: { accept: 'application/vnd.github+json' } })
      if (!r.ok) throw new Error(`wrkout/exercises.json: HTTP ${r.status}`)
      const { tree, truncated } = await r.json()
      if (truncated) throw new Error('wrkout/exercises.json: the tree listing was truncated')
      const dirs = new Set(tree.map(t => t.path.match(/^exercises\/([^/]+)\/images\/0\.jpg$/)?.[1]).filter(Boolean))
      return [...dirs].map(dir => ({
        name: dir.replace(/_/g, ' '),
        img: `${WRKOUT}/exercises/${dir}/images/0.jpg`,
        gif: null
      }))
    }
  },

  wger: {
    id: 'wger',
    name: 'wger',
    url: 'https://wger.de',
    /* The one source here whose licence claim survives being followed. wger is an AGPL
     * fitness manager whose exercise database is community-contributed, and every image,
     * video and translation carries its own licence id and author in the API — the platform's
     * README says exactly that: "Exercise/Ingredient Data: Creative Commons (see individual
     * entries)". At the time of writing all 374 images are CC-BY-SA 3.0 (88) or 4.0 (286),
     * 83 of them the Everkinetic line drawings that free-exercise-db was wrongly said to
     * contain, and the 78 videos are all CC-BY-SA 4.0.
     *
     * What was verified: the licence each record declares, that every licence the platform
     * offers (CC-BY-SA 3/4, CC-BY 4, CC0, ODbL) permits commercial use, and that the platform
     * publishes the data under those terms. What cannot be verified from here: that each of
     * some sixty uploaders owned what they uploaded. That is the ordinary position of any
     * user-contributed CC corpus, and it is why `commercial: true` here means "the terms
     * permit it" and not "nobody could ever object" — a distinction for the legal review.
     *
     * Two things are excluded on purpose. Images flagged `is_ai_generated` (43 of the 374),
     * because a CC licence is a grant by an author, and whether there is an author to grant
     * one is exactly what is unsettled about generated pictures. And any record whose licence
     * id is not in the list above, which today is none of them — the filter is a guard against
     * the platform adding a licence this adapter has not read.
     *
     * The obligations are real and per record: BY means naming the author of each image, and
     * SA means the artwork and any adaptation of it stays CC-BY-SA. `by` and `licence` are
     * carried through to the built set for the first; the second is a question for counsel
     * before this set is activated, not for this script. */
    licence: 'CC-BY-SA 3.0 / 4.0, per record (each image carries its own licence id and author)',
    commercial: true,
    attribution: 'Exercise illustrations from wger.de under CC BY-SA 3.0/4.0 — author per image, see `by` on each entry',
    async load() {
      /* All at once: 871 exercises and 374 images fit in one page each, and the API honours
       * the limit. Language 2 is English, the only language our library's names are in. */
      const get = async path => {
        const r = await fetch(`${WGER}/api/v2/${path}`, { headers: { accept: 'application/json' } })
        if (!r.ok) throw new Error(`wger ${path}: HTTP ${r.status}`)
        return (await r.json()).results
      }
      const [info, images] = await Promise.all([
        get('exerciseinfo/?limit=1000&format=json'),
        get('exerciseimage/?limit=1000&format=json')
      ])
      const LICENCES = { 1: 'CC-BY-SA 3.0', 2: 'CC-BY-SA 4.0', 3: 'CC0 1.0', 4: 'CC-BY 4.0', 5: 'ODbL 1.0' }

      // One image per exercise: the one the platform marks as main, else the first. Anything
      // generated or under a licence this adapter has not read is left out, not substituted.
      const imageFor = new Map()
      for (const i of images) {
        if (i.is_ai_generated || !LICENCES[i.license]) continue
        const cur = imageFor.get(i.exercise)
        if (!cur || (i.is_main && !cur.is_main)) imageFor.set(i.exercise, i)
      }

      const entries = [], aliases = []
      for (const e of info) {
        const en = e.translations?.find(t => t.language === 2)
        const img = imageFor.get(e.id)
        if (!en?.name || !img) continue
        const entry = {
          name: en.name,
          img: img.image,
          gif: null,
          video: e.videos?.[0]?.video || null,
          by: img.license_author || null,
          licence: LICENCES[img.license]
        }
        entries.push(entry)
        // A second name a person wrote down for the same movement is still a name, not a
        // guess — but it ranks after every primary name, so it can never shadow one.
        for (const a of en.aliases || []) if (a?.alias) aliases.push({ ...entry, name: a.alias, alias: true })
      }
      return [...entries, ...aliases]
    }
  }
}

const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
const wordKey = s => [...new Set(norm(s).split(' '))].sort().join(' ')

/**
 * Match a library against a source's entries by name, conservatively. See the header.
 *
 * `library` defaults to the whole dataset; passing a subset — the planner's reach — is how
 * the second denominator is measured with exactly the same rules as the first.
 */
export function match(theirs, library = EXDB) {
  const byName = new Map(), byWords = new Map()
  for (const e of theirs) {
    if (!byName.has(norm(e.name))) byName.set(norm(e.name), e)
    // First wins: two of their names that normalise to the same word set are ambiguous, and
    // picking the later one silently would be a coin toss dressed as a lookup.
    if (!byWords.has(wordKey(e.name))) byWords.set(wordKey(e.name), e)
  }
  const media = {}, exact = [], reordered = [], uncovered = []
  for (const e of library) {
    const hit = byName.get(norm(e.n))
    const loose = hit || byWords.get(wordKey(e.n))
    if (!loose) { uncovered.push(e); continue }
    ;(hit ? exact : reordered).push(e)
    media[e.id] = {
      img: loose.img, gif: loose.gif,
      ...(loose.video ? { video: loose.video } : {}),
      ...(loose.by ? { by: loose.by } : {}),
      ...(loose.licence ? { licence: loose.licence } : {})
    }
  }
  return { media, exact, reordered, uncovered }
}

/** The same match, summarised against every denominator that matters. */
export function measure(theirs) {
  const reach = plannerReach()
  const tally = library => {
    const m = match(theirs, library)
    const vals = Object.values(m.media)
    return {
      n: library.length,
      exact: m.exact.length,
      reordered: m.reordered.length,
      covered: m.exact.length + m.reordered.length,
      uncovered: m.uncovered,
      animated: vals.filter(v => v.gif).length,
      video: vals.filter(v => v.video).length,
      media: m.media
    }
  }
  return {
    library: tally(EXDB),
    picks: tally(reach.picks),
    candidates: tally(reach.candidates),
    reach: { patterns: reach.patterns, preferences: reach.preferences }
  }
}

function report(src, r) {
  const col = (x, n) => `${String(x).padStart(5)}  ${(x / n * 100).toFixed(1).padStart(5)}%`
  const row = (label, f) => console.log(
    `  ${label.padEnd(18)} ${col(f(r.library), r.library.n)}   ${col(f(r.picks), r.picks.n)}   ${col(f(r.candidates), r.candidates.n)}`)
  console.log(`\n  ${src.name} — ${src.licence}`)
  console.log(`  ${src.url}`)
  console.log(`  commercial: ${src.commercial}\n`)
  console.log(`  ${''.padEnd(18)} ${'library'.padStart(13)}   ${'planner picks'.padStart(13)}   ${'planner cands'.padStart(13)}`)
  console.log(`  ${'of'.padEnd(18)} ${String(r.library.n).padStart(13)}   ${String(r.picks.n).padStart(13)}   ${String(r.candidates.n).padStart(13)}`)
  row('exact name match', t => t.exact)
  row('same words', t => t.reordered)
  row('── covered', t => t.covered)
  row('uncovered', t => t.uncovered.length)
  row('with an animation', t => t.animated)
  row('with a video', t => t.video)

  // Where the holes are, because "half the library" and "half the library, all of it the
  // barbell work" are different problems with different answers.
  const by = f => Object.entries(r.library.uncovered.reduce((a, e) => (a[e[f]] = (a[e[f]] || 0) + 1, a), {}))
    .sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ')
  console.log(`\n  library uncovered by equipment   ${by('eq')}`)
  console.log(`  library uncovered by body part   ${by('bp')}`)
  // The planner list in full: it is short enough to read, and it is the list somebody would
  // commission or draw by hand to make every generated programme illustrated.
  console.log(`\n  planner picks uncovered (${r.picks.uncovered.length}):`)
  console.log(`    ${r.picks.uncovered.map(e => e.n).join(' · ') || '—'}\n`)
}

const serialise = (src, media) => `/* Generated by infra/scripts/media-set.mjs — do not hand-edit.
 *
 * A candidate media set. Nothing uses this until media-set.js exports it as MEDIA_SET, which
 * is a deliberate manual step: activating a set is a licence decision, not a build artifact.
 *
 * Source:      ${src.name} <${src.url}>
 * Licence:     ${src.licence}
 * Coverage:    ${Object.keys(media).length} of ${EXDB.length} exercises
 * Generated:   ${new Date().toISOString().slice(0, 10)}
 *
 * Entries may carry "by" and "licence": the author and terms of that one image, for a set
 * whose attribution obligation is per record. "video" is footage the app does not play.
 */
export const MEDIA_SET = {
  id: ${JSON.stringify(src.id)},
  name: ${JSON.stringify(src.name)},
  url: ${JSON.stringify(src.url)},
  licence: ${JSON.stringify(src.licence)},
  commercial: ${src.commercial},
  attribution: ${JSON.stringify(src.attribution)},
  media: ${JSON.stringify(media, null, 2).replace(/\n/g, '\n  ')}
}
`

const strip = t => ({ ...t, uncovered: t.uncovered.map(e => e.n), media: undefined })

/**
 * For each planner pick the strict rules left uncovered, the source names that share the
 * most words with it — **for a person to confirm, never applied**.
 *
 * This is the generous matcher the header refuses to be, kept where it can do no harm: its
 * output is a worksheet, not a set. The planner's reach is short enough that a human can
 * check every pairing against the two pictures in an afternoon, and a hand-confirmed pairing
 * is a named match written down by a person, which is the standard the planner itself holds
 * exercise selection to.
 */
export function suggest(theirs, { limit = 3 } = {}) {
  const words = s => new Set(norm(s).split(' ').filter(w => w.length > 2))
  const r = match(theirs, plannerReach().picks)
  return r.uncovered.map(e => {
    const ours = words(e.n)
    const scored = theirs
      .filter(t => !t.alias)
      .map(t => {
        const theirs = words(t.name)
        const shared = [...ours].filter(w => theirs.has(w)).length
        return { name: t.name, shared, score: shared / Math.max(ours.size, theirs.size) }
      })
      .filter(s => s.shared >= 2)
      .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
      .slice(0, limit)
    return { ours: e.n, suggestions: scored.map(s => s.name) }
  })
}

async function main() {
  const arg = name => {
    const i = process.argv.indexOf(`--${name}`)
    return i === -1 ? null : process.argv[i + 1]
  }
  const flag = name => process.argv.includes(`--${name}`)
  const cmd = process.argv[2] || 'check'

  if (cmd === 'check') {
    const set = mediaSet()
    console.log(`active media set: ${set.name}`)
    console.log(`  licence:    ${set.licence}`)
    console.log(`  commercial: ${set.commercial}`)
    if (!set.commercial) {
      console.error(`\n✗ ${set.id} is not licensed for a paid deployment.`)
      console.error('  This is the exercise-media launch blocker in README.md, as an exit code.')
      process.exit(1)
    }
    console.log('\n✓ the active artwork may ship in something people pay for.')
  } else if (cmd === 'coverage' || cmd === 'build') {
    const ids = flag('all') ? Object.keys(SOURCES) : [arg('source') || 'wger']
    const unknown = ids.filter(id => !SOURCES[id])
    if (unknown.length) {
      console.error(`unknown source ${unknown.join(', ')}. known: ${Object.keys(SOURCES).join(', ')}`)
      process.exit(1)
    }
    const out = []
    for (const id of ids) {
      const src = SOURCES[id]
      const r = measure(await src.load())
      if (flag('json')) {
        out.push({ source: { id: src.id, name: src.name, url: src.url, licence: src.licence, commercial: src.commercial },
          reach: r.reach, library: strip(r.library), picks: strip(r.picks), candidates: strip(r.candidates) })
      } else {
        report(src, r)
      }
      if (cmd === 'build') {
        const path = arg('out')
        if (!path) { console.error('build needs --out <path.js>'); process.exit(1) }
        await writeFile(path, serialise(src, r.library.media))
        console.log(`  written to ${path} — activate by exporting it from media-set.js\n`)
      }
    }
    if (flag('json')) console.log(JSON.stringify(flag('all') ? out : out[0], null, 2))
  } else if (cmd === 'suggest') {
    const src = SOURCES[arg('source') || 'wger']
    if (!src) { console.error(`unknown source. known: ${Object.keys(SOURCES).join(', ')}`); process.exit(1) }
    const rows = suggest(await src.load())
    console.log(`\n  ${src.name}: possible pictures for the planner picks the strict matcher left uncovered.`)
    console.log('  A worksheet for a person with both pictures open — nothing here is applied.\n')
    for (const row of rows) {
      console.log(`  ${row.ours.padEnd(48)} ${row.suggestions.length ? row.suggestions.join('  |  ') : '—'}`)
    }
    console.log(`\n  ${rows.filter(r => r.suggestions.length).length} of ${rows.length} have a candidate worth looking at.\n`)
  } else {
    console.error('usage: media-set.mjs check | coverage [--source <id>] [--all] [--json] | suggest [--source <id>] | build --source <id> --out <path.js>')
    process.exit(1)
  }
}

// Importable without running: the release suite tests `match` and `measure` against fixtures,
// and a module that executed `check` on import would exit the test runner with the licence
// blocker's status code.
if (process.argv[1]?.endsWith('media-set.mjs')) await main()
