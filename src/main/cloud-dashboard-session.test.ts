import { beforeEach, describe, expect, it, vi } from 'vitest'

const cookies = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}))

const {
  mintDeploymentSessionForDashboard,
  readCloudWorkspaceRecord,
} = vi.hoisted(() => ({
  mintDeploymentSessionForDashboard: vi.fn(),
  readCloudWorkspaceRecord: vi.fn(),
}))

vi.mock('electron', () => ({
  session: { defaultSession: { cookies } },
}))

vi.mock('@shared/lib/services/cloud-workspace-service', () => ({
  mintDeploymentSessionForDashboard,
}))

vi.mock('@shared/lib/platform-auth/cloud-workspace-record', () => ({
  readCloudWorkspaceRecord,
  setCloudWorkspaceRecordClearedListener: vi.fn(),
}))

import {
  clearCloudDashboardCookie,
  ensureCloudDashboardSession,
  hasCloudDashboardCookie,
  parseSessionSetCookie,
  plantCloudDashboardCookie,
  sessionCookieNameForOrigin,
} from './cloud-dashboard-session'

const ORIGIN = 'https://ws.example.com'
const COOKIE_NAME = '__Secure-better-auth.session_token'
const LINE =
  `${COOKIE_NAME}=abc.sig; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=None`

beforeEach(() => {
  cookies.get.mockReset()
  cookies.set.mockReset()
  cookies.remove.mockReset()
  cookies.get.mockResolvedValue([])
  cookies.set.mockResolvedValue(undefined)
  cookies.remove.mockResolvedValue(undefined)
  mintDeploymentSessionForDashboard.mockReset()
  readCloudWorkspaceRecord.mockReset()
})

describe('parseSessionSetCookie', () => {
  it('keeps the signed value and requires the embed attributes', () => {
    expect(parseSessionSetCookie(LINE)).toMatchObject({
      name: COOKIE_NAME,
      value: 'abc.sig',
      httpOnly: true,
      secure: true,
      sameSiteNone: true,
      path: '/',
      maxAgeSec: 3600,
    })
  })

  it('does not treat a Lax cookie as plantable', () => {
    expect(parseSessionSetCookie('better-auth.session_token=x; Path=/; HttpOnly; SameSite=Lax')).toMatchObject({
      sameSiteNone: false,
    })
  })
})

describe('plantCloudDashboardCookie', () => {
  it('translates Max-Age and omits domain', async () => {
    await expect(plantCloudDashboardCookie(ORIGIN, [LINE])).resolves.toBe(true)
    expect(cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `${ORIGIN}/`,
        name: COOKIE_NAME,
        value: 'abc.sig',
        sameSite: 'no_restriction',
      }),
    )
    expect((cookies.set.mock.calls[0][0] as { domain?: string }).domain).toBeUndefined()
  })

  it('does not plant a Lax cookie', async () => {
    await expect(plantCloudDashboardCookie(ORIGIN, [
      `${COOKIE_NAME}=x; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ])).resolves.toBe(false)
    expect(cookies.set).not.toHaveBeenCalled()
  })

  it('reports presence and clears by name', async () => {
    cookies.get.mockResolvedValue([{ name: COOKIE_NAME, value: 'x' }])
    expect(sessionCookieNameForOrigin(ORIGIN)).toBe(COOKIE_NAME)
    await expect(hasCloudDashboardCookie(ORIGIN)).resolves.toBe(true)
    await clearCloudDashboardCookie(ORIGIN)
    expect(cookies.remove).toHaveBeenCalledWith(`${ORIGIN}/`, COOKIE_NAME)
  })
})

describe('ensureCloudDashboardSession', () => {
  it('stays on the door when the window is driving Local', async () => {
    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    cookies.get.mockResolvedValue([{ name: COOKIE_NAME, value: 'x' }])
    await expect(ensureCloudDashboardSession('local')).resolves.toEqual({
      useCloudOrigin: false,
      origin: null,
    })
    expect(mintDeploymentSessionForDashboard).not.toHaveBeenCalled()
  })

  it('uses the cloud origin when the jar already has a cookie', async () => {
    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: `${ORIGIN}/` })
    cookies.get.mockResolvedValue([{ name: COOKIE_NAME, value: 'x' }])
    await expect(ensureCloudDashboardSession('cloud')).resolves.toEqual({
      useCloudOrigin: true,
      origin: ORIGIN,
    })
    expect(mintDeploymentSessionForDashboard).not.toHaveBeenCalled()
  })

  it('plants after a connect and then uses the cloud origin', async () => {
    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    cookies.get
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: COOKIE_NAME, value: 'x' }])
    mintDeploymentSessionForDashboard.mockResolvedValue({
      deploymentUrl: ORIGIN,
      setCookies: [LINE],
    })
    await expect(ensureCloudDashboardSession('cloud')).resolves.toEqual({
      useCloudOrigin: true,
      origin: ORIGIN,
    })
    expect(cookies.set).toHaveBeenCalled()
  })

  it('stays on the door when mint returns nothing', async () => {
    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    mintDeploymentSessionForDashboard.mockResolvedValue(null)
    await expect(ensureCloudDashboardSession('cloud')).resolves.toEqual({
      useCloudOrigin: false,
      origin: ORIGIN,
    })
    expect(cookies.set).not.toHaveBeenCalled()
  })

  it('does not plant when the workspace is gone after mint', async () => {
    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    mintDeploymentSessionForDashboard.mockImplementation(async () => {
      readCloudWorkspaceRecord.mockReturnValue(null)
      return { deploymentUrl: ORIGIN, setCookies: [LINE] }
    })
    await expect(ensureCloudDashboardSession('cloud')).resolves.toEqual({
      useCloudOrigin: false,
      origin: ORIGIN,
    })
    expect(cookies.set).not.toHaveBeenCalled()
  })

  it('clears a plant if the workspace disappeared during it', async () => {
    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    cookies.get
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: COOKIE_NAME, value: 'x' }])
    mintDeploymentSessionForDashboard.mockResolvedValue({
      deploymentUrl: ORIGIN,
      setCookies: [LINE],
    })
    cookies.set.mockImplementation(async () => {
      readCloudWorkspaceRecord.mockReturnValue(null)
    })
    await expect(ensureCloudDashboardSession('cloud')).resolves.toEqual({
      useCloudOrigin: false,
      origin: null,
    })
    expect(cookies.remove).toHaveBeenCalledWith(`${ORIGIN}/`, COOKIE_NAME)
  })
})
