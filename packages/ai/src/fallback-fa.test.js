/* Reading Persian with no model configured.
 *
 * This is the path a free-tier Farsi user is on by default, and its failure mode was silent:
 * an English-only reader finds nothing in a Persian sentence, every field falls back to a
 * default, and the planner cheerfully builds a generic plan that has nothing to do with what
 * the person said. No error, no empty state — just a wrong plan presented confidently.
 */
import { describe, it, expect } from 'vitest'
import { interpretBriefLocally, explainChangeLocally } from './fallback.js'
import { createAI, nullProvider } from './index.js'

const fa = text => interpretBriefLocally(text, {}, 'fa').brief

describe('reading a Persian description', () => {
  it('hears the whole sentence at once', () => {
    const b = fa('می‌خوام قوی‌تر بشم، ۳ روز در هفته، هالتر و دمبل دارم')
    expect(b.goal).toBe('strength')
    expect(b.daysPerWeek).toBe(3)
    expect(b.equipment).toContain('barbell')
    expect(b.equipment).toContain('dumbbell')
  })

  it('hears what they are after', () => {
    expect(fa('هدفم افزایش قدرت است').goal).toBe('strength')
    expect(fa('دنبال حجم عضلانی هستم').goal).toBe('muscle')
    expect(fa('می‌خوام استقامتم بالا بره').goal).toBe('endurance')
    // Nothing about a goal is not a goal.
    expect(fa('سلام، برنامه می‌خوام').goal).toBe('general')
  })

  it('hears where they are starting from', () => {
    expect(fa('مبتدی هستم و تازه شروع کردم').experience).toBe('new')
    expect(fa('بعد از یک وقفه دوباره برگشتم').experience).toBe('returning')
    expect(fa('چند ساله مداوم تمرین می‌کنم').experience).toBe('experienced')
  })

  it('reads Persian and Latin digits the same', () => {
    expect(fa('۴ روز در هفته').daysPerWeek).toBe(4)
    expect(fa('4 روز در هفته').daysPerWeek).toBe(4)
    expect(fa('هفته‌ای ۵ جلسه').daysPerWeek).toBe(5)
  })

  it('reads a count written as a word', () => {
    expect(fa('سه روز در هفته تمرین می‌کنم').daysPerWeek).toBe(3)
    expect(fa('چهار بار در هفته').daysPerWeek).toBe(4)
  })

  it('reads how long a session is', () => {
    expect(fa('۴۵ دقیقه وقت دارم').sessionMinutes).toBe(45)
    expect(fa('حدود یک ساعت').sessionMinutes).toBe(60)
  })

  it('hears what they have', () => {
    expect(fa('فقط دمبل دارم').equipment).toEqual(['dumbbell'])
    expect(fa('کش و کتل‌بل دارم').equipment).toEqual(expect.arrayContaining(['band', 'kettlebell']))
    expect(fa('هیچ وسیله‌ای ندارم، بدون تجهیزات').equipment).toContain('body weight')
    // A gym membership means the gym, which is what people mean by it.
    expect(fa('عضو باشگاه هستم').equipment).toEqual(
      expect.arrayContaining(['barbell', 'dumbbell', 'cable', 'leverage machine']))
  })

  it('tells the two arms apart', () => {
    // "بازو" is inside both, so a naive stem would call every arm sentence biceps.
    expect(fa('روی جلو بازو تمرکز کنم').emphasis).toEqual(['biceps'])
    expect(fa('پشت بازو ضعیفه').emphasis).toEqual(['triceps'])
  })

  it('does not treat everything as an emphasis', () => {
    expect(fa('سینه و زیربغل و سرشانه و شکم و ساق').emphasis).toHaveLength(2)
  })

  it('leaves a field alone when the sentence says nothing about it', () => {
    const b = interpretBriefLocally('می‌خوام قوی‌تر بشم', { daysPerWeek: 4 }, 'fa').brief
    expect(b.goal).toBe('strength')
    expect(b.daysPerWeek).toBe(4)          // the hint survives
    expect(b.sessionMinutes).toBeUndefined()
  })
})

describe('an unknown language falls back to English', () => {
  it('reads an English sentence when asked for a language with no lexicon', () => {
    const b = interpretBriefLocally('I want to get stronger, 3 days a week', {}, 'kl').brief
    expect(b.goal).toBe('strength')
    expect(b.daysPerWeek).toBe(3)
  })
})

describe('the note, in Persian', () => {
  const CHANGE = {
    headline: 'bench press has stalled',
    after: { name: 'Push Day' },
    changes: [{ exerciseId: '0025', field: 'reps', from: 5, to: 4, why: 'Cut the rep target.' }]
  }

  it('assembles the sentence in Persian, not English', async () => {
    const { note } = await explainChangeLocally(CHANGE, { lang: 'fa' })
    expect(note).toContain('از 5 به 4')
    expect(note).toContain('تکرار')          // the field name is translated
    expect(note).not.toContain('reps 5 → 4')
  })

  it('still writes English by default', async () => {
    const { note } = await explainChangeLocally(CHANGE)
    expect(note).toContain('reps 5 → 4')
  })

  it('names the client when it knows them', async () => {
    const { note } = await explainChangeLocally(CHANGE, { lang: 'fa', clientName: 'سام' })
    expect(note.startsWith('سام: ')).toBe(true)
  })

  /* The lift, in Persian too.
   *
   * A note is the one thing a client reads word for word, and it is assembled here rather than
   * on their screen — so unlike every other sentence in the app, there is nothing left for the
   * client to translate afterwards. Persian scaffolding around "barbell bench press" is a note
   * written by somebody who did not read it.
   */
  it('names the lift in Persian, not only the numbers around it', async () => {
    const { note } = await explainChangeLocally(CHANGE, { lang: 'fa' })
    expect(note).toContain('پرس سینه هالتر')
    expect(note).not.toMatch(/barbell bench press/i)
  })

  it('falls back to the English name for a lift the pack does not cover', async () => {
    // 66 of 1,324 are translated — the ones the planner can emit. Everything else reads as
    // partly translated rather than blank, which is the deliberate trade.
    const untranslated = {
      ...CHANGE,
      changes: [{ exerciseId: '3348', field: 'reps', from: 5, to: 4, why: 'Cut the rep target.' }]
    }
    const { note } = await explainChangeLocally(untranslated, { lang: 'fa' })
    expect(note).toContain('از 5 به 4')       // still a Persian sentence
    expect(note).toMatch(/[a-z]/i)            // with an English name inside it
  })

  it('leaves an English note naming the lift in English', async () => {
    const { note } = await explainChangeLocally(CHANGE)
    expect(note).toMatch(/bench press/i)
    expect(note).not.toContain('پرس سینه هالتر')
  })
})

describe('the AI surface passes the language down', () => {
  const ai = createAI({ provider: nullProvider })

  it('reads Persian through interpretBrief with no model at all', async () => {
    const { brief, source } = await ai.interpretBrief('می‌خوام قوی‌تر بشم، ۳ روز در هفته، هالتر دارم', { lang: 'fa' })
    expect(source).toBe('local')
    expect(brief.goal).toBe('strength')
    expect(brief.daysPerWeek).toBe(3)
    expect(brief.equipment).toContain('barbell')
  })

  it('writes the note in Persian through explainChange with no model at all', async () => {
    const { note, source } = await ai.explainChange({
      headline: 'bench press has stalled',
      changes: [{ exerciseId: '0025', field: 'sets', from: 3, to: 4, why: 'More work.' }]
    }, { lang: 'fa' })
    expect(source).toBe('local')
    expect(note).toContain('ست')
    expect(note).toContain('از 3 به 4')
  })
})
