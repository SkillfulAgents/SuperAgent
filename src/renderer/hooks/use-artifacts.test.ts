import { describe, it, expect } from 'vitest'
import { artifactsRefetchIntervalMs, type ArtifactInfo } from './use-artifacts'

function artifact(status: ArtifactInfo['status'], slug = 'dash'): ArtifactInfo {
  return { slug, name: slug, description: '', status, port: 1 }
}

describe('artifactsRefetchIntervalMs', () => {
  it('escalates only when pollFast is requested or some dashboard is starting', () => {
    expect(artifactsRefetchIntervalMs(undefined, false)).toBe(60_000)
    expect(artifactsRefetchIntervalMs([artifact('stopped')], false)).toBe(60_000)
    expect(artifactsRefetchIntervalMs([artifact('starting')], false)).toBe(1_000)
    expect(artifactsRefetchIntervalMs([artifact('stopped')], true)).toBe(1_000)
    expect(artifactsRefetchIntervalMs(undefined, true)).toBe(1_000)
  })
})
