/* Turning the file somebody picked into something `mergeImport` can take.
 *
 * Apple hands out `export.zip`, not `export.xml`. Until this existed the import read whatever
 * it was given as text, so an Apple Health user had to unzip the archive by hand and find the
 * one file inside it that mattered — which is a thing a person can do and not a thing most
 * people will, and it is the difference between a feature and a feature with instructions.
 *
 * Three phases, all of them reported, because every one of them can take seconds on a real
 * export: reading the file off disk, inflating it, and scanning it. See docs/WEARABLES.md —
 * "the file is big enough that a silent spinner reads as a hang".
 *
 * Nothing here is React and nothing here touches the store, so it runs unchanged on the main
 * thread and inside a worker, which is the whole point: `import-worker.js` is a dozen lines
 * around this file rather than a second copy of it.
 */
import { Unzip, UnzipInflate, unzipSync } from 'fflate'
import { parseImport } from '@gymyar/domain'

/* Why fflate rather than the platform's own decompression.
 *
 * `DecompressionStream('deflate-raw')` would inflate a zip entry with no dependency at all,
 * and on a desktop browser it is the obvious answer. It is the wrong answer here: on Android
 * the WebView is updated through the Play Store, this project ships through Cafe Bazaar and
 * Myket to phones that may never have seen the Play Store, and a WebView from 2021 has no
 * DecompressionStream. Inflating in JavaScript is slower and it works on every device that can
 * run the app at all. Eight kilobytes for that trade is cheap. */

/** Apple's archive is `apple_health_export/export.xml`, beside a `export_cda.xml` that is a
 *  clinical document rather than a history, and a folder of GPX routes. Anchored so the CDA
 *  file — which is smaller, valid XML, and holds none of this — cannot be picked instead. */
const EXPORT_XML = /(^|\/)export\.xml$/i

/** The four bytes every zip starts with. Checked rather than trusting a file name, because a
 *  file arriving from a share sheet is often called something else entirely. */
const isZip = bytes =>
  bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04

/** The file's bytes, reporting how far it has got. Streamed rather than `arrayBuffer()` so
 *  that a hundred megabytes off a phone's flash is a moving bar and not a still one. */
async function readBytes(file, say) {
  const reader = file.stream().getReader()
  const chunks = []
  let read = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    read += value.length
    if (file.size) say(read / file.size)
  }
  const all = new Uint8Array(read)
  let at = 0
  for (const c of chunks) { all.set(c, at); at += c.length }
  return all
}

/* Inflated `export.xml`, streamed so the bar moves while it happens.
 *
 * The streaming reader works from each entry's local header. Some writers leave the sizes out
 * of those and put them in a trailing descriptor instead, which this cannot read — so a
 * failure here is answered by `unzipSync`, which works from the central directory at the end
 * of the archive and can read anything the streaming one cannot. The fast path with the
 * progress bar first, the one that always works behind it. */
function inflateExport(bytes, say) {
  return new Promise((resolve, reject) => {
    let out = null
    const parts = []
    const uz = new Unzip()
    uz.register(UnzipInflate)
    uz.onfile = f => {
      if (out || !EXPORT_XML.test(f.name)) return
      out = f.name
      f.ondata = (err, chunk, final) => {
        if (err) return reject(err)
        parts.push(chunk)
        if (final) resolve(parts)
      }
      f.start()
    }
    // Fed in slices rather than in one push so `onfile` fires early and the entry is being
    // inflated while the rest of the archive is still being handed over.
    const STEP = 1 << 20
    try {
      for (let at = 0; at < bytes.length; at += STEP) {
        const end = Math.min(at + STEP, bytes.length)
        uz.push(bytes.subarray(at, end), end === bytes.length)
        say(end / bytes.length)
      }
    } catch (e) { return reject(e) }
    if (!out) reject(new Error('no export.xml in that archive'))
  })
}

function inflateExportSync(bytes) {
  const files = unzipSync(bytes, { filter: f => EXPORT_XML.test(f.name) })
  const name = Object.keys(files)[0]
  if (!name) throw new Error('no export.xml in that archive')
  return [files[name]]
}

/* Bytes to text, in one string because that is what the parser scans.
 *
 * Which is also the ceiling on this whole path: a JavaScript string cannot hold more than
 * about 512 MB, and an Apple Health export of many years with a watch can inflate past that.
 * The failure is a RangeError from the decoder and it is caught here and named, because
 * "something went wrong" for a person who has just waited two minutes is the worst possible
 * answer. Reading it in pieces means teaching the parser to scan across chunk boundaries —
 * worth doing when somebody actually hits this, and recorded in docs/WEARABLES.md. */
function decode(parts) {
  const dec = new TextDecoder('utf-8')
  try {
    if (parts.length === 1) return dec.decode(parts[0])
    let s = ''
    for (let i = 0; i < parts.length; i++) s += dec.decode(parts[i], { stream: i < parts.length - 1 })
    return s
  } catch (e) {
    if (e instanceof RangeError) {
      throw Object.assign(new Error('export too large to read in one piece'), { code: 'too_big' })
    }
    throw e
  }
}

/**
 * Read a picked file into a parsed import.
 *
 * `onProgress({ phase, pct })` is called throughout: phase is 'read', 'unzip' or 'parse', and
 * `pct` is 0–1 within that phase. A caller that only wants a label can ignore the number.
 */
export async function readExport(file, { unit = 'kg' } = {}, onProgress = () => {}) {
  const say = phase => pct => onProgress({ phase, pct })

  const bytes = await readBytes(file, say('read'))
  let text
  if (isZip(bytes)) {
    let parts
    try { parts = await inflateExport(bytes, say('unzip')) }
    catch (e) { if (e && e.code === 'too_big') throw e; parts = inflateExportSync(bytes) }
    text = decode(parts)
  } else {
    text = decode([bytes])
  }

  return parseImport(text, { unit, onProgress: pct => onProgress({ phase: 'parse', pct }) })
}
