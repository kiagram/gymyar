/* The embedder, against a fake server rather than a real one.
 *
 * Unlike the chat providers, there is nothing interesting about *what* an embedding model says —
 * a vector of 768 floats is a vector of 768 floats, and asserting on its contents would be
 * asserting on a model's weights. What is worth testing is everything around it, and all of it
 * is a failure that produces a corpus which looks fine and retrieves nonsense: a batch coming
 * back in the wrong order, a short batch, a model of the wrong size.
 */
import { describe, it, expect } from 'vitest'
import { openAICompatEmbedder, embedderFromEnv, nullEmbedder, EMBED_DIM } from './embed.js'

const vector = (fill = 0.1) => Array.from({ length: EMBED_DIM }, () => fill)
const ok = body => async () => ({ ok: true, json: async () => body })

describe('the embedder', () => {
  it('sends one request for a whole batch', async () => {
    let sent = null
    const e = openAICompatEmbedder({
      model: 'nomic-embed-text',
      fetchImpl: async (url, init) => {
        sent = { url: String(url), body: JSON.parse(init.body) }
        return { ok: true, json: async () => ({ data: [{ index: 0, embedding: vector() }, { index: 1, embedding: vector(0.2) }] }) }
      }
    })
    const out = await e.embed(['one', 'two'])
    expect(out).toHaveLength(2)
    expect(sent.url).toBe('http://127.0.0.1:11434/v1/embeddings')
    expect(sent.body.input).toEqual(['one', 'two'])
  })

  it('puts the vectors back in the order they were asked for', async () => {
    /* The one that would never be noticed. The OpenAI shape carries `index` precisely because a
     * server may answer out of order, and a transposed batch attaches every passage's provenance
     * to a different passage's vector — a corpus that is wrong in a way no search result looks
     * wrong. */
    const e = openAICompatEmbedder({
      model: 'm',
      fetchImpl: ok({ data: [{ index: 1, embedding: vector(0.2) }, { index: 0, embedding: vector(0.1) }] })
    })
    const [first, second] = await e.embed(['a', 'b'])
    expect(first[0]).toBe(0.1)
    expect(second[0]).toBe(0.2)
  })

  it('refuses a batch that came back short', async () => {
    const e = openAICompatEmbedder({ model: 'm', fetchImpl: ok({ data: [{ index: 0, embedding: vector() }] }) })
    await expect(e.embed(['a', 'b'])).rejects.toThrow(/asked for 2 vectors and got 1/)
  })

  it('refuses a model whose vectors are the wrong size, and says what to do', async () => {
    // Caught on the first vector rather than by the database an hour into an ingestion run.
    const e = openAICompatEmbedder({ model: 'wrong-size', fetchImpl: ok({ data: [{ index: 0, embedding: [1, 2, 3] }] }) })
    await expect(e.embed(['a'])).rejects.toThrow(/returns 3 dimensions and this corpus stores 768/)
  })

  it('reports an HTTP failure rather than returning nothing', async () => {
    const e = openAICompatEmbedder({ model: 'm', fetchImpl: async () => ({ ok: false, status: 500 }) })
    await expect(e.embed(['a'])).rejects.toThrow(/HTTP 500/)
  })

  it('takes a bare string as a batch of one', async () => {
    const e = openAICompatEmbedder({ model: 'm', fetchImpl: ok({ data: [{ index: 0, embedding: vector() }] }) })
    expect(await e.embed('just this')).toHaveLength(1)
  })

  it('asks nobody anything for an empty batch', async () => {
    let called = false
    const e = openAICompatEmbedder({ model: 'm', fetchImpl: async () => { called = true } })
    expect(await e.embed([])).toEqual([])
    expect(called).toBe(false)
  })
})

describe('what the environment configures', () => {
  it('is nothing without a model named', () => {
    expect(embedderFromEnv({}).available).toBe(false)
    expect(embedderFromEnv({})).toBe(nullEmbedder)
    expect(openAICompatEmbedder({ model: null })).toBe(nullEmbedder)
  })

  it('reads the local variables and only those', () => {
    /* Deliberately no hosted branch. Setting OPENAI_API_KEY buys the prose model; it does not
     * quietly start posting several thousand paragraphs of somebody else's literature to a
     * vendor, and it does not make the paid tier depend on an API that may not be purchasable
     * from where this product is operated. See the header of embed.js. */
    expect(embedderFromEnv({ OPENAI_API_KEY: 'sk-x' }).available).toBe(false)
    const e = embedderFromEnv({ OLLAMA_MODEL_EMBED: 'nomic-embed-text' })
    expect(e.available).toBe(true)
    expect(e.model).toBe('nomic-embed-text')
  })

  it('answers nothing, harmlessly, when it is the null one', async () => {
    expect(await nullEmbedder.embed(['anything'])).toBeNull()
  })
})
