/* Fill the retrieval corpus from open-access literature, and refuse everything else.
 *
 *   node infra/scripts/ingest-corpus.mjs status
 *   node infra/scripts/ingest-corpus.mjs check
 *   node infra/scripts/ingest-corpus.mjs ingest --source europepmc --query "resistance training volume"
 *   node infra/scripts/ingest-corpus.mjs ingest --source europepmc --topics --limit 50
 *   node infra/scripts/ingest-corpus.mjs drop --source-id "europepmc:PPR123456"
 *
 * The corpus is **not shipped in this repository and never will be**. It is fetched at deploy
 * time by whoever runs the instance, exactly as the exercise artwork is (`docker-compose.yml`,
 * the `media` service), and for the same reason: this repository does not redistribute other
 * people's work, and a licence somebody else granted is not ours to pass on.
 *
 * ## The licence rule, which is the whole point of this file
 *
 * docs/AI_TIERS.md argues that retrieval moves the copying act from training to ingestion. This
 * is that act, so this is where the rule has to hold. Nothing is stored unless the source
 * declares a licence this script recognises **and** that licence permits commercial use and
 * adaptation. In practice that is CC0, CC-BY and CC-BY-SA and nothing else:
 *
 * - **NC is refused.** A non-commercial licence is precisely wrong for a product with a paid
 *   tier, and it is the most common trap in open-access metadata — a great deal of genuinely
 *   free-to-read work is CC-BY-NC, which is free to read and not free to sell alongside.
 * - **ND is refused.** Chunking a paper and storing a vector of it is at best an argument about
 *   whether a derivative was made, and this is not the file to have that argument in.
 * - **An unrecognised or absent licence string is refused**, rather than assumed to be fine.
 *   That is the same rule the media adapters follow after following Free Exercise DB's claim
 *   upstream and finding nothing behind it.
 *
 * The database enforces the half of this it can: `licence` and `url` are `not null` with
 * non-empty checks in migrations/016_corpus.sql, so a passage with no provenance cannot be
 * written even by a script that forgot. What it cannot check is whether the licence *permits*
 * this, which is what `LICENCES` below is for, and what `check` re-verifies afterwards.
 *
 * ## What this refuses to do
 *
 * Guess. A record with no licence, no abstract, no title or no usable URL is skipped and
 * counted, never patched up with a default. The tally at the end says how many went and how
 * many did not and why, because an ingestion that silently dropped half its input while
 * reporting success is how a corpus ends up quietly covering nothing.
 */
import { db, close } from '@gymyar/db'
import { ensureCorpus, putChunks, deleteSource, corpusStats, corpusAvailable } from '@gymyar/db/corpus.js'
import { embedderFromEnv } from '@gymyar/ai'

/* ------------------------------------------------------------- licences ---- */

/**
 * The licences a passage may be stored under, and the canonical name each is stored as.
 *
 * Keys are matched against the source's own licence string, lowercased and stripped of
 * punctuation, longest first — so `cc by sa` is tested before `cc by` and a share-alike paper is
 * never recorded as plain attribution. Anything not on this list is refused, including the empty
 * string, `unknown`, and the various house spellings of "free to read", which is a statement
 * about price rather than about rights.
 */
export const LICENCES = [
  ['cc by sa', 'CC-BY-SA'],
  ['cc by 4', 'CC-BY-4.0'],
  ['cc by 3', 'CC-BY-3.0'],
  ['cc by', 'CC-BY'],
  ['cc0', 'CC0'],
  ['public domain', 'CC0']
]

/** Terms that disqualify a licence outright, whatever else it says. */
const REFUSED = [' nc', '-nc', 'noncommercial', 'non commercial', ' nd', '-nd', 'noderiv']

/**
 * The canonical licence for a source's own string, or null to refuse it.
 *
 * Exported because the tests for this rule are the tests that matter in this file: everything
 * else here is plumbing around a network call, and this is the part that decides what this
 * product is holding.
 */
export function licenceOf(raw) {
  const s = ` ${String(raw ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `
  if (!s.trim()) return null
  if (REFUSED.some(bad => s.includes(bad.replace(/-/g, ' ')))) return null
  for (const [needle, canonical] of LICENCES) if (s.includes(needle)) return canonical
  return null
}

/* --------------------------------------------------------------- design ---- */

/* Europe PMC's publication types, mapped onto the designs the store ranks by. Ordered strongest
 * first and first-match-wins: a record tagged both "Randomized Controlled Trial" and "Review" is
 * a trial that somebody also filed as a review, and the stronger claim is the true one. */
const DESIGNS = [
  [/meta.?analysis/i, 'meta-analysis'],
  [/systematic.review/i, 'systematic-review'],
  [/randomi[sz]ed.controlled.trial|\brct\b/i, 'rct'],
  [/cross.?over/i, 'crossover'],
  [/clinical trial|controlled trial/i, 'quasi-experimental'],
  [/cohort|longitudinal/i, 'cohort'],
  [/cross.?sectional|survey/i, 'cross-sectional'],
  [/case report|case study/i, 'case-study'],
  [/review/i, 'narrative-review']
]

/** The design a record's own type tags and title describe, or null for "nobody said". */
export function designOf(text) {
  const s = String(text ?? '')
  for (const [re, design] of DESIGNS) if (re.test(s)) return design
  return null
}

/* Only from a phrase that is unambiguously about people. "n = 24" in an abstract is as likely to
 * be a number of sets as a number of lifters, and a sample size read wrongly does not fail — it
 * silently reweights the ranking, which is worse. Absent is a supported answer. */
export function sampleSizeOf(text) {
  const m = String(text ?? '').match(/\b(\d{1,5})\s+(?:healthy\s+)?(?:trained\s+|untrained\s+|resistance.trained\s+)?(?:men|women|participants|subjects|adults|lifters|athletes|volunteers)\b/i)
  if (!m) return null
  const n = Number(m[1])
  return n > 0 && n < 100000 ? n : null
}

/* ---------------------------------------------------------- the sources ---- */

/* The questions this product actually has to answer, which is what a corpus for it should cover.
 * The planner prescribes thirteen movement patterns and the review reports on stalls, volume,
 * attendance and effort — so these are the topics a coaching note might be informed by, and a
 * corpus of everything else is storage somebody pays for and nothing ever retrieves. */
const TOPICS = [
  'resistance training volume hypertrophy',
  'resistance training frequency strength',
  'progressive overload load progression',
  'training to failure repetitions in reserve',
  'deload tapering strength training',
  'rest interval duration hypertrophy',
  'periodisation strength training',
  'detraining retraining muscle',
  'sleep and athletic recovery',
  'protein intake resistance training',
  'body composition energy deficit resistance training',
  'delayed onset muscle soreness recovery',
  'rating of perceived exertion resistance training',
  'eccentric training adaptation',
  'range of motion hypertrophy'
]

const SOURCES = {
  /* Europe PMC: one REST endpoint over PubMed, PMC and the preprint servers, with a `license`
   * field and an open-access flag on every record. Chosen over the NCBI OA service because the
   * licence arrives *with* the search result rather than in a second lookup per article, which
   * is the difference between one request per fifty papers and fifty-one.
   *
   * Abstracts, not full text. The abstract is where the finding is, it is the part with the
   * clearest redistribution position, and it keeps the corpus small enough to embed on the
   * hardware an instance already has. docs/AI_TIERS.md §"The corpus" argues both.
   */
  europepmc: {
    id: 'europepmc',
    name: 'Europe PMC',
    url: 'https://europepmc.org/',
    async fetchPage({ query, pageSize = 100, cursor = '*', fetchImpl = fetch }) {
      const u = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search')
      // `OPEN_ACCESS:y` narrows at the server, so a page of a hundred is a hundred candidates
      // rather than a hundred records of which four are usable.
      u.searchParams.set('query', `${query} AND OPEN_ACCESS:y`)
      u.searchParams.set('format', 'json')
      u.searchParams.set('resultType', 'core')
      u.searchParams.set('pageSize', String(pageSize))
      u.searchParams.set('cursorMark', cursor)
      const r = await fetchImpl(u, { headers: { accept: 'application/json' } })
      if (!r.ok) throw new Error(`europepmc: HTTP ${r.status}`)
      const body = await r.json()
      return { records: body?.resultList?.result ?? [], cursor: body?.nextCursorMark ?? null }
    },
    /** One API record → what the store needs, or a reason it cannot be stored. */
    toDocument(rec) {
      const licence = licenceOf(rec.license)
      if (!licence) return { skip: 'licence', detail: rec.license || 'none stated' }
      const text = String(rec.abstractText ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (text.length < 200) return { skip: 'no abstract' }
      const id = rec.id || rec.pmid || rec.pmcid
      if (!id || !rec.source) return { skip: 'no id' }
      const types = [rec.pubTypeList?.pubType].flat().filter(Boolean).join(' ')
      return {
        sourceId: `europepmc:${rec.source}:${id}`,
        title: String(rec.title ?? '').replace(/\s+/g, ' ').trim() || '(untitled)',
        url: `https://europepmc.org/article/${rec.source}/${id}`,
        licence,
        author: rec.authorString ? String(rec.authorString).slice(0, 300) : null,
        // Source PPR is Europe PMC's preprint corpus. Recorded rather than excluded — the store
        // discounts it in ranking and the reader is told, which is the honest handling of work
        // that is real and unchecked.
        peerReviewed: rec.source !== 'PPR',
        design: designOf(`${types} ${rec.title ?? ''}`),
        sampleSize: sampleSizeOf(text),
        publishedOn: /^\d{4}$/.test(String(rec.pubYear ?? '')) ? `${rec.pubYear}-01-01` : null,
        text
      }
    }
  }
}

/* ------------------------------------------------------------- chunking ---- */

/* Abstracts are one or two chunks; the overlap is there so a sentence spanning a boundary is
 * still findable from either side. Split on sentence ends rather than mid-word, because a
 * passage that begins half way through a clause reads as damaged when it is quoted back. */
export function chunk(text, { size = 1200, overlap = 150 } = {}) {
  const clean = String(text).replace(/\s+/g, ' ').trim()
  if (clean.length <= size) return clean ? [clean] : []
  const out = []
  let i = 0
  while (i < clean.length) {
    let end = Math.min(clean.length, i + size)
    if (end < clean.length) {
      const stop = clean.lastIndexOf('. ', end)
      if (stop > i + size / 2) end = stop + 1
    }
    out.push(clean.slice(i, end).trim())
    if (end >= clean.length) break
    i = Math.max(end - overlap, i + 1)
  }
  return out.filter(Boolean)
}

/* ------------------------------------------------------------------ cli ---- */

const arg = name => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : process.argv[i + 1]
}
const flag = name => process.argv.includes(`--${name}`)

async function main() {
  const cmd = process.argv[2] || 'status'

  if (cmd === 'status') {
    const stats = await corpusStats()
    const embedder = embedderFromEnv()
    console.log(`corpus:    ${stats.available ? 'present' : 'not on this instance (no pgvector — see docs/AI_TIERS.md)'}`)
    console.log(`chunks:    ${stats.chunks} from ${stats.sources} sources`)
    console.log(`models:    ${stats.models.join(', ') || '—'}`)
    console.log(`embedder:  ${embedder.available ? embedder.model : 'not configured (set OLLAMA_MODEL_EMBED)'}`)
    for (const l of stats.licences) console.log(`  ${l.licence.padEnd(12)} ${l.chunks}`)
    if (stats.models.length > 1) {
      console.error('\n✗ this corpus holds more than one embedding model. Searches filter by model, so some of it is unreachable. Re-ingest.')
      process.exit(1)
    }
    if (embedder.available && stats.models.length && !stats.models.includes(embedder.model)) {
      console.error(`\n✗ the corpus was embedded with ${stats.models[0]} and this instance is configured for ${embedder.model}. Nothing will be retrieved until they agree.`)
      process.exit(1)
    }
    return
  }

  if (cmd === 'check') {
    /* The release gate, and the sibling of `media:check`: every licence in the store has to be
     * one this script would accept today. It catches a corpus ingested by an older version of
     * these rules, and a row somebody put there by hand. */
    const stats = await corpusStats()
    if (!stats.available || !stats.chunks) { console.log('corpus is empty — nothing to check.'); return }
    const bad = stats.licences.filter(l => !LICENCES.some(([, canonical]) => canonical === l.licence))
    for (const l of stats.licences) console.log(`  ${l.licence.padEnd(12)} ${l.chunks}`)
    if (bad.length) {
      console.error(`\n✗ ${bad.length} licence(s) in this corpus are not on the allowed list: ${bad.map(b => b.licence).join(', ')}`)
      console.error('  Withdraw those sources before this instance is sold access to.')
      process.exit(1)
    }
    console.log('\n✓ every passage is under a licence that permits commercial use and adaptation.')
    return
  }

  if (cmd === 'drop') {
    const id = arg('source-id')
    if (!id) { console.error('drop needs --source-id'); process.exit(1) }
    console.log(`removed ${await deleteSource(id)} chunks of ${id}`)
    return
  }

  if (cmd !== 'ingest') {
    console.error('usage: ingest-corpus.mjs status | check | ingest --source <id> [--query q | --topics] [--limit n] | drop --source-id <id>')
    process.exit(1)
  }

  /* ---------------------------------------------------------- ingest ---- */
  const src = SOURCES[arg('source') || 'europepmc']
  if (!src) { console.error(`unknown source. known: ${Object.keys(SOURCES).join(', ')}`); process.exit(1) }

  if (!(await ensureCorpus())) {
    console.error('✗ this database has no pgvector, so there is nowhere to put a corpus.')
    console.error('  Run Postgres from an image that has it — docker-compose.yml uses pgvector/pgvector:pg16.')
    process.exit(1)
  }
  const embedder = embedderFromEnv()
  if (!embedder.available) {
    console.error('✗ no embedding model configured. Set OLLAMA_MODEL_EMBED (and OLLAMA_BASE_URL if it is not local).')
    process.exit(1)
  }

  const queries = flag('topics') ? TOPICS : [arg('query')].filter(Boolean)
  if (!queries.length) { console.error('ingest needs --query "..." or --topics'); process.exit(1) }
  const limit = Math.max(1, Number(arg('limit')) || 100)

  const tally = { seen: 0, stored: 0, chunks: 0, skipped: {} }
  const skip = why => { tally.skipped[why] = (tally.skipped[why] || 0) + 1 }
  const seenIds = new Set()

  for (const query of queries) {
    console.log(`\n▸ ${src.name}: ${query}`)
    let cursor = '*'
    let got = 0
    while (got < limit) {
      const { records, cursor: next } = await src.fetchPage({ query, pageSize: Math.min(100, limit - got), cursor })
      if (!records.length) break
      got += records.length

      for (const rec of records) {
        tally.seen++
        const doc = src.toDocument(rec)
        if (doc.skip) { skip(doc.skip); continue }
        // The same paper answers several of the topic queries. Ingesting it twice would be
        // harmless — the upsert is keyed on the source — and embedding it twice would not be.
        if (seenIds.has(doc.sourceId)) { skip('already this run'); continue }
        seenIds.add(doc.sourceId)

        const parts = chunk(doc.text)
        if (!parts.length) { skip('no text'); continue }

        let vectors
        try {
          vectors = await embedder.embed(parts)
        } catch (e) {
          // One paper failing to embed must not end an hour-long run. Counted, named, skipped.
          skip(`embedding failed: ${e.message.slice(0, 60)}`)
          continue
        }

        await putChunks(parts.map((text, i) => ({
          sourceId: doc.sourceId, chunkIndex: i, text, embedding: vectors[i],
          embedModel: embedder.model, title: doc.title, url: doc.url, licence: doc.licence,
          author: doc.author, design: doc.design, sampleSize: doc.sampleSize,
          peerReviewed: doc.peerReviewed, publishedOn: doc.publishedOn
        })))
        tally.stored++
        tally.chunks += parts.length
        process.stdout.write(`  ${String(tally.stored).padStart(4)} ${doc.licence.padEnd(9)} ${doc.title.slice(0, 68)}\n`)
      }

      if (!next || next === cursor) break
      cursor = next
    }
  }

  console.log(`\n  seen ${tally.seen}, stored ${tally.stored} papers as ${tally.chunks} chunks`)
  for (const [why, n] of Object.entries(tally.skipped).sort((a, b) => b[1] - a[1])) {
    console.log(`  skipped ${String(n).padStart(5)}  ${why}`)
  }
  const after = await corpusStats()
  console.log(`\n  corpus now holds ${after.chunks} chunks from ${after.sources} sources`)
  console.log('  run `node infra/scripts/ingest-corpus.mjs check` before selling access to this instance.')
}

// Importable without running, so the rules above can be tested without a database or a network.
if (process.argv[1]?.endsWith('ingest-corpus.mjs')) {
  try { await main() } finally { await close().catch(() => {}) }
}

export { SOURCES, TOPICS, corpusAvailable }
