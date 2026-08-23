import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { hostsIn, unexpected, ALLOWED } from './check-mobile-hosts.mjs'

const bundle = contents => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gb-hosts-'))
  for (const [name, body] of Object.entries(contents)) writeFileSync(path.join(dir, name), body)
  return dir
}

describe('finding hosts in a built bundle', () => {
  it('finds them across every js file, and ignores everything else', () => {
    const dir = bundle({
      'a.js': 'fetch("https://cdn.jsdelivr.net/x")',
      'b.js': 'const u = "http://localhost:3000"',
      'c.css': 'background: url(https://evil.example/bg.png)',
      'index.html': '<script src="https://also-ignored.example"></script>'
    })
    const hosts = hostsIn(dir)

    expect([...hosts.keys()].sort()).toEqual(['cdn.jsdelivr.net', 'localhost'])
  })

  it('reports which file a host first appeared in, so it can be chased down', () => {
    const dir = bundle({ 'chunk-abc.js': 'https://cdn.jsdelivr.net/x' })
    expect(hostsIn(dir).get('cdn.jsdelivr.net')).toBe('chunk-abc.js')
  })

  it('is case-insensitive and drops a trailing dot', () => {
    // Both are ways of writing the same host that a naive check would miss.
    const dir = bundle({ 'a.js': 'https://CDN.JsDelivr.NET/x https://github.com./y' })
    expect([...hostsIn(dir).keys()].sort()).toEqual(['cdn.jsdelivr.net', 'github.com'])
  })
})

describe('what counts as unexpected', () => {
  it('passes a bundle that only mentions accounted-for hosts', () => {
    const dir = bundle({ 'a.js': Object.keys(ALLOWED).map(h => `https://${h}/x`).join(' ') })
    expect(unexpected(hostsIn(dir))).toEqual([])
  })

  it('catches the thing this check exists for', () => {
    // An analytics SDK added to debug one problem and never taken out again.
    const dir = bundle({ 'a.js': 'https://cdn.jsdelivr.net/x;https://www.google-analytics.com/collect' })
    expect(unexpected(hostsIn(dir))).toEqual(['www.google-analytics.com'])
  })

  it('catches a subdomain of an allowed host rather than waving it through', () => {
    // `fonts.googleapis.com` being allowed must not imply anything about `googleapis.com`,
    // and an allowed `github.com` must not admit `raw.github.com`.
    const dir = bundle({ 'a.js': 'https://raw.github.com/x' })
    expect(unexpected(hostsIn(dir))).toEqual(['raw.github.com'])
  })

  it('says why every allowed host is allowed', () => {
    // The reason is the whole value of the list — it is what the next person reads when
    // deciding whether the store declaration is still honest.
    for (const [host, why] of Object.entries(ALLOWED)) {
      expect(why, host).toBeTruthy()
      expect(why.length, host).toBeGreaterThan(10)
    }
  })

  it('allows exactly one host that is actually fetched', () => {
    const fetched = Object.entries(ALLOWED).filter(([, why]) => /outbound request/.test(why))
    expect(fetched.map(([h]) => h)).toEqual(['cdn.jsdelivr.net'])
  })
})
