import { describe, expect, it } from 'vitest'

import { appVersionsMatch, formatAppVersion, normalizeAppVersion } from './app-version'

describe('normalizeAppVersion', () => {
  it('strips a leading v', () => {
    expect(normalizeAppVersion('v0.5.0')).toBe('0.5.0')
    expect(normalizeAppVersion('V0.5.1-rc.1')).toBe('0.5.1-rc.1')
  })

  it('trims whitespace and leaves bare versions alone', () => {
    expect(normalizeAppVersion('  0.5.0  ')).toBe('0.5.0')
  })
})

describe('formatAppVersion', () => {
  it('always prefixes a single v', () => {
    expect(formatAppVersion('0.5.0')).toBe('v0.5.0')
    expect(formatAppVersion('v0.5.0')).toBe('v0.5.0')
  })

  it('returns empty for blank input', () => {
    expect(formatAppVersion('   ')).toBe('')
  })
})

describe('appVersionsMatch', () => {
  it('treats v-prefixed and bare forms as equal', () => {
    expect(appVersionsMatch('v0.5.0', '0.5.0')).toBe(true)
  })

  it('is false when releases differ or either side is blank', () => {
    expect(appVersionsMatch('v0.5.0', 'v0.5.1-rc.1')).toBe(false)
    expect(appVersionsMatch('', 'v0.5.0')).toBe(false)
  })
})
