/* Measure a candidate replacement for the exercise artwork, and write it out as a media set.
 *
 *   node infra/scripts/media-set.mjs check
 *   node infra/scripts/media-set.mjs coverage [--source free-exercise-db]
 *   node infra/scripts/media-set.mjs build --source free-exercise-db --out <path.js>
 *
 * `check` is the release gate: it fails if the artwork the build would ship is not licensed
 * for something somebody pays for. That is a one-line assertion standing in for a paragraph in
 * README.md that a release has to remember to re-read.
 *
 * `coverage` and `build` answer the question underneath the launch blocker, which is not "is
 * there a free exercise dataset" — there are several — but "how much of *our* 1,324 movements
 * does it actually depict". The two are very different numbers.
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
 * `[{ name, img, gif }]` with absolute URLs. `commercial` is the adapter author's reading of
 * the source's own licence statement and is the field worth arguing with — see the note on
 * free-exercise-db below, where the repository's stated licence and the provenance of the
 * files in it do not agree.
 */
import { writeFile } from 'node:fs/promises'
import { EXDB, mediaSet } from '@gymyar/domain'

const RAW = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main'

const SOURCES = {
  'free-exercise-db': {
    id: 'free-exercise-db',
    name: 'Free Exercise DB',
    url: 'https://github.com/yuhonas/free-exercise-db',
    /* The repository is published under the Unlicense — public domain — and that claim does
     * not survive following it upstream. Its data comes from Ollie Jennings' exercises.json,
     * whose artwork is Everkinetic's, published under CC-BY-SA. Share-alike with attribution
     * cannot be relicensed into the public domain by a downstream repackager, so what is
     * actually on offer here is CC-BY-SA material with the attribution stripped off.
     *
     * That is recorded rather than acted on. `commercial: true` because CC-BY-SA does permit
     * commercial use — this is a usable set — but `licence` says CC-BY-SA and not Unlicense,
     * and `attribution` credits Everkinetic, because adopting it means complying with the
     * licence that actually governs it rather than the one its README prints. Anyone
     * activating this set is taking on share-alike obligations, which is a question for the
     * legal review already listed as a launch blocker and not for this script. */
    licence: 'CC-BY-SA-4.0 (repo states Unlicense; artwork traces to Everkinetic, CC-BY-SA)',
    commercial: true,
    attribution: 'Exercise artwork © Everkinetic, CC BY-SA 4.0 — via github.com/yuhonas/free-exercise-db',
    async load() {
      const r = await fetch(`${RAW}/dist/exercises.json`)
      if (!r.ok) throw new Error(`free-exercise-db: HTTP ${r.status}`)
      /* Two frames per exercise, a start and an end pose, and no animation at all. So `img`
       * is the first and `gif` is null — this source cannot fill the animation the app plays,
       * and a set that quietly put a still frame in the GIF slot would make that invisible. */
      return (await r.json()).filter(e => e.images?.length).map(e => ({
        name: e.name,
        img: `${RAW}/exercises/${e.images[0]}`,
        gif: null
      }))
    }
  }
}

const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
const wordKey = s => [...new Set(norm(s).split(' '))].sort().join(' ')

/** Match our library against a source's entries by name, conservatively. See the header. */
export function match(theirs) {
  const byName = new Map(), byWords = new Map()
  for (const e of theirs) {
    byName.set(norm(e.name), e)
    // First wins: two of their names that normalise to the same word set are ambiguous, and
    // picking the later one silently would be a coin toss dressed as a lookup.
    if (!byWords.has(wordKey(e.name))) byWords.set(wordKey(e.name), e)
  }
  const media = {}, exact = [], reordered = [], uncovered = []
  for (const e of EXDB) {
    const hit = byName.get(norm(e.n))
    const loose = hit || byWords.get(wordKey(e.n))
    if (!loose) { uncovered.push(e); continue }
    ;(hit ? exact : reordered).push(e)
    media[e.id] = { img: loose.img, gif: loose.gif }
  }
  return { media, exact, reordered, uncovered }
}

function report(src, m) {
  const n = EXDB.length
  const covered = m.exact.length + m.reordered.length
  const pct = x => `${(x / n * 100).toFixed(1)}%`
  console.log(`\n  ${src.name} — ${src.licence}`)
  console.log(`  ${src.url}\n`)
  console.log(`  library            ${n}`)
  console.log(`  exact name match   ${m.exact.length}  ${pct(m.exact.length)}`)
  console.log(`  same words         ${m.reordered.length}  ${pct(m.reordered.length)}`)
  console.log(`  ── covered         ${covered}  ${pct(covered)}`)
  console.log(`  uncovered          ${m.uncovered.length}  ${pct(m.uncovered.length)}`)
  const animated = Object.values(m.media).filter(v => v.gif).length
  console.log(`  with an animation  ${animated}  ${pct(animated)}`)

  // Where the holes are, because "half the library" and "half the library, all of it the
  // barbell work" are different problems with different answers.
  const by = f => Object.entries(m.uncovered.reduce((a, e) => (a[e[f]] = (a[e[f]] || 0) + 1, a), {}))
    .sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ')
  console.log(`\n  uncovered by equipment   ${by('eq')}`)
  console.log(`  uncovered by body part   ${by('bp')}`)
  console.log(`\n  examples   ${m.uncovered.slice(0, 4).map(e => e.n).join(' · ')}\n`)
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

const arg = name => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : process.argv[i + 1]
}
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
  const src = SOURCES[arg('source') || 'free-exercise-db']
  if (!src) {
    console.error(`unknown source. known: ${Object.keys(SOURCES).join(', ')}`)
    process.exit(1)
  }
  const m = match(await src.load())
  report(src, m)
  if (cmd === 'build') {
    const out = arg('out')
    if (!out) { console.error('build needs --out <path.js>'); process.exit(1) }
    await writeFile(out, serialise(src, m.media))
    console.log(`  written to ${out} — activate by exporting it from media-set.js\n`)
  }
} else {
  console.error('usage: media-set.mjs check | coverage | build --out <path.js>')
  process.exit(1)
}
