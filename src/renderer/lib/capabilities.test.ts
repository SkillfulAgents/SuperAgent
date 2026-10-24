import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIsElectron } = vi.hoisted(() => ({ mockIsElectron: vi.fn(() => true) }))
vi.mock('./env', () => ({ isElectron: mockIsElectron }))

import { _resetApiTargetForTest, setActiveTarget } from './api-target'
import { canUseHostFeatures, computerUseSupported } from './capabilities'
import { _setFactsForTest } from './facts'
import type { ServerFacts } from '@shared/lib/facts/facts-schema'

beforeEach(() => {
  mockIsElectron.mockReturnValue(true)
  _resetApiTargetForTest()
})

afterEach(() => {
  _resetApiTargetForTest()
})

describe('canUseHostFeatures', () => {
  it('is true for the desktop app driving its own machine', () => {
    setActiveTarget('local', null)
    expect(canUseHostFeatures()).toBe(true)
  })

  it('is false in cloud mode, where Electron is still present but is the wrong machine', () => {
    // The whole point of the predicate: isElectron() stays true here, so every
    // site that asked it would keep offering a directory picker, a Finder call
    // or a Docker install for a laptop that runs none of the agents.
    setActiveTarget('cloud', null)
    expect(mockIsElectron()).toBe(true)
    expect(canUseHostFeatures()).toBe(false)
  })

  it('is false in the browser', () => {
    mockIsElectron.mockReturnValue(false)
    setActiveTarget('local', null)
    expect(canUseHostFeatures()).toBe(false)
  })
})

describe('computerUseSupported', () => {
  function withServer(server: ServerFacts | null) {
    // A Linux laptop, so an answer that read the window's OS would be wrong.
    _setFactsForTest({ client: { shell: 'electron', os: 'linux', distribution: 'direct' }, server })
  }

  it.each([
    ['darwin', true],
    ['win32', true],
    ['linux', false],
    ['other', false],
  ] as const)('asks the agents’ machine: %s → %s', (os, supported) => {
    withServer({ os, distribution: 'deployment' })
    expect(computerUseSupported()).toBe(supported)
  })

  it('is false when the server didn’t say', () => {
    withServer(null)
    expect(computerUseSupported()).toBe(false)
  })
})
