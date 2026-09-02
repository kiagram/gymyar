/* Run the import in a worker, and fall back to this thread when there is not one.
 *
 * The fallback is not defensive padding: a module worker needs `type: 'module'` support, and
 * the WebViews this ships to through Cafe Bazaar and Myket are whatever version of Chrome the
 * phone last received. If the worker cannot be constructed the import still has to work —
 * slower, and with the app unresponsive while it runs, which is worse than a worker and far
 * better than a file picker that does nothing.
 */
import { readExport } from './read-export.js'

/**
 * @param file        the File the user picked
 * @param opts        { unit } — the profile's weight unit, for conversion
 * @param onProgress  ({ phase, pct }) => void, phase being 'read' | 'unzip' | 'parse'
 * @returns the parsed import, as `parseImport` returns it
 */
export function runImport(file, opts, onProgress) {
  let worker
  try {
    worker = new Worker(new URL('./import-worker.js', import.meta.url), { type: 'module' })
  } catch {
    return readExport(file, opts, onProgress)
  }
  return new Promise((resolve, reject) => {
    worker.onmessage = e => {
      const { progress, parsed, error } = e.data
      if (progress) return onProgress(progress)
      worker.terminate()
      if (error) reject(Object.assign(new Error(error.message), { code: error.code }))
      else resolve(parsed)
    }
    // A worker that fails to *load* — an import inside it the WebView cannot parse — reports
    // it here rather than by throwing above, so the fallback belongs on this path too.
    worker.onerror = () => {
      worker.terminate()
      readExport(file, opts, onProgress).then(resolve, reject)
    }
    worker.postMessage({ file, opts })
  })
}
