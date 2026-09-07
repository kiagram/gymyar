/* The retrieval corpus: reading and writing published literature, with its provenance attached.
 *
 * The schema and the reasons for it are in migrations/016_corpus.sql; the product argument is in
 * docs/AI_TIERS.md. This file is the access layer, and it owns two things the rest of the
 * codebase should not have to think about: whether the feature exists on this instance at all,
 * and how a retrieved passage is *ranked*.
 *
 * ## Absent rather than broken
 *
 * pgvector is an extension and `postgres:16-alpine` does not carry it, so an instance can
 * legitimately have no corpus table. Every read here answers empty on such an instance and
 * `corpusAvailable()` says so plainly, which is the same shape the vision model already has:
 * with nothing configured the feature is missing rather than degraded, and a screen can ask
 * before it offers a button.
 *
 * ## Ranking, and why it is not just cosine
 *
 * Sports science disagrees with itself and the quality range in it is enormous. A twelve-person
 * crossover trial and a forty-study meta-analysis about the same question embed almost
 * identically, so a store ordered by similarity alone will hand back whichever happened to be
 * phrased more like the query and present it with no hint that it is the weaker paper. That is
 * the same failure the exercise-media matcher refuses to commit — a confidently wrong picture is
 * followed, and so is a confidently wrong citation, with a barbell at the end of it.
 *
 * So similarity picks the candidates and study quality orders them. The weights below are a
 * starting point and are **not** validated against anything; what is tested is the ordering
 * properties they exist to produce, which is the part that would still have to hold if somebody
 * retuned every number here.
 */
import { db } from './index.js'

/* Which designs outrank which, at equal relevance.
 *
 * Read as "how much of a claim's weight survives its study design". A meta-analysis of forty
 * trials is the strongest thing this literature produces and a single case study is the weakest,
 * and an unknown design sits in the middle rather than at the bottom: "nobody recorded it" is
 * usually an ingestion gap rather than evidence of a bad paper, and treating it as the worst
 * case would bury most of any real corpus.
 */
const DESIGN_WEIGHT = {
  'meta-analysis': 1.00,
  'systematic-review': 0.95,
  rct: 0.90,
  crossover: 0.80,
  'quasi-experimental': 0.72,
  cohort: 0.68,
  'cross-sectional': 0.60,
  'narrative-review': 0.50,
  'case-study': 0.40,
  other: 0.55
}
const UNKNOWN_DESIGN = 0.55

/* A preprint is a real finding that nobody has checked yet. Discounted rather than excluded,
 * because in this field the preprint servers carry work that matters and a corpus that refused
 * them would be a year behind — but it is discounted, and `search` returns the flag so the
 * reader is told which one they are looking at. */
const NOT_PEER_REVIEWED = 0.85

/* Sample size, gently. Logarithmic and clamped: the difference between twelve people and two
 * hundred is worth something, the difference between two thousand and four thousand is not worth
 * much, and no amount of sample size should let a cross-sectional survey outrank a meta-analysis
 * of the same question. An unrecorded size is neutral rather than penalised.
 */
const sizeWeight = n =>
  n == null ? 1 : Math.min(1.15, Math.max(0.9, 1 + 0.06 * Math.log10(n / 20)))

/** The score a passage is ordered by: relevance, tempered by how much the paper can bear. */
export function rank(row) {
  const design = DESIGN_WEIGHT[row.design] ?? UNKNOWN_DESIGN
  const peer = row.peer_reviewed ? 1 : NOT_PEER_REVIEWED
  return row.similarity * design * peer * sizeWeight(row.sample_size)
}

/** Is there a corpus on this instance at all? */
export async function corpusAvailable(s = db()) {
  const [r] = await s`select to_regclass('public.corpus_chunks') is not null as ok`
  return r.ok === true
}

/**
 * Create the table if the extension is here and migration 016 skipped it.
 *
 * 016 is conditional, and a migration that has been recorded as applied never runs again — so an
 * instance that moves from `postgres:16-alpine` to an image with pgvector would otherwise have
 * the extension available and no table, forever, with nothing to tell it why. This is the way
 * out, and the ingestion script calls it before it writes anything. Idempotent.
 */
export async function ensureCorpus(s = db()) {
  if (await corpusAvailable(s)) return true
  const [av] = await s`select exists (select 1 from pg_available_extensions where name = 'vector') as ok`
  if (!av.ok) return false
  // The same DDL as the migration, deliberately. Two spellings of one schema is how they drift,
  // so if this ever changes, change it in both — there is a test that they agree.
  await s.unsafe(await migrationBody())
  return corpusAvailable(s)
}

/* Read out of the migration rather than restated here. The alternative is two copies of a table
 * definition that must not disagree, and this file has no way to notice when they do. */
async function migrationBody() {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const path = fileURLToPath(new URL('../migrations/016_corpus.sql', import.meta.url))
  return readFile(path, 'utf8')
}

/** A pgvector literal. Not an array: postgres would send `{1,2}` and the cast would fail. */
const vec = v => JSON.stringify(Array.from(v))

/**
 * Write chunks, replacing any previous version of the same passage.
 *
 * Keyed on `(source_id, chunk_index)`, which is what makes re-running ingestion safe: a source
 * that has been re-fetched overwrites its own rows rather than accumulating a second copy of
 * every paragraph. Nothing here validates the licence — the database does, and it does it in a
 * place an ingestion script cannot forget.
 */
export async function putChunks(rows, s = db()) {
  if (!rows.length) return 0
  let written = 0
  // One statement per row rather than a single multi-row insert: the vector cast needs its own
  // parameter and the ingestion path is bounded by embedding time by three orders of magnitude,
  // so there is nothing here worth the unreadable query.
  for (const r of rows) {
    await s`
      insert into corpus_chunks (
        source_id, chunk_index, text, embedding, embed_model,
        title, url, licence, author, design, sample_size, peer_reviewed, published_on
      ) values (
        ${r.sourceId}, ${r.chunkIndex}, ${r.text}, ${vec(r.embedding)}::vector, ${r.embedModel},
        ${r.title}, ${r.url}, ${r.licence}, ${r.author ?? null}, ${r.design ?? null},
        ${r.sampleSize ?? null}, ${r.peerReviewed ?? false}, ${r.publishedOn ?? null}
      )
      on conflict (source_id, chunk_index) do update set
        text = excluded.text, embedding = excluded.embedding, embed_model = excluded.embed_model,
        title = excluded.title, url = excluded.url, licence = excluded.licence,
        author = excluded.author, design = excluded.design, sample_size = excluded.sample_size,
        peer_reviewed = excluded.peer_reviewed, published_on = excluded.published_on,
        ingested_at = now()`
    written++
  }
  return written
}

/**
 * The passages most worth showing for one embedded query.
 *
 * Two stages, because they want different things. The first is a nearest-neighbour scan ordered
 * by cosine distance, which is what the HNSW index can actually accelerate; the second re-orders
 * those candidates by `rank()`, which the index cannot help with because it is not a distance.
 * Over-fetching is what makes the second stage able to promote a strong paper the first stage
 * ranked fourth — with no over-fetch, quality weighting could only ever reorder what similarity
 * had already chosen, which is most of the point of having it.
 *
 * `model` filters rather than warns. Two models' embeddings are not comparable, so a store
 * holding another model's vectors has to return nothing rather than noise; `corpusStats()` is
 * where an operator finds out that is what happened.
 */
export async function search({ embedding, model, limit = 6, overfetch = 4, minSimilarity = 0.25 }, s = db()) {
  if (!(await corpusAvailable(s))) return []
  const rows = await s`
    select id, source_id, chunk_index, text, title, url, licence, author,
           design, sample_size, peer_reviewed, published_on,
           1 - (embedding <=> ${vec(embedding)}::vector) as similarity
      from corpus_chunks
     where embed_model = ${model}
     order by embedding <=> ${vec(embedding)}::vector
     limit ${Math.max(1, limit * overfetch)}`

  const scored = rows
    .map(r => ({ ...r, similarity: Number(r.similarity), score: rank({ ...r, similarity: Number(r.similarity) }) }))
    // Below this the passage is not about the question and a citation would be decoration.
    .filter(r => r.similarity >= minSimilarity)

  /* One passage per paper, keeping its best.
   *
   * A long abstract is several chunks and they are all about the same thing, so a paper that
   * answers the question well tends to answer it well twice — and the first real corpus proved
   * it, returning "Bench-Press Performed With a Velocity- and Tempo-Based Approach" as two of
   * four results for one query. The reader is being shown a short list of *sources*, not of
   * passages: a citation list with the same paper on it twice reads as carelessness and spends
   * one of only four slots saying nothing new. Deduplicated after scoring rather than in SQL, so
   * the chunk that survives is the one that actually matched best.
   */
  const best = new Map()
  for (const r of scored) {
    const held = best.get(r.source_id)
    if (!held || r.score > held.score) best.set(r.source_id, r)
  }

  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}

/**
 * Withdraw a source, and say how much went.
 *
 * The reason retrieval is a defensible answer where a fine-tune is not: a paper whose licence
 * turns out to be something other than what it claimed leaves in one statement, and what is
 * left behind is a corpus that no longer contains it. Nothing equivalent exists for text that
 * has been through a training run.
 */
export async function deleteSource(sourceId, s = db()) {
  if (!(await corpusAvailable(s))) return 0
  const rows = await s`delete from corpus_chunks where source_id = ${sourceId} returning 1`
  return rows.length
}

/** What is in there, for an operator and for `/api/ai/status`. */
export async function corpusStats(s = db()) {
  if (!(await corpusAvailable(s))) return { available: false, chunks: 0, sources: 0, models: [], licences: [] }
  const [counts] = await s`
    select count(*)::int as chunks, count(distinct source_id)::int as sources from corpus_chunks`
  const models = await s`select distinct embed_model from corpus_chunks order by embed_model`
  const licences = await s`
    select licence, count(*)::int as n from corpus_chunks group by licence order by n desc`
  return {
    available: true,
    chunks: counts.chunks,
    sources: counts.sources,
    models: models.map(r => r.embed_model),
    licences: licences.map(r => ({ licence: r.licence, chunks: r.n }))
  }
}
