/* The adapters and the routing between them.
 *
 * ai.test.js covers what the surface promises regardless of who answers. This covers who
 * answers: that the OpenAI-compatible shape is actually the OpenAI shape, that the note a
 * person reads goes to the better model, and that an unreachable hosted model costs prose
 * rather than a feature.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createAI, providersFromEnv, deepseekProvider, ollamaProvider
} from './index.js'

const CHANGE = {
  headline: 'barbell bench press has stalled',
  note: 'Three sessions short of the target.',
  after: { name: 'Push Day', ex: [{ id: '0025', sets: 5, reps: 4 }] },
  changes: [{ exerciseId: '0025', field: 'reps', from: 5, to: 4, why: 'Cut the rep target so the current load is reachable again.' }]
}

const FENCE = '`' + '`' + '`'
const okFetch = body => vi.fn(async () => ({ ok: true, json: async () => body }))
const toolReply = args => ({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(args) } }] } }] })
const textReply = content => ({ choices: [{ message: { content } }] })

const TASK = {
  system: 'you are a thing', input: 'some input',
  schema: { name: 'training_brief', description: 'd', input_schema: { type: 'object', properties: {} } }
}

describe('the openai-compatible adapter', () => {
  it('speaks the openai shape, not the anthropic one', async () => {
    const fetchImpl = okFetch(toolReply({ goal: 'strength' }))
    await deepseekProvider({ apiKey: 'k', model: 'a-model', fetchImpl }).complete(TASK)

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(init.headers.authorization).toBe('Bearer k')

    const sent = JSON.parse(init.body)
    // System goes in the messages array here, unlike Anthropic's top-level field.
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'you are a thing' })
    expect(sent.model).toBe('a-model')
    // The schema is remapped rather than rewritten: input_schema → function.parameters.
    expect(sent.tools[0].function.name).toBe('training_brief')
    expect(sent.tools[0].function.parameters).toEqual(TASK.schema.input_schema)
    expect(sent.tool_choice).toEqual({ type: 'function', function: { name: 'training_brief' } })
  })

  it('parses the arguments string a tool call answers with', async () => {
    const p = deepseekProvider({ apiKey: 'k', model: 'm', fetchImpl: okFetch(toolReply({ goal: 'muscle', daysPerWeek: 4 })) })
    expect(await p.complete(TASK)).toEqual({ goal: 'muscle', daysPerWeek: 4, source: 'model' })
  })

  it('returns null rather than throwing when the arguments are not json', async () => {
    const p = deepseekProvider({
      apiKey: 'k', model: 'm',
      fetchImpl: okFetch({ choices: [{ message: { tool_calls: [{ function: { arguments: 'sorry, what?' } }] } }] })
    })
    expect(await p.complete(TASK)).toBeNull()
  })

  it('unwraps the markdown fence a local model puts round its json', async () => {
    const fenced = FENCE + 'json\n{"goal":"endurance"}\n' + FENCE
    const p = ollamaProvider({ model: 'qwen', fetchImpl: okFetch(textReply(fenced)) })
    expect(await p.complete(TASK)).toEqual({ goal: 'endurance', source: 'model' })
  })

  it('finds the object inside a local model that answered with a preamble', async () => {
    const p = ollamaProvider({ model: 'qwen', fetchImpl: okFetch(textReply('Sure! Here you go:\n{"goal":"general"}')) })
    expect(await p.complete(TASK)).toEqual({ goal: 'general', source: 'model' })
  })

  it('describes the schema in the prompt when it cannot force a tool call', async () => {
    const fetchImpl = okFetch(textReply('{}'))
    await ollamaProvider({ model: 'qwen', fetchImpl }).complete(TASK)
    const sent = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(sent.tools).toBeUndefined()
    expect(sent.response_format).toEqual({ type: 'json_object' })
    expect(sent.messages[0].content).toContain('"type": "object"')
  })

  it('retries a rate limit once, then succeeds', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => ++n === 1
      ? { ok: false, status: 429, text: async () => 'slow down' }
      : { ok: true, json: async () => toolReply({ goal: 'strength' }) })
    const p = deepseekProvider({ apiKey: 'k', model: 'm', fetchImpl })
    expect(await p.complete(TASK)).toMatchObject({ goal: 'strength' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry a request that was wrong', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, text: async () => 'bad model' }))
    await expect(deepseekProvider({ apiKey: 'k', model: 'm', fetchImpl }).complete(TASK)).rejects.toThrow(/400/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('is unavailable without the key it needs, and available without one it does not', () => {
    expect(deepseekProvider({ model: 'm' }).available).toBe(false)
    expect(ollamaProvider({ model: 'qwen' }).available).toBe(true)
    // No model named is the same as no model configured.
    expect(ollamaProvider({}).available).toBe(false)
  })

  it('gives a local model longer before giving up on it', () => {
    expect(ollamaProvider({ model: 'qwen' }).timeoutMs).toBeGreaterThan(20000)
    expect(deepseekProvider({ apiKey: 'k', model: 'm' }).timeoutMs).toBeUndefined()
  })
})

describe('routing a task to the model that should answer it', () => {
  const named = name => ({
    name, available: true, model: name,
    complete: vi.fn(async () => ({ goal: 'strength', daysPerWeek: 3, note: 'written by ' + name, source: 'model' }))
  })

  it('sends the note a person reads to the better model', async () => {
    const fast = named('flash'); const deep = named('pro')
    const { note } = await createAI({ fast, deep }).explainChange(CHANGE)
    expect(note).toBe('written by pro')
    expect(fast.complete).not.toHaveBeenCalled()
  })

  it('sends validated structured output to the cheap one', async () => {
    const fast = named('flash'); const deep = named('pro')
    await createAI({ fast, deep }).interpretBrief('3 days, get stronger')
    expect(fast.complete).toHaveBeenCalled()
    expect(deep.complete).not.toHaveBeenCalled()
  })

  it('reports which model answers what', () => {
    const ai = createAI({ fast: named('flash'), deep: named('pro'), local: named('qwen') })
    expect(ai.models).toEqual({ fast: 'flash', deep: 'pro', local: 'qwen' })
  })

  it('still treats one provider as the answer to everything', async () => {
    const only = named('solo')
    const ai = createAI({ provider: only })
    await ai.interpretBrief('3 days')
    await ai.explainChange(CHANGE)
    expect(only.complete).toHaveBeenCalledTimes(2)
  })
})

describe('when the hosted model cannot be reached', () => {
  const dead = () => ({
    name: 'deepseek', available: true, model: 'm',
    complete: vi.fn(async () => { throw new Error('403 blocked') })
  })

  it('falls through to the local model rather than to a template', async () => {
    const local = {
      name: 'ollama', available: true, model: 'qwen',
      complete: vi.fn(async () => ({ note: 'written locally', source: 'model' }))
    }
    const { note, source } = await createAI({ provider: dead(), local }).explainChange(CHANGE)
    expect(note).toBe('written locally')
    expect(source).toBe('model')
    expect(local.complete).toHaveBeenCalled()
  })

  it('falls all the way to the template when the local one is down too', async () => {
    const alsoDead = {
      name: 'ollama', available: true, model: 'qwen',
      complete: vi.fn(async () => { throw new Error('connection refused') })
    }
    const { note, source, modelError } = await createAI({ provider: dead(), local: alsoDead }).explainChange(CHANGE)
    expect(source).toBe('local')
    expect(note).toMatch(/bench press/i)
    // The last thing that went wrong travels with the answer — "it keeps falling back" is a
    // question an operator asks, and this is what answers it.
    expect(modelError).toMatch(/connection refused/)
  })

  it('does not ask the same provider twice when it is both primary and local', async () => {
    const only = {
      name: 'ollama', available: true, model: 'qwen',
      complete: vi.fn(async () => { throw new Error('nope') })
    }
    await createAI({ provider: only, local: only }).explainChange(CHANGE)
    expect(only.complete).toHaveBeenCalledTimes(1)
  })
})

describe('what the environment configures', () => {
  it('prefers deepseek when its key is set, and splits the tiers', () => {
    const p = providersFromEnv({
      DEEPSEEK_API_KEY: 'k', GYMBUDDY_MODEL_FAST: 'v4-flash', GYMBUDDY_MODEL_DEEP: 'v4-pro'
    })
    expect(p.fast.name).toBe('deepseek')
    expect(p.fast.model).toBe('v4-flash')
    expect(p.deep.model).toBe('v4-pro')
    expect(p.local).toBeNull()
  })

  it('uses the fast model for both when only one is named', () => {
    const p = providersFromEnv({ DEEPSEEK_API_KEY: 'k', GYMBUDDY_MODEL_FAST: 'v4-flash' })
    expect(p.deep.model).toBe('v4-flash')
  })

  it('keeps ollama as the failover behind a hosted model', () => {
    const p = providersFromEnv({ DEEPSEEK_API_KEY: 'k', OLLAMA_MODEL_FAST: 'qwen3' })
    expect(p.fast.name).toBe('deepseek')
    expect(p.local.name).toBe('ollama')
    expect(p.local.model).toBe('qwen3')
  })

  it('makes ollama the model itself when nothing hosted is configured', () => {
    const p = providersFromEnv({ OLLAMA_MODEL_FAST: 'qwen3-8b', OLLAMA_MODEL_DEEP: 'qwen3-32b' })
    expect(p.fast.model).toBe('qwen3-8b')
    expect(p.deep.model).toBe('qwen3-32b')
    // Nothing to fail over *to* — it is already the local one.
    expect(p.local).toBeNull()
  })

  it('is still nothing at all in an empty environment', () => {
    const p = providersFromEnv({})
    expect(p.fast.available).toBe(false)
    expect(p.local).toBeNull()
  })
})
