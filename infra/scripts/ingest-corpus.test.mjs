/* The rules that decide what this product is allowed to hold.
 *
 * Everything else in ingest-corpus.mjs is plumbing around a network call. This is the part that
 * decides whether several thousand paragraphs of somebody else's work end up in a database that
 * a paid tier answers from, so it is the part with tests. No network: `fetchPage` is driven with
 * a fake, and the record shapes below are trimmed copies of what Europe PMC actually returned on
 * 2026-09-07, including the licences.
 */
import { describe, it, expect } from 'vitest'
import { licenceOf, designOf, sampleSizeOf, chunk, SOURCES, LICENCES } from './ingest-corpus.mjs'

describe('which licences may be ingested', () => {
  it('accepts the three that permit commercial use and adaptation', () => {
    expect(licenceOf('cc by')).toBe('CC-BY')
    expect(licenceOf('CC BY 4.0')).toBe('CC-BY-4.0')
    expect(licenceOf('cc by-sa')).toBe('CC-BY-SA')
    expect(licenceOf('cc0')).toBe('CC0')
    expect(licenceOf('Public Domain')).toBe('CC0')
  })

  it('refuses non-commercial, whatever else the string says', () => {
    /* The trap this rule exists for, and it is not hypothetical: the first result Europe PMC
     * returned for "resistance training volume hypertrophy" on the day this was written was an
     * open-access systematic review under cc by-nc-nd. Free to read is not free to sell
     * alongside, and an ingester that read `isOpenAccess: Y` and stopped there would have taken
     * it. */
    expect(licenceOf('cc by-nc')).toBeNull()
    expect(licenceOf('cc by-nc-nd')).toBeNull()
    expect(licenceOf('CC BY-NC-SA 4.0')).toBeNull()
    expect(licenceOf('noncommercial')).toBeNull()
  })

  it('refuses no-derivatives, rather than arguing about whether a vector is one', () => {
    expect(licenceOf('cc by-nd')).toBeNull()
    expect(licenceOf('CC BY-ND 4.0')).toBeNull()
  })

  it('refuses anything it does not recognise, including nothing at all', () => {
    for (const s of ['', null, undefined, 'unknown', 'free to read', 'all rights reserved', 'open access']) {
      expect(licenceOf(s)).toBeNull()
    }
  })

  it('reads share-alike as share-alike rather than as plain attribution', () => {
    // Ordering in LICENCES is load-bearing: `cc by` is a substring of `cc by sa`, so a
    // shortest-first list would record every share-alike paper as CC-BY and quietly drop the
    // obligation that makes it different.
    expect(licenceOf('cc by-sa 4.0')).toBe('CC-BY-SA')
    expect(LICENCES.findIndex(([n]) => n === 'cc by sa'))
      .toBeLessThan(LICENCES.findIndex(([n]) => n === 'cc by'))
  })
})

describe('reading a study for what it is', () => {
  it('takes the strongest claim when a record is tagged several ways', () => {
    // Europe PMC files a trial as "Journal Article" too. The stronger tag is the true one.
    expect(designOf('Randomized Controlled Trial review-article Journal Article')).toBe('rct')
    expect(designOf('Meta-Analysis Systematic Review Journal Article')).toBe('meta-analysis')
  })

  it('says nothing rather than guessing', () => {
    expect(designOf('research-article Journal Article')).toBeNull()
    expect(designOf('')).toBeNull()
  })

  it('reads a sample size only from a phrase that is about people', () => {
    expect(sampleSizeOf('48 participants were randomised to two groups')).toBe(48)
    expect(sampleSizeOf('we recruited 24 trained men')).toBe(24)
    // The failure worth avoiding: a set count read as a sample size does not error, it silently
    // reweights the ranking of a paper that never claimed it.
    expect(sampleSizeOf('participants performed 3 sets of 10 repetitions')).toBeNull()
    expect(sampleSizeOf('no numbers here')).toBeNull()
  })
})

describe('chunking', () => {
  it('leaves a short abstract alone', () => {
    expect(chunk('one sentence about training.')).toEqual(['one sentence about training.'])
  })

  it('splits a long one with overlap, and never mid-word', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about resistance training.`).join(' ')
    const parts = chunk(text, { size: 400, overlap: 80 })
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(400)
    // Nothing is lost: every sentence survives somewhere.
    expect(parts.join(' ')).toContain('Sentence number 59')
  })

  it('returns nothing for nothing', () => {
    expect(chunk('')).toEqual([])
    expect(chunk('   ')).toEqual([])
  })
})

describe('the Europe PMC adapter', () => {
  const record = (over = {}) => ({
    id: '42043074',
    source: 'MED',
    license: 'cc by',
    isOpenAccess: 'Y',
    pubYear: '2026',
    title: 'The Acute Effect of Increasing Resistance Training Workload',
    authorString: 'Someone A, Someone B.',
    abstractText: 'x'.repeat(400),
    pubTypeList: { pubType: ['research-article', 'Journal Article'] },
    ...over
  })

  it('turns a record into something the store will accept', () => {
    const d = SOURCES.europepmc.toDocument(record())
    expect(d.sourceId).toBe('europepmc:MED:42043074')
    expect(d.url).toBe('https://europepmc.org/article/MED/42043074')
    expect(d.licence).toBe('CC-BY')
    expect(d.peerReviewed).toBe(true)
    expect(d.publishedOn).toBe('2026-01-01')
  })

  it('marks a preprint as one instead of leaving it out', () => {
    // Source PPR is Europe PMC's preprint corpus. This field is what lets the store discount it
    // and the reader be told, which is the honest handling of work that is real and unchecked.
    expect(SOURCES.europepmc.toDocument(record({ source: 'PPR' })).peerReviewed).toBe(false)
  })

  it('skips, with a reason, rather than storing something it cannot attribute', () => {
    expect(SOURCES.europepmc.toDocument(record({ license: 'cc by-nc' })).skip).toBe('licence')
    expect(SOURCES.europepmc.toDocument(record({ license: null })).skip).toBe('licence')
    expect(SOURCES.europepmc.toDocument(record({ abstractText: 'too short' })).skip).toBe('no abstract')
    expect(SOURCES.europepmc.toDocument(record({ id: null, pmid: null, pmcid: null })).skip).toBe('no id')
  })

  it('strips the markup an abstract arrives wrapped in', () => {
    const d = SOURCES.europepmc.toDocument(record({ abstractText: `<p>Real text. ${'y'.repeat(300)}</p>` }))
    expect(d.text).not.toContain('<p>')
    expect(d.text.startsWith('Real text.')).toBe(true)
  })

  it('asks the API only for open-access records, and follows the cursor', async () => {
    let asked = null
    const fetchImpl = async url => {
      asked = url
      return { ok: true, json: async () => ({ resultList: { result: [record()] }, nextCursorMark: 'next-page' }) }
    }
    const page = await SOURCES.europepmc.fetchPage({ query: 'volume', fetchImpl })
    expect(String(asked)).toContain('OPEN_ACCESS%3Ay')
    expect(page.records).toHaveLength(1)
    expect(page.cursor).toBe('next-page')
  })

  it('throws on an HTTP error rather than reporting an empty page', async () => {
    // An ingestion that treats a 503 as "no more results" reports success having stored nothing.
    const fetchImpl = async () => ({ ok: false, status: 503 })
    await expect(SOURCES.europepmc.fetchPage({ query: 'x', fetchImpl })).rejects.toThrow(/503/)
  })
})
