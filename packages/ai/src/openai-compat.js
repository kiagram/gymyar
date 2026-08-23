/* The OpenAI-compatible adapter — DeepSeek, Ollama, and anything else speaking that shape.
 *
 * One file rather than one per vendor, because the differences that matter are a base URL, a
 * model name and whether the endpoint wants an API key. Ollama serves the same protocol on
 * /v1, so the local failover path and the hosted path are the same code with different config.
 *
 * Structured output has two modes. `tools` forces a function call and is what a good endpoint
 * should do; `json` asks for a JSON object and describes the schema in the system prompt, which
 * is what smaller local models can actually manage. Either is safe here: every field crosses
 * `normaliseBrief` or the deterministic parser before it can affect anything, so a loose mode
 * costs a fallback rather than a bad plan.
 *
 * No SDK. One fetch, in a package whose whole job is to be optional.
 */
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504])

/** Anthropic-shaped schema → an OpenAI function definition. The schemas stay in one shape. */
const toFunction = schema => ({
  type: 'function',
  function: {
    name: schema.name,
    description: schema.description,
    parameters: schema.input_schema
  }
})

/* Local models like to wrap JSON in a markdown fence however plainly you ask them not to. */
function parseLoosely(text) {
  if (!text) return null
  const s = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try { return JSON.parse(s) } catch {}
  // A model that prefaced its answer with a sentence still gave an answer. Take the object.
  const open = s.indexOf('{')
  const close = s.lastIndexOf('}')
  if (open < 0 || close <= open) return null
  try { return JSON.parse(s.slice(open, close + 1)) } catch { return null }
}

export function openAICompatProvider({
  name = 'openai-compat',
  apiKey = null,
  baseUrl,
  model,
  // Ollama has no key and wants none. Everything hosted does.
  requiresKey = true,
  structured = 'tools',
  maxTokens = 1024,
  attempts = 2,
  // Local models on modest hardware are slower than a hosted one by an order of magnitude, so
  // this travels with the provider rather than being one number for every backend.
  timeoutMs = null,
  fetchImpl = globalThis.fetch
} = {}) {
  const unavailable = { name, available: false, async complete() { return null } }
  if (!baseUrl || !model) return unavailable
  if (requiresKey && !apiKey) return unavailable

  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`

  return {
    name,
    available: true,
    model,
    ...(timeoutMs ? { timeoutMs } : {}),

    async complete({ system, input, schema }) {
      const useTools = structured === 'tools'
      const messages = [
        {
          role: 'system',
          content: useTools ? system : `${system}

Answer with a single JSON object and nothing else — no prose, no markdown fence. It must match
this schema:

${JSON.stringify(schema.input_schema, null, 2)}`
        },
        { role: 'user', content: input }
      ]

      const body = {
        model,
        max_tokens: maxTokens,
        messages,
        ...(useTools
          ? { tools: [toFunction(schema)], tool_choice: { type: 'function', function: { name: schema.name } } }
          : { response_format: { type: 'json_object' } })
      }

      let lastError = null
      for (let attempt = 0; attempt < attempts; attempt++) {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
          },
          body: JSON.stringify(body)
        })

        if (res.ok) {
          const json = await res.json()
          const message = json.choices?.[0]?.message
          // Arguments arrive as a JSON *string*, unlike Anthropic's parsed object — so this is
          // the one place a well-formed response can still fail to be an answer.
          const raw = useTools
            ? message?.tool_calls?.[0]?.function?.arguments
            : message?.content
          const parsed = parseLoosely(raw)
          // Null hands the caller its deterministic path, which is the right outcome for a
          // model that answered with something other than the answer.
          return parsed ? { ...parsed, source: 'model' } : null
        }

        const detail = await res.text().catch(() => '')
        lastError = new Error(`${name} ${res.status}: ${detail.slice(0, 200)}`)
        if (!RETRYABLE.has(res.status) || attempt === attempts - 1) throw lastError
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
      }
      throw lastError
    }
  }
}

/** DeepSeek. Tool calling, hosted, needs a key. */
export const deepseekProvider = ({ apiKey, baseUrl = 'https://api.deepseek.com', model, ...rest } = {}) =>
  openAICompatProvider({ name: 'deepseek', apiKey, baseUrl, model, structured: 'tools', ...rest })

/**
 * Ollama, on your own hardware.
 *
 * JSON mode rather than tool calling: support for tools varies by model and the small ones get
 * it wrong quietly, where a malformed JSON object is caught and falls back. The longer timeout
 * is the cost of generating locally rather than in somebody's datacentre.
 */
export const ollamaProvider = ({ baseUrl = 'http://127.0.0.1:11434/v1', model, ...rest } = {}) =>
  openAICompatProvider({
    name: 'ollama', baseUrl, model,
    requiresKey: false, structured: 'json', timeoutMs: 90000, attempts: 1, ...rest
  })
