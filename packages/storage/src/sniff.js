/* What a file actually is, read from its first bytes.
 *
 * ## Why the header is not the answer
 *
 * A `Content-Type` on an upload is a claim made by the thing uploading. It costs nothing to
 * write `image/jpeg` above a payload that is not one, and every consequence of believing it is
 * downstream of this file: the extension the object is stored under, the `Content-Type` served
 * back to a browser later, and therefore what that browser decides to *do* with the bytes. A
 * stored object is served from the same origin as the app, so "the uploader picks the content
 * type" is the same sentence as "the uploader picks whether their file runs as a script".
 *
 * So the header is ignored entirely — not cross-checked, ignored. The type is whatever the
 * leading bytes say it is, and a file whose leading bytes say nothing this app recognises is
 * refused. That is also why the allowed list here is short: every entry is a format some real
 * phone's camera or recorder emits, and a format nobody uploads is a parser nobody needs.
 *
 * ## What "recognised" means, deliberately narrowly
 *
 * This is a magic-number check, not a validator. It says "the first bytes of this file are the
 * ones a JPEG starts with"; it does not say the JPEG is well-formed, and nothing here should
 * grow into saying so. The app never decodes these bytes — it stores them and later hands them
 * to a browser, which has its own opinions and its own hardening. What this check exists to
 * stop is an HTML document, a script or an executable being stored under `.jpg` and served
 * back as one, and for that, the first eight bytes are enough.
 */

/** How many bytes are needed to answer. Small: every signature here is inside the first 16. */
export const SNIFF_BYTES = 32

const ascii = (buf, at, s) => {
  for (let i = 0; i < s.length; i++) if (buf[at + i] !== s.charCodeAt(i)) return false
  return true
}

const starts = (buf, bytes) => {
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false
  return true
}

/* ISO base media brands, from the box at offset 4. One container, several products: an iPhone
 * writes `qt  ` for a video and `M4A ` for a voice memo, and Android writes `isom`/`mp42`. The
 * brand is the only thing separating them, so it is read rather than assumed. */
const BRANDS = {
  'qt  ': 'video/quicktime',
  'M4A ': 'audio/mp4',
  'M4B ': 'audio/mp4',
  isom: 'video/mp4',
  iso2: 'video/mp4',
  iso4: 'video/mp4',
  iso5: 'video/mp4',
  iso6: 'video/mp4',
  mp41: 'video/mp4',
  mp42: 'video/mp4',
  avc1: 'video/mp4',
  dash: 'video/mp4',
  'M4V ': 'video/mp4',
  mmp4: 'video/mp4'
}

/**
 * The media type of `buf`, or null if it is not one this app stores.
 *
 * `buf` may be the whole file or only its head — `SNIFF_BYTES` is all that is read, which is
 * what lets an upload be sniffed before it is streamed anywhere.
 */
export function sniff(buf) {
  if (!buf || buf.length < 12) return null

  if (starts(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (ascii(buf, 0, 'RIFF') && ascii(buf, 8, 'WEBP')) return 'image/webp'
  if (ascii(buf, 0, 'OggS')) return 'audio/ogg'

  /* EBML, which is both `video/webm` and `audio/webm` and does not say which within the first
   * bytes. It is read as audio because that is the one this app takes: a voice note recorded by
   * MediaRecorder in Chrome is webm, while video arrives from a camera as MP4 on every phone
   * that has one. A webm *video* therefore sniffs as audio and is refused by the caller for
   * being the wrong kind for what it was attached to — a rejection, never a mislabelled file. */
  if (starts(buf, [0x1a, 0x45, 0xdf, 0xa3])) return 'audio/webm'

  // ADTS AAC: twelve sync bits, then a layer field that must be zero for AAC.
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return 'audio/aac'

  if (ascii(buf, 4, 'ftyp')) {
    const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11])
    return BRANDS[brand] ?? null
  }

  return null
}
