/* The import, off the main thread.
 *
 * Reading, inflating and scanning an Apple Health export is seconds of work on a phone, and
 * all of it is synchronous once it starts. On the main thread that is a frozen app: the
 * progress bar this exists to feed would not repaint, the sheet would not close, and a phone
 * would offer to kill the tab. So the file goes to a worker and only the result comes back.
 *
 * The result is small — a few hundred sessions and weigh-ins — which is the other half of the
 * argument. The half-gigabyte string never exists in the window's heap at all.
 */
import { readExport } from './read-export.js'

self.onmessage = async e => {
  const { file, opts } = e.data
  try {
    const parsed = await readExport(file, opts, p => self.postMessage({ progress: p }))
    self.postMessage({ parsed })
  } catch (err) {
    // Errors do not survive structured cloning with anything useful attached, so the two
    // fields the caller acts on are sent as data.
    self.postMessage({ error: { message: String(err && err.message || err), code: err && err.code } })
  }
}
