// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'

import { clearBootSettledLatch, hasBootSettledLatch, setBootSettledLatch } from './boot-settled'

afterEach(() => {
  localStorage.clear()
})

describe('boot-settled latch', () => {
  it('reads false when nothing was latched', () => {
    expect(hasBootSettledLatch()).toBe(false)
  })

  it('reads true after latching', () => {
    setBootSettledLatch()
    expect(hasBootSettledLatch()).toBe(true)
  })

  it('reads false again after clearing', () => {
    setBootSettledLatch()
    clearBootSettledLatch()
    expect(hasBootSettledLatch()).toBe(false)
  })

  it('ignores foreign values under the key', () => {
    localStorage.setItem('superagent-boot-settled', 'yes')
    expect(hasBootSettledLatch()).toBe(false)
  })
})
