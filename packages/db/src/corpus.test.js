/* The retrieval corpus, against a real Postgres with a real pgvector.
 *
 * The same argument the S3 driver's tests make about MinIO: the questions here are pgvector's
 * answers rather than ours — what `<=>` returns for two vectors, whether an HNSW index changes
 * which rows come back, whether a `vector(768)` column refuses a 512-dimension array — and a
 * fake would agree with this implementation about exactly the things worth doubting.
 *
 * So this needs a database with the extension. `postgres:16-alpine`, which is what the other db
 * tests run against and what every instance built before migration 016 is running, does not have
 * it — so the whole file skips there rather than pretending, and says how to get one:
 *
 *   docker run -d --name gymyar-vec -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
 *     -e POSTGRES_DB=gymbuddy_test -p 55433:5432 pgvector/pgvector:pg16
 *   CORPUS_TEST_DATABASE_URL=postgres://test:test@127.0.0.1:55433/gymbuddy_test npm run test -w @gymyar/db
 *
 * CI sets it, for the reason the storage tests give: skipping there would mean the only place
 * this is ever exercised is a laptop that happens to have the right container running.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { rank } from './corpus.js'

const URL_ = process.env.CORPUS_TEST_DATABASE_URL

/* A vector that is deterministic, normalised-ish, and *steerable*: `at(0)` and `at(0.01)` are
 * almost the same direction and `at(3)` is somewhere else entirely. That is enough to write
 * "this passage is more relevant than that one" without pretending to embed anything. */
const at = seed => Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.01 + seed))

describe.skipIf(!URL_)('the corpus, against a real pgvector', () => {
  let sql, corpus

  beforeAll(async () => {
    sql = postgres(URL_, { onnotice: () => {} })
    // The module reaches for the shared connection by default; every call here passes `sql`
    // explicitly so this file talks to its own database and not to whatever DATABASE_URL says.
    corpus = await import('./corpus.js')
    const { migrate, connect } = await import('./index.js')
    connect(URL_)
    await migrate()
  })
  afterAll(async () => {
    await sql?.end({ timeout: 5 })
    const { close } = await import('./index.js')
    await close()
  })
  beforeEach(async () => { await sql`delete from corpus_chunks` })

  const paper = (over = {}) => ({
    sourceId: 'europepmc:MED:1', chunkIndex: 0, text: 'ten to twenty sets per muscle per week',
    embedding: at(0), embedModel: 'nomic-embed-text', title: 'A paper', url: 'https://europepmc.org/article/MED/1',
    licence: 'CC-BY', author: 'Someone', design: 'rct', sampleSize: 40, peerReviewed: true, ...over
  })

  it('is available once the migration has run', async () => {
    expect(await corpus.corpusAvailable(sql)).toBe(true)
  })

  it('stores a passage and finds it again', async () => {
    await corpus.putChunks([paper()], sql)
    const [hit] = await corpus.search({ embedding: at(0), model: 'nomic-embed-text' }, sql)
    expect(hit.title).toBe('A paper')
    expect(hit.url).toBe('https://europepmc.org/article/MED/1')
    expect(hit.licence).toBe('CC-BY')
    expect(hit.similarity).toBeGreaterThan(0.99)
  })

  it('re-ingesting a source replaces it rather than duplicating it', async () => {
    await corpus.putChunks([paper()], sql)
    await corpus.putChunks([paper({ text: 'revised wording', title: 'A paper, v2' })], sql)
    const hits = await corpus.search({ embedding: at(0), model: 'nomic-embed-text' }, sql)
    expect(hits).toHaveLength(1)
    expect(hits[0].title).toBe('A paper, v2')
  })

  it('withdraws a source completely, and leaves the others', async () => {
    await corpus.putChunks([
      paper({ sourceId: 'a', chunkIndex: 0 }), paper({ sourceId: 'a', chunkIndex: 1 }),
      paper({ sourceId: 'b', chunkIndex: 0 })
    ], sql)
    expect(await corpus.deleteSource('a', sql)).toBe(2)
    const left = await corpus.search({ embedding: at(0), model: 'nomic-embed-text' }, sql)
    expect(left.map(r => r.source_id)).toEqual(['b'])
  })

  it('returns nothing for a different embedding model rather than nonsense', async () => {
    // Two models' vectors are not comparable. Empty is the only honest answer; the alternative
    // is cosine over unrelated spaces, which produces confident results that mean nothing.
    await corpus.putChunks([paper()], sql)
    expect(await corpus.search({ embedding: at(0), model: 'mxbai-embed-large' }, sql)).toEqual([])
  })

  it('refuses a passage with no licence, in the database rather than in a script', async () => {
    // The rule in docs/AI_TIERS.md is only worth something if an ingestion script cannot forget
    // it. This is that rule as a constraint.
    await expect(corpus.putChunks([paper({ licence: '' })], sql)).rejects.toThrow()
    await expect(corpus.putChunks([paper({ url: 'not-a-url' })], sql)).rejects.toThrow()
  })

  it('refuses a vector of the wrong size', async () => {
    await expect(corpus.putChunks([paper({ embedding: [1, 2, 3] })], sql)).rejects.toThrow()
  })

  it('puts the stronger study first when both are equally relevant', async () => {
    /* The failure this exists to prevent, in one assertion: identical text, identical vector, so
     * cosine cannot separate them and whichever was inserted first would win a similarity-only
     * ordering. A twelve-person case study must not be what a coach is shown. */
    await corpus.putChunks([
      paper({ sourceId: 'case', title: 'One lifter', design: 'case-study', sampleSize: 1, peerReviewed: false }),
      paper({ sourceId: 'meta', title: 'Forty trials', design: 'meta-analysis', sampleSize: 900, peerReviewed: true })
    ], sql)
    const hits = await corpus.search({ embedding: at(0), model: 'nomic-embed-text' }, sql)
    expect(hits.map(h => h.title)).toEqual(['Forty trials', 'One lifter'])
  })

  it('does not let quality promote a passage that is not about the question', async () => {
    // Ranking tempers relevance; it does not replace it. A meta-analysis of something else is
    // still a citation about something else.
    await corpus.putChunks([
      paper({ sourceId: 'far', title: 'Meta-analysis of nothing to do with it', embedding: at(3), design: 'meta-analysis', sampleSize: 900 }),
      paper({ sourceId: 'near', title: 'A small study of exactly this', design: 'case-study', sampleSize: 8 })
    ], sql)
    const hits = await corpus.search({ embedding: at(0), model: 'nomic-embed-text', minSimilarity: 0.9 }, sql)
    expect(hits.map(h => h.title)).toEqual(['A small study of exactly this'])
  })

  it('reports what it holds, including more than one model — which is a misconfiguration', async () => {
    await corpus.putChunks([paper(), paper({ sourceId: 'other', embedModel: 'mxbai-embed-large' })], sql)
    const stats = await corpus.corpusStats(sql)
    expect(stats.chunks).toBe(2)
    expect(stats.sources).toBe(2)
    expect(stats.models.sort()).toEqual(['mxbai-embed-large', 'nomic-embed-text'])
    expect(stats.licences).toEqual([{ licence: 'CC-BY', chunks: 2 }])
  })
})

/* Ranking is arithmetic and needs no database, so it is tested where it will always run rather
 * than behind the skip above. The weights themselves are a starting point and are not asserted;
 * what is asserted is the ordering they exist to produce, which is what would still have to hold
 * if somebody retuned every one of them. */
describe('how a passage is scored', () => {
  const row = (over = {}) => ({ similarity: 0.8, design: 'rct', sample_size: 40, peer_reviewed: true, ...over })

  it('ranks study designs in the order the field would', () => {
    const order = ['meta-analysis', 'systematic-review', 'rct', 'crossover', 'cohort', 'case-study']
    const scores = order.map(design => rank(row({ design })))
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })

  it('treats an unrecorded design as middling, not as worthless', () => {
    // "Nobody wrote it down" is an ingestion gap far more often than it is a bad paper, and
    // burying every such passage would bury most of a real corpus.
    expect(rank(row({ design: null }))).toBeGreaterThan(rank(row({ design: 'case-study' })))
    expect(rank(row({ design: null }))).toBeLessThan(rank(row({ design: 'rct' })))
  })

  it('discounts a preprint without dismissing it', () => {
    expect(rank(row({ peer_reviewed: false }))).toBeLessThan(rank(row({ peer_reviewed: true })))
    expect(rank(row({ peer_reviewed: false, design: 'meta-analysis' })))
      .toBeGreaterThan(rank(row({ peer_reviewed: true, design: 'case-study' })))
  })

  it('prefers a bigger sample, gently', () => {
    expect(rank(row({ sample_size: 400 }))).toBeGreaterThan(rank(row({ sample_size: 12 })))
    // Gently: no sample size rescues a weak design against a strong one.
    expect(rank(row({ sample_size: 100000, design: 'case-study' })))
      .toBeLessThan(rank(row({ sample_size: 8, design: 'meta-analysis' })))
  })

  it('never lets quality outweigh relevance outright', () => {
    // A perfect match from a case study beats a distant meta-analysis. Similarity is the term
    // that varies most, and it should be.
    expect(rank(row({ similarity: 0.95, design: 'case-study' })))
      .toBeGreaterThan(rank(row({ similarity: 0.3, design: 'meta-analysis' })))
  })
})
