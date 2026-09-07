/* The join between the language layer and the retrieval store.
 *
 * `packages/ai` knows how to put passages in a prompt and knows nothing about where they came
 * from; `packages/db` knows how to find them and nothing about what they are for. Neither
 * imports the other, and this file is the one place that holds both — the same shape as
 * `entitlement.js`, which is where the domain's rules meet the database's rows.
 *
 * There is a second reason it is here rather than in either package, and it is the one that
 * matters: `packages/domain` must never be able to reach the store (docs/AI_TIERS.md,
 * constraint 3 — the literature may inform the language and may never touch a number), and
 * `node-contract.test.js` asserts it cannot. Keeping the bridge in the API is what makes that
 * assertion easy to keep true.
 */
import { search, corpusStats } from '@gymyar/db/corpus.js'
import { embedderFromEnv } from '@gymyar/ai'

/* How many passages a note is allowed to be informed by.
 *
 * Small on purpose. The model is writing at most three sentences, and a prompt carrying a dozen
 * abstracts produces a paragraph that reads like a literature review rather than like a coach —
 * which is the failure mode of every retrieval feature that measures itself by recall. Four is
 * enough for the ranking in corpus.js to have made a choice worth making.
 */
const PASSAGES = 4

/**
 * A `retrieve` for `createAI`, or null when this instance cannot do it.
 *
 * Null rather than a function returning nothing, because `ai.retrieval` is built from it and a
 * screen offering "with sources" needs to know before it offers. Two ways to be null: no
 * embedding model configured, or no pgvector — and `corpusStatus()` below tells an operator
 * which, because "it is not citing anything" has two very different fixes.
 */
export function retriever({ embedder = embedderFromEnv() } = {}) {
  if (!embedder.available) return null

  return async query => {
    const text = String(query ?? '').trim()
    if (!text) return []
    const [embedding] = await embedder.embed([text])
    const hits = await search({ embedding, model: embedder.model, limit: PASSAGES })
    /* Renamed on the way out. The store speaks Postgres — `peer_reviewed`, `source_id` — and the
     * AI package speaks the shape it puts in a prompt; translating here keeps the column names
     * of one out of the other, and means a schema change is not a change to a prompt. */
    return hits.map(h => ({
      text: h.text,
      title: h.title,
      url: h.url,
      licence: h.licence,
      author: h.author,
      design: h.design,
      peerReviewed: h.peer_reviewed
    }))
  }
}

/**
 * Whether this instance could cite anything, and why not when it cannot.
 *
 * Both halves have to be true and they fail for unrelated reasons, so a single boolean would
 * send an operator to the wrong place half the time. Reported through `/api/ai/status`.
 */
export async function corpusStatus({ embedder = embedderFromEnv() } = {}) {
  const stats = await corpusStats()
  const model = embedder.available ? embedder.model : null
  return {
    // The one an operator acts on: is anything actually retrievable right now.
    ready: !!(stats.available && model && stats.chunks > 0 && stats.models.includes(model)),
    store: stats.available,
    embedder: model,
    chunks: stats.chunks,
    sources: stats.sources,
    /* The failure that looks like an empty corpus and is not: embeddings from two models are not
     * comparable, so a store filled with one model's vectors returns nothing at all to an
     * instance configured for another. Named here because no amount of staring at the ingestion
     * log explains it. */
    modelMismatch: !!(model && stats.models.length && !stats.models.includes(model)),
    licences: stats.licences
  }
}
