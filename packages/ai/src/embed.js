/* Turning text into a vector, on hardware the deployment already owns.
 *
 * The retrieval corpus (docs/AI_TIERS.md §A3) needs an embedding for every passage it stores and
 * one more for every question asked of it. This is where those come from, and the choice that
 * matters is made here rather than in the environment: **there is no hosted branch.**
 *
 * The same argument the vision model already makes, for a different reason. Vision is local
 * because the pictures are somebody's body. This is local because it is the only part of the
 * paid tier that has to work: A4 — a hosted model for the prose — may turn out not to be
 * purchasable at all from where this product is operated, and a retrieval layer that needed a
 * hosted embedding API would inherit exactly that problem and take the corpus down with it. An
 * embedding is also the one model call here that is made thousands of times at ingestion and
 * once per question afterwards, so a per-token price on it is the wrong shape of bill for a
 * feature that is meant to be the cheap half.
 *
 * Spoken to over the OpenAI-compatible `/embeddings` route rather than Ollama's native one, for
 * the same reason `openai-compat.js` exists: it is one code path that Ollama, LM Studio, a
 * llama.cpp server and vLLM all answer, so "run it on your own hardware" does not mean "run
 * exactly the thing we tested".
 */

/* The dimension the corpus column is declared at (`vector(768)` in migrations/016_corpus.sql).
 *
 * Checked here as well as by the database, because the database's version of this error arrives
 * after a few thousand passages have been embedded and reads as a failed cast. Catching it on
 * the first vector turns "your ingestion died an hour in" into "that model does not fit this
 * store", which is the same sentence a few hours earlier. */
export const EMBED_DIM = 768

/** No embedder configured: the corpus is not reachable, and everything else works unchanged. */
export const nullEmbedder = {
  name: 'none',
  model: null,
  available: false,
  async embed() { return null }
}

/**
 * An embedder over any server speaking the OpenAI `/embeddings` shape.
 *
 * `embed` takes an array and returns an array, because ingestion embeds thousands of passages
 * and one request per paragraph is the difference between minutes and an afternoon. A single
 * query is that call with one element in it, which keeps one code path rather than two.
 */
export function openAICompatEmbedder({
  baseUrl = 'http://127.0.0.1:11434/v1',
  model,
  apiKey = null,
  fetchImpl = fetch,
  timeoutMs = 60000
} = {}) {
  if (!model) return nullEmbedder
  const url = `${String(baseUrl).replace(/\/$/, '')}/embeddings`

  return {
    name: 'openai-compat',
    model,
    available: true,
    dim: EMBED_DIM,

    async embed(texts) {
      const input = Array.isArray(texts) ? texts : [texts]
      if (!input.length) return []

      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      let payload
      try {
        const r = await fetchImpl(url, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model, input })
        })
        if (!r.ok) throw new Error(`embeddings: HTTP ${r.status} from ${url}`)
        payload = await r.json()
      } finally {
        clearTimeout(timer)
      }

      /* Ordered by `index` rather than trusted to arrive in order. The OpenAI shape specifies
       * the field precisely because a server is allowed to return them out of order, and a
       * silently transposed batch would attach every passage's provenance to a different
       * passage's vector — which no test of ours would notice and every search would. */
      const data = [...(payload?.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      if (data.length !== input.length) {
        throw new Error(`embeddings: asked for ${input.length} vectors and got ${data.length}`)
      }

      return data.map(d => {
        const v = d?.embedding
        if (!Array.isArray(v)) throw new Error('embeddings: a response carried no embedding')
        if (v.length !== EMBED_DIM) {
          throw new Error(
            `embeddings: ${model} returns ${v.length} dimensions and this corpus stores ${EMBED_DIM}. ` +
            'Use a model of that size, or change the column in migrations/016_corpus.sql and re-ingest — ' +
            'vectors from two models are not comparable, so there is no mixing them.')
        }
        return v
      })
    }
  }
}

/**
 * The embedder this deployment has, or the null one.
 *
 * Deliberately reads only the Ollama variables. Setting `OPENAI_API_KEY` buys the prose model
 * and does not quietly start posting several thousand paragraphs of somebody else's literature
 * to a vendor — that is a separate decision, and one an operator makes by pointing
 * `OLLAMA_BASE_URL` at whatever they want to run it on.
 */
export function embedderFromEnv(env = process.env) {
  const model = env.OLLAMA_MODEL_EMBED
  if (!model) return nullEmbedder
  return openAICompatEmbedder({
    baseUrl: env.OLLAMA_BASE_URL || undefined,
    model
  })
}
