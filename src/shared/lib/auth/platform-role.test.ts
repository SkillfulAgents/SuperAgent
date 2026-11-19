import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const captureExceptionMock = vi.hoisted(() => vi.fn())
vi.mock('@shared/lib/error-reporting', () => ({ captureException: captureExceptionMock }))
vi.mock('@shared/lib/config/settings', () => ({ DEFAULT_AUTH_SETTINGS: {}, getSettings: () => ({}) }))

import { notePlatformRole, platformJoinRole, runAuthRequest } from './platform-role'

describe('platform role store', () => {
  beforeEach(() => {
    captureExceptionMock.mockReset()
    vi.stubEnv('AUTH_MODE', 'true')
    vi.stubEnv('PLATFORM_TOKEN', `e30.${Buffer.from(JSON.stringify({ orgId: 'org_1' })).toString('base64url')}.sig`)
  })
  afterEach(() => vi.unstubAllEnvs())

  it('carries the role noted during an auth request to the user create hook', () => {
    expect(runAuthRequest(() => {
      notePlatformRole('owner')
      return platformJoinRole()
    })).toBe('admin')
    expect(captureExceptionMock).not.toHaveBeenCalled()
  })

  it('reports a Platform sign-in that runs outside an auth request', () => {
    notePlatformRole('owner')
    expect(platformJoinRole()).toBeUndefined()
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Platform sign-in outside an auth request' }),
      expect.anything(),
    )
  })
})
