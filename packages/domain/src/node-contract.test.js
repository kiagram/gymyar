import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js')

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
