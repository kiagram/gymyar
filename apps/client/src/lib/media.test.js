/* The client's half of attachments: the checks that happen before a byte is sent.
 *
 * None of this is the real check — the server sniffs the file and enforces its own ceilings,
 * and does not trust anything decided here. What these are worth testing for is the failure
 * they exist to prevent: spending a minute of somebody's mobile data to arrive at a rejection
 * the browser could have made instantly, which is a person who does not try again.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { kindOf, tooBig, mediaLimits, videoSecondsLimit, setMediaLimits, fmtBytes } from './media.js'

/** A stand-in for a picked file: the browser only gives `type` and `size` before an upload. */
const picked = (type, size) => ({ type, size, name: 'whatever.bin' })

beforeEach(() => {
  setMediaLimits({ limits: { photo: 1000, video: 5000, audio: 800 }, maxVideoSeconds: 45 })
})

describe('sorting a picked file into a kind', () => {
  it('reads the browser’s type, which is all there is before an upload', () => {
    expect(kindOf(picked('image/jpeg', 1))).toBe('photo')
    expect(kindOf(picked('video/quicktime', 1))).toBe('video')
    expect(kindOf(picked('audio/webm;codecs=opus', 1))).toBe('audio')
  })

  it('is not case-sensitive, because a file picker is not', () => {
    expect(kindOf(picked('IMAGE/JPEG', 1))).toBe('photo')
  })

  it('answers null for anything else, including nothing at all', () => {
    expect(kindOf(picked('application/pdf', 1))).toBe(null)
    expect(kindOf(picked('', 1))).toBe(null)
    expect(kindOf(null)).toBe(null)
    expect(kindOf(undefined)).toBe(null)
  })
})

describe('refusing before sending', () => {
  it('measures each kind against its own ceiling', () => {
    expect(tooBig(picked('image/jpeg', 999))).toBe(false)
    expect(tooBig(picked('image/jpeg', 1001))).toBe(true)
    // The same size is fine as a video and too large as a photo — which is the entire reason
    // the limits are per kind rather than one number.
    expect(tooBig(picked('video/mp4', 1001))).toBe(false)
  })

  it('lets a file of an unknown kind through to the server’s answer', () => {
    // Not "too big" — wrong in a different way, and saying so is the picker's job. Answering
    // true here would report a size problem for a file whose problem is that it is a PDF.
    expect(tooBig(picked('application/pdf', 10 ** 9))).toBe(false)
  })

  it('is exact at the boundary rather than off by one', () => {
    expect(tooBig(picked('audio/mp4', 800))).toBe(false)
    expect(tooBig(picked('audio/mp4', 801))).toBe(true)
  })
})

describe('the limits themselves', () => {
  it('takes what the deployment says', () => {
    expect(mediaLimits()).toEqual({ photo: 1000, video: 5000, audio: 800 })
    expect(videoSecondsLimit()).toBe(45)
  })

  it('keeps the ones a partial answer left out', () => {
    setMediaLimits({ limits: { video: 42 } })
    expect(mediaLimits()).toEqual({ photo: 1000, video: 42, audio: 800 })
  })

  it('survives an instance that says nothing, since these are only ever a courtesy', () => {
    const before = mediaLimits()
    setMediaLimits(undefined)
    setMediaLimits({})
    setMediaLimits({ limits: null })
    expect(mediaLimits()).toEqual(before)
  })

  it('hands out a copy, so a screen cannot edit the ceiling it is checking against', () => {
    const l = mediaLimits()
    l.photo = 10 ** 9
    expect(mediaLimits().photo).toBe(1000)
  })
})

describe('saying how large something is', () => {
  it('counts bytes as bytes and everything else in the unit that fits', () => {
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(512)).toBe('512 B')
    expect(fmtBytes(1024)).toBe('1.0 KB')
    expect(fmtBytes(8 * 1024 * 1024)).toBe('8.0 MB')
    expect(fmtBytes(2 * 1024 ** 3)).toBe('2.0 GB')
  })

  it('stops at gigabytes rather than inventing a unit nobody uploads', () => {
    expect(fmtBytes(5 * 1024 ** 4)).toMatch(/GB$/)
  })

  it('reads a bigint-shaped size, which is what the row carries', () => {
    // Postgres hands `bigint` back as a string, and it reaches this untouched.
    expect(fmtBytes('4096')).toBe('4.0 KB')
  })
})
