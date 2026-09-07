import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

// A file:// URL rather than a path: an absolute Windows path is not a valid import specifier
// — node reads `C:` as an unsupported URL scheme — so building one here fails on Windows only.
const INDEX = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js')).href

describe('domain package runs outside a bundler', () => {
  // Vitest transforms modules, so `import.meta.env` would resolve here and hide the bug this
  // guards against. Only a real `node` process proves the contract — the API and the seeder
  // import this package with no bundler in front of it.
  it('imports cleanly in a bare node process and computes something real', () => {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const m = await import(${JSON.stringify(INDEX)})
      const ex = m.EXIDX['0001']
      console.log(JSON.stringify({
        exercises: m.EXDB.length,
        img: m.imgSrc(ex),
        oneRM: m.estimate1RM(100, 5),
        english: m.exCount(2)
      }))
    `], { encoding: 'utf8', timeout: 30000 })
    const r = JSON.parse(out)
    expect(r.exercises).toBe(1324)
    expect(r.img).toMatch(/^img\//)
    expect(r.oneRM).toBeGreaterThan(100)
    expect(r.english).toBe('2 exercises')
  })
})

/* The domain may not reach the retrieval corpus. See docs/AI_TIERS.md, constraint 3.
 *
 * The premium tier answers from published literature, and the one thing that must never follow
 * from that is a paper influencing a number. `planner.js` computes sets, reps, loads and
 * exercise selection; `progression.js` decides what happens after a missed AMRAP. If either
 * could read the store, "the literature never touches a number" would be a promise maintained by
 * everybody remembering it, and the review and the app could start disagreeing about the same
 * lifter — which ARCHITECTURE.md says explicitly must never happen.
 *
 * Retrieval is what makes this checkable at all: a fine-tune would have put the same influence
 * inside a model's weights, where no test could see it. Here it is an import, and an import can
 * be asserted about.
 */
describe('what the domain is allowed to depend on', () => {
  it('cannot reach the corpus, the database, or anything that could', async () => {
    const { readdir, readFile } = await import('node:fs/promises')
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const files = (await readdir(dir)).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
    expect(files.length).toBeGreaterThan(10)

    const forbidden = /@gymyar\/(db|ai)|from ['"](postgres|pg)['"]|corpus/
    const offenders = []
    for (const f of files) {
      const body = await readFile(path.join(dir, f), 'utf8')
      for (const line of body.split(/\r?\n/)) {
        if (/^\s*import\s/.test(line) && forbidden.test(line)) offenders.push(`${f}: ${line.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
