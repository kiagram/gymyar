import { describe, it, expect, vi } from 'vitest'
import { createAI, nullProvider, anthropicProvider, providerFromEnv } from './index.js'
import { interpretBriefLocally, explainChangeLocally } from './fallback.js'
import { EXIDX } from '@gymyar/domain'

const fakeProvider = answer => ({
  name: 'fake', available: true,
  complete: vi.fn(async () => (typeof answer === 'function' ? answer() : answer))
})

const CHANGE = {
  headline: 'barbell bench press has stalled',
  note: 'Three sessions short of the target.',
  after: { name: 'Push Day', ex: [{ id: '0025', sets: 5, reps: 4 }] },
  changes: [{ exerciseId: '0025', field: 'reps', from: 5, to: 4, why: 'Cut the rep target so the current load is reachable again.' }]
}

describe('with no model configured', () => {
  const ai = createAI({ provider: nullProvider })

  it('reports itself honestly', () => {
    expect(ai.available).toBe(false)
    expect(ai.provider).toBe('none')
  })

  it('still turns a description into a plan brief', async () => {
    const { brief, source } = await ai.interpretBrief(
      'I want to get stronger, 4 days a week, I have a barbell and dumbbells at home')
    expect(source).toBe('local')
    expect(brief.goal).toBe('strength')
    expect(brief.daysPerWeek).toBe(4)
    expect(brief.equipment).toContain('barbell')
    expect(brief.equipment).toContain('dumbbell')
  })

  it('still explains a change', async () => {
    const { note, source } = await ai.explainChange(CHANGE)
    expect(source).toBe('local')
    expect(note).toMatch(/bench press/i)
    expect(note.length).toBeGreaterThan(20)
  })

  it('still parses a logged set', async () => {
    const { entries, source } = await ai.parseLog('bench 5x5 at 80')
    expect(source).toBe('local')
    expect(entries).toHaveLength(1)
    expect(entries[0].sets[0]).toMatchObject({ w: 80, r: 5 })
  })

  it('is what an empty environment produces', () => {
    expect(providerFromEnv({}).available).toBe(false)
  })
})

describe('with a model', () => {
  it('uses what it returns', async () => {
    const provider = fakeProvider({
      goal: 'muscle', daysPerWeek: 5, sessionMinutes: 75,
      equipment: ['dumbbell', 'cable'], summary: 'Five days, size focus, dumbbells and cables.',
      source: 'model'
    })
    const { brief, summary, source } = await createAI({ provider }).interpretBrief('anything')
    expect(source).toBe('model')
    expect(brief.goal).toBe('muscle')
    expect(brief.daysPerWeek).toBe(5)
    expect(summary).toMatch(/five days/i)
  })

  it('throws away a goal it invented', async () => {
    const provider = fakeProvider({ goal: 'transcendence', daysPerWeek: 3, source: 'model' })
    const { brief } = await createAI({ provider }).interpretBrief('anything')
    expect(brief.goal).toBe('general')
  })

  it('throws away equipment it invented', async () => {
    const provider = fakeProvider({ goal: 'strength', daysPerWeek: 3, equipment: ['barbell', 'trebuchet'], source: 'model' })
    const { brief } = await createAI({ provider }).interpretBrief('anything')
    expect(brief.equipment).toContain('barbell')
    expect(brief.equipment).not.toContain('trebuchet')
  })

  it('clamps a week it could not count', async () => {
    const provider = fakeProvider({ goal: 'strength', daysPerWeek: 14, source: 'model' })
    const { brief } = await createAI({ provider }).interpretBrief('anything')
    expect(brief.daysPerWeek).toBe(6)
  })

  it('takes the note it writes', async () => {
    const provider = fakeProvider({ note: 'Your bench has been three sessions short of five, so the target drops to four while the weight stays put.', source: 'model' })
    const { note, source } = await createAI({ provider }).explainChange(CHANGE)
    expect(source).toBe('model')
    expect(note).toMatch(/three sessions/i)
  })

  it('rejects an empty note rather than showing one', async () => {
    const { note, source } = await createAI({ provider: fakeProvider({ note: '  ', source: 'model' }) })
      .explainChange(CHANGE)
    expect(source).toBe('local')
    expect(note.length).toBeGreaterThan(20)
  })

  it('does not ask about a log it already understood', async () => {
    const provider = fakeProvider({ lines: ['squat 3x3 at 200'] })
    const { entries, source } = await createAI({ provider }).parseLog('bench 5x5 at 80')
    expect(provider.complete).not.toHaveBeenCalled()
    expect(source).toBe('local')
    expect(entries).toHaveLength(1)
  })

  it('asks only about the part it could not read', async () => {
    const provider = fakeProvider({ lines: ['bench press 5x5 at 80'] })
    const { entries, source } = await createAI({ provider })
      .parseLog('did about five across on the bench, felt like eighty kilos')
    expect(provider.complete).toHaveBeenCalledOnce()
    expect(source).toBe('model')
    expect(entries[0].sets[0]).toMatchObject({ w: 80, r: 5 })
  })

  it('cannot put an exercise in a log that is not in the library', async () => {
    // the model rewrites phrasing; the deterministic parser still does the naming
    const provider = fakeProvider({ lines: ['flurbulator 5x5 at 80', 'squat 3x5 at 100'] })
    const { entries, unresolved } = await createAI({ provider }).parseLog('something unreadable')
    expect(entries.every(e => EXIDX[e.id])).toBe(true)
    expect(entries).toHaveLength(1)
    expect(unresolved).toHaveLength(1)
  })
})

describe('when the model misbehaves', () => {
  it('falls back when it errors', async () => {
    const provider = { name: 'fake', available: true, complete: async () => { throw new Error('502 bad gateway') } }
    const { brief, source, modelError } = await createAI({ provider })
      .interpretBrief('I want to get stronger 3 days a week')
    expect(source).toBe('local')
    expect(brief.goal).toBe('strength')
    expect(modelError).toMatch(/502/)
  })

  it('falls back when it hangs', async () => {
    const provider = { name: 'fake', available: true, complete: () => new Promise(() => {}) }
    const { source, brief } = await createAI({ provider, timeoutMs: 40 })
      .interpretBrief('4 days a week, dumbbells only')
    expect(source).toBe('local')
    expect(brief.daysPerWeek).toBe(4)
  })

  it('falls back when it answers with nothing', async () => {
    const { source } = await createAI({ provider: fakeProvider(null) }).interpretBrief('get stronger')
    expect(source).toBe('local')
  })

  it('never throws out of a public method', async () => {
    const provider = { name: 'fake', available: true, complete: async () => { throw new Error('boom') } }
    const ai = createAI({ provider })
    await expect(ai.interpretBrief('x')).resolves.toBeTruthy()
    await expect(ai.explainChange(CHANGE)).resolves.toBeTruthy()
    await expect(ai.parseLog('nonsense that parses to nothing')).resolves.toBeTruthy()
  })
})

describe('the anthropic adapter', () => {
  const okResponse = input => ({
    ok: true, status: 200,
    json: async () => ({ content: [{ type: 'tool_use', name: 'training_brief', input }] })
  })

  it('forces the schema rather than asking for JSON', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ goal: 'strength', daysPerWeek: 3 }))
    const p = anthropicProvider({ apiKey: 'k', fetchImpl })
    await p.complete({ system: 's', input: 'i', schema: { name: 'training_brief', input_schema: {} } })
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'training_brief' })
    expect(body.tools).toHaveLength(1)
    expect(fetchImpl.mock.calls[0][1].headers['x-api-key']).toBe('k')
  })

  it('returns null when no structured answer came back', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'sorry' }] }) })
    const p = anthropicProvider({ apiKey: 'k', fetchImpl })
    expect(await p.complete({ schema: { name: 'x' } })).toBeNull()
  })

  it('retries a rate limit once, then succeeds', async () => {
    let call = 0
    const fetchImpl = vi.fn(async () => {
      call++
      return call === 1
        ? { ok: false, status: 429, text: async () => 'slow down' }
        : okResponse({ goal: 'muscle', daysPerWeek: 4 })
    })
    const p = anthropicProvider({ apiKey: 'k', fetchImpl })
    const r = await p.complete({ schema: { name: 'training_brief' } })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(r.goal).toBe('muscle')
  })

  it('does not retry a request that was wrong', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, text: async () => 'bad request' }))
    const p = anthropicProvider({ apiKey: 'k', fetchImpl })
    await expect(p.complete({ schema: { name: 'x' } })).rejects.toThrow(/400/)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('is unavailable without a key', () => {
    expect(anthropicProvider({}).available).toBe(false)
  })
})

describe('reading a description without a model', () => {
  const goal = t => interpretBriefLocally(t).brief.goal

  it('hears what somebody is after', () => {
    expect(goal('I want to get stronger')).toBe('strength')
    expect(goal('trying to put on some size')).toBe('muscle')
    expect(goal('training for a marathon')).toBe('endurance')
    expect(goal('just want to be healthier')).toBe('general')
  })

  it('hears how often', () => {
    expect(interpretBriefLocally('I can train 4 days a week').brief.daysPerWeek).toBe(4)
    expect(interpretBriefLocally('3 times per week').brief.daysPerWeek).toBe(3)
  })

  it('hears how long', () => {
    expect(interpretBriefLocally('45 minutes a session').brief.sessionMinutes).toBe(45)
    expect(interpretBriefLocally('about an hour').brief.sessionMinutes).toBe(60)
  })

  it('hears what they have', () => {
    expect(interpretBriefLocally('only bodyweight at home').brief.equipment).toContain('body weight')
    expect(interpretBriefLocally('full gym membership').brief.equipment).toContain('barbell')
    expect(interpretBriefLocally('a pair of dumbbells and some bands').brief.equipment)
      .toEqual(expect.arrayContaining(['dumbbell', 'band']))
  })

  it('hears where they are starting from', () => {
    expect(interpretBriefLocally('never lifted before').brief.experience).toBe('new')
    expect(interpretBriefLocally('coming back after a break').brief.experience).toBe('returning')
    expect(interpretBriefLocally('been training consistently for years').brief.experience).toBe('experienced')
  })

  it('leaves a field alone when nothing was said about it', () => {
    const b = interpretBriefLocally('I want to get stronger').brief
    expect(b.daysPerWeek).toBeUndefined()
    expect(b.equipment).toBeUndefined()
  })

  it('does not treat everything as an emphasis', () => {
    const b = interpretBriefLocally('I want bigger arms and a stronger chest and better legs and glutes').brief
    expect(b.emphasis.length).toBeLessThanOrEqual(2)
  })
})

describe('explaining a change without a model', () => {
  it('says what changed and why', async () => {
    const { note } = await explainChangeLocally(CHANGE)
    expect(note).toMatch(/bench press/i)
    expect(note).toMatch(/reps 5 → 4/)
    expect(note).toMatch(/reachable/)
  })

  it('addresses the client when it knows their name', async () => {
    expect((await explainChangeLocally(CHANGE, { clientName: 'Sam' })).note).toMatch(/^Sam:/)
  })

  it('handles a change with nothing in it', async () => {
    expect((await explainChangeLocally(null)).note).toBe('')
    expect((await explainChangeLocally({ headline: 'Fine', changes: [] })).note).toMatch(/Fine/)
  })
})

/* --------------------------------- what else the review found --------------------------- */

/* The note is the one piece of model output a client reads verbatim, and until now it only knew
 * about the change itself. A stall deloaded on its own terms reads very differently next to
 * "your weight has been coming off", and the review already knew that. */

describe('the context a note is allowed to draw on', () => {
  const msgOf = fn => ({ msg: fn, args: [] })
  const CONTEXT = [
    { kind: 'stalled-in-deficit', severity: 'high', title: msgOf('The lifts stalled while body weight came off') },
    { kind: 'sore', severity: 'medium', title: msgOf('Soreness has been 4.5 out of 5') },
    { kind: 'sleep', severity: 'medium', title: msgOf('Sleep has been 1.7 out of 5') }
  ]

  it('reaches the model as sentences the domain already wrote', async () => {
    const provider = fakeProvider({ note: 'Cutting the rep target while your weight comes off.' })
    await createAI({ provider }).explainChange(CHANGE, { context: CONTEXT })

    const sent = JSON.parse(provider.complete.mock.calls[0][0].input)
    expect(sent.context).toContain('The lifts stalled while body weight came off')
    // Rendered, not an unrendered { msg, args } that would tell a model nothing.
    expect(sent.context.every(c => typeof c === 'string')).toBe(true)
  })

  it('hands over two at most, so the note stays a note', async () => {
    const provider = fakeProvider({ note: 'A perfectly reasonable sentence about training.' })
    await createAI({ provider }).explainChange(CHANGE, { context: CONTEXT })
    expect(JSON.parse(provider.complete.mock.calls[0][0].input).context).toHaveLength(2)
  })

  it('is an empty list when there was nothing else, not a missing field', async () => {
    const provider = fakeProvider({ note: 'A perfectly reasonable sentence about training.' })
    await createAI({ provider }).explainChange(CHANGE)
    expect(JSON.parse(provider.complete.mock.calls[0][0].input).context).toEqual([])
  })

  it('changes nothing about the template underneath', async () => {
    // The fallback writes from the change alone, and passing context must not break that.
    const { note, source } = await createAI({ provider: nullProvider })
      .explainChange(CHANGE, { context: CONTEXT })
    expect(source).toBe('local')
    expect(note).toBeTruthy()
  })
})
