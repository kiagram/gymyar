import { describe, it, expect } from 'vitest'
import { versionCode } from './version.mjs'

describe('the android version code', () => {
  it('reads back to the version at a glance', () => {
    expect(versionCode('1.2.3')).toBe(10203)
    expect(versionCode('1.0.0')).toBe(10000)
    expect(versionCode('0.1.0')).toBe(100)
  })

  it('rises with every part of the version', () => {
    // The whole point: Android refuses an update whose code did not increase.
    expect(versionCode('1.0.1')).toBeGreaterThan(versionCode('1.0.0'))
    expect(versionCode('1.1.0')).toBeGreaterThan(versionCode('1.0.99'))
    expect(versionCode('2.0.0')).toBeGreaterThan(versionCode('1.99.99'))
  })

  it('clears the numbers openGym left behind', () => {
    // The fork inherited versionCode 5. Anything we ship has to beat it or updates from an
    // openGym install would be refused.
    expect(versionCode('1.0.0')).toBeGreaterThan(5)
  })

  it('refuses a version the scheme cannot represent', () => {
    expect(() => versionCode('1.100.0')).toThrow(/under 100/)
    expect(() => versionCode('1.0.100')).toThrow(/under 100/)
  })

  it('refuses anything that is not plain semver — a store will not take it either', () => {
    expect(() => versionCode('1.0.0-beta.1')).toThrow(/plain semver/)
    expect(() => versionCode('1.0')).toThrow(/plain semver/)
    expect(() => versionCode('v1.0.0')).toThrow(/plain semver/)
  })
})
