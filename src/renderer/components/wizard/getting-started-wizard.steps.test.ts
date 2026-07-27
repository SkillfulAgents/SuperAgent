import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockCanUseHostFeatures } = vi.hoisted(() => ({
  mockCanUseHostFeatures: vi.fn(() => true),
}))
vi.mock('@renderer/lib/host-features', () => ({ canUseHostFeatures: mockCanUseHostFeatures }))

import { stepsForPath } from './getting-started-wizard'

/**
 * The runtime step installs and starts a container runtime on the computer
 * running this app — down to opening the Docker Desktop download page and
 * telling you to run `wsl --install` as Administrator. A cloud workspace brings
 * its own runtime, and it is not this machine's to set up.
 */

const ids = (path: 'platform' | 'manual' | null) => stepsForPath(path).map((s) => s.id)

beforeEach(() => {
  mockCanUseHostFeatures.mockReturnValue(true)
})

describe('stepsForPath', () => {
  it('includes the runtime step when this computer runs the agents', () => {
    expect(ids('manual')).toContain('runtime')
    expect(ids('platform')).toContain('runtime')
  })

  it('drops it for a cloud workspace, on both paths', () => {
    mockCanUseHostFeatures.mockReturnValue(false)
    expect(ids('manual')).not.toContain('runtime')
    expect(ids('platform')).not.toContain('runtime')
  })

  it('leaves every other step in place and in order', () => {
    mockCanUseHostFeatures.mockReturnValue(false)
    expect(ids('manual')).toEqual(['llm', 'model', 'browser', 'composio', 'privacy', 'agent'])
    expect(ids('platform')).toEqual(['model', 'browser', 'privacy', 'agent'])
  })

  it('has no steps before a path is chosen', () => {
    expect(ids(null)).toEqual([])
  })

  it('is the single source of positions, so a step id maps to one index', () => {
    // Both the renderer and the saved-progress restore turn a step id into a
    // position. Reading one from the filtered list and the other from the
    // constant puts a cloud user on a different step than the one they left.
    mockCanUseHostFeatures.mockReturnValue(false)
    const rendered = stepsForPath('manual')
    const restored = stepsForPath('manual')
    expect(restored.findIndex((s) => s.id === 'privacy')).toBe(
      rendered.findIndex((s) => s.id === 'privacy'),
    )
    expect(restored.findIndex((s) => s.id === 'privacy')).toBe(4)
  })
})
