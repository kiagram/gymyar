/* The Anthropic adapter.
 *
 * Structured output via a forced tool call rather than "please reply with JSON": the schema is
 * enforced by the API, so the failure mode is a refusal rather than prose with a JSON-shaped
 * middle that JSON.parse chokes on halfway through a request.
 *
 * No SDK. One fetch, one shape, no dependency to keep current in a package whose whole job is to
 * be optional.
 */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])

export function anthropicProvider({
  apiKey,
  baseUrl = 'https://api.anthropic.com',
  model = 'claude-sonnet-4-5',
  maxTokens = 1024,
  attempts = 2,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!apiKey) return { name: 'anthropic', available: false, async complete() { return null } }

  return {
    name: 'anthropic',
    available: true,
    model,

    async complete({ system, input, schema }) {
      let lastError = null
      for (let attempt = 0; attempt < attempts; attempt++) {
        const res = await fetchImpl(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            system,
            messages: [{ role: 'user', content: input }],
            tools: [schema],
            // Forced: the model has one way to answer and it is the schema.
            tool_choice: { type: 'tool', name: schema.name }
          })
        })

        if (res.ok) {
          const body = await res.json()
          const call = (body.content || []).find(c => c.type === 'tool_use')
          // A stop for any other reason means no structured answer came back. Falling through to
          // null hands the caller its deterministic path, which is the right outcome.
          return call ? { ...call.input, source: 'model' } : null
        }

        const detail = await res.text().catch(() => '')
        lastError = new Error(`anthropic ${res.status}: ${detail.slice(0, 200)}`)
        if (!RETRYABLE.has(res.status) || attempt === attempts - 1) throw lastError
        // One short backoff. This sits in front of a user waiting for a button, so a long
        // retry ladder is worse than falling back.
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
      }
      throw lastError
    }
  }
}
