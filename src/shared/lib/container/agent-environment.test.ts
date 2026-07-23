import { describe, it, expect, afterEach, vi } from 'vitest'
import { resolveAgentEnvironment, agentEnvironmentSchema } from './agent-environment'

const origType = (process as { type?: string }).type
const origUrl = process.env.HOST_PUBLIC_URL

afterEach(() => {
  if (origType === undefined) delete (process as { type?: string }).type
  else (process as { type?: string }).type = origType
  if (origUrl === undefined) delete process.env.HOST_PUBLIC_URL
  else process.env.HOST_PUBLIC_URL = origUrl
  vi.restoreAllMocks()
})

describe('resolveAgentEnvironment', () => {
  it('returns desktop when running in the Electron main process', () => {
    ;(process as { type?: string }).type = 'browser'
    expect(resolveAgentEnvironment()).toEqual({ surface: 'desktop' })
  })

  it('returns web with publicUrl when non-Electron and HOST_PUBLIC_URL is set', () => {
    delete (process as { type?: string }).type
    process.env.HOST_PUBLIC_URL = 'https://app.example.com'
    expect(resolveAgentEnvironment()).toEqual({ surface: 'web', publicUrl: 'https://app.example.com' })
  })

  it('returns web WITHOUT publicUrl when non-Electron and HOST_PUBLIC_URL is unset (self-hosted Docker)', () => {
    delete (process as { type?: string }).type
    delete process.env.HOST_PUBLIC_URL
    expect(resolveAgentEnvironment()).toEqual({ surface: 'web' })
  })

  it('schema rejects the illegal desktop-with-publicUrl state', () => {
    expect(agentEnvironmentSchema.safeParse({ surface: 'desktop', publicUrl: 'x' }).success).toBe(false)
  })
})
