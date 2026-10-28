import { beforeEach, describe, expect, it } from 'vitest'

import {
  _resetCloudProxyKeyForTest,
  getCloudProxyKey,
  isCloudProxyKey,
} from './cloud-proxy-key'

describe('cloud proxy key', () => {
  beforeEach(() => {
    _resetCloudProxyKeyForTest()
  })

  it('is stable for the lifetime of the process', () => {
    expect(getCloudProxyKey()).toBe(getCloudProxyKey())
  })

  it('is a fresh secret per boot', () => {
    const first = getCloudProxyKey()
    _resetCloudProxyKeyForTest()
    expect(getCloudProxyKey()).not.toBe(first)
  })

  it('is a single path segment needing no escaping', () => {
    // The key lives in the URL, so anything requiring percent-encoding would be
    // compared post-decode — or not at all.
    expect(getCloudProxyKey()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('accepts itself', () => {
    expect(isCloudProxyKey(getCloudProxyKey())).toBe(true)
  })

  it('rejects a different value of the same length', () => {
    const sameLength = 'x'.repeat(getCloudProxyKey().length)
    expect(isCloudProxyKey(sameLength)).toBe(false)
  })

  it('rejects a prefix of itself rather than throwing on the length mismatch', () => {
    expect(isCloudProxyKey(getCloudProxyKey().slice(0, 10))).toBe(false)
  })

  it('rejects the empty string', () => {
    expect(isCloudProxyKey('')).toBe(false)
  })
})
