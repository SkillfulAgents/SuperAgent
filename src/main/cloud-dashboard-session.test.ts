import { beforeEach, describe, expect, it, vi } from 'vitest'

const cookies = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}))

const {
  mintDeploymentSessionForDashboard,
  readCloudWorkspaceRecord,
  setCloudWorkspaceRecordClearedListener,
} = vi.hoisted(() => ({
  mintDeploymentSessionForDashboard: vi.fn(),
  readCloudWorkspaceRecord: vi.fn(),
  setCloudWorkspaceRecordClearedListener: vi.fn(),
}))

vi.mock('electron', () => ({
  session: { defaultSession: { cookies } },
}))

vi.mock('@shared/lib/services/cloud-workspace-service', () => ({
  mintDeploymentSessionForDashboard,
}))

vi.mock('@shared/lib/platform-auth/cloud-workspace-record', () => ({
  readCloudWorkspaceRecord,
  setCloudWorkspaceRecordClearedListener,
}))

import {
  clearCloudDashboardCookie,
  ensureCloudDashboardSession,
  hasCloudDashboardCookie,
  parseSessionSetCookie,
  plantCloudDashboardCookie,
  registerCloudDashboardCookieCleanup,
  sessionCookieNameForOrigin,
} from './cloud-dashboard-session'

const ORIGIN = 'https://ws.example.com'
const COOKIE_NAME = '__Secure-better-auth.session_token'
const LINE =
  `${COOKIE_NAME}=abc.sig; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=None`

function jarHasCookie(): void {
  cookies.get.mockResolvedValue([{ name: COOKIE_NAME, value: 'x' }])
}

function jarEmpty(): void {
  cookies.get.mockResolvedValue([])
}

beforeEach(() => {
  cookies.get.mockReset()
  cookies.set.mockReset()
  cookies.remove.mockReset()
  cookies.get.mockResolvedValue([])
  cookies.set.mockResolvedValue(undefined)
  cookies.remove.mockResolvedValue(undefined)
  mintDeploymentSessionForDashboard.mockReset()
  readCloudWorkspaceRecord.mockReset()
  setCloudWorkspaceRecordClearedListener.mockReset()
})

describe('parseSessionSetCookie', () => {
  it('keeps the signed value and requires the embed attributes', () => {
    const parsed = parseSessionSetCookie(LINE)
    expect(parsed).toMatchObject({
      name: COOKIE_NAME,
      value: 'abc.sig',
      httpOnly: true,
      secure: true,
      sameSiteNone: true,
      path: '/',
      maxAgeSec: 3600,
    })
  })

  it('rejects a missing Secure or SameSite=None', () => {
    expect(parseSessionSetCookie('better-auth.session_token=x; Path=/; HttpOnly; SameSite=Lax')).toMatchObject({
      sameSiteNone: false,
    })
  })
})

describe('plantCloudDashboardCookie', () => {
  it('translates Max-Age and omits domain', async () => {
    const planted = await plantCloudDashboardCookie(ORIGIN, [LINE])
    expect(planted).toBe(true)
    expect(cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `${ORIGIN}/`,
        name: COOKIE_NAME,
        value: 'abc.sig',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'no_restriction',
      }),
    )
    const details = cookies.set.mock.calls[0][0] as { expirationDate: number; domain?: string }
    expect(details.domain).toBeUndefined()
    expect(details.expirationDate).toBeGreaterThan(Date.now() / 1000)
  })

  it('does not plant a Lax cookie', async () => {
    const planted = await plantCloudDashboardCookie(ORIGIN, [
      `${COOKIE_NAME}=x; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ])
    expect(planted).toBe(false)
    expect(cookies.set).not.toHaveBeenCalled()
  })

  it('reports presence and clears by name', async () => {
    jarHasCookie()
    expect(sessionCookieNameForOrigin(ORIGIN)).toBe(COOKIE_NAME)
    await expect(hasCloudDashboardCookie(ORIGIN)).resolves.toBe(true)
    await clearCloudDashboardCookie(ORIGIN)
    expect(cookies.remove).toHaveBeenCalledWith(`${ORIGIN}/`, COOKIE_NAME)
  })
})

describe('ensureCloudDashboardSession', () => {
  it('stays on the door when the window is driving Local', async () => {
    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    jarHasCookie()
    await expect(ensureCloudDashboardSession('local')).resolves.toEqual({
      useCloudOrigin: false,
      origin: null,
    })
    expect(mintDeploymentSessionForDashboard).not.toHaveBeenCalled()
    expect(cookies.get).not.toHaveBeenCalled()
  })

  it('stays on the door when no workspace record exists', async () => {
    readCloudWorkspaceRecord.mockReturnValue(null)
    await expect(ensureCloudDashboardSession('cloud')).resolves.toEqual({
      useCloudOrigin: false,
      origin: null,
    })
    expect(mintDeploymentSessionForDashboard).not.toHaveBeenCalled()
  })

  it('uses the cloud origin when the jar already has a cookie', async () => {
    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: `${ORIGIN}/` })
    jarHasCookie()
    await expect(ensureCloudDashboardSession('cloud')).resolves.toEqual({
      useCloudOrigin: true,
      origin: ORIGIN,
    })
    expect(mintDeploymentSessionForDashboard).not.toHaveBeenCalled()
  })

  it('plants after a forced connect and then uses the cloud origin', async () => {
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

  it('falls back to the door when mint returns nothing', async () => {
    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    jarEmpty()
    mintDeploymentSessionForDashboard.mockResolvedValue(null)
    await expect(ensureCloudDashboardSession('cloud')).resolves.toEqual({
      useCloudOrigin: false,
      origin: ORIGIN,
    })
    expect(cookies.set).not.toHaveBeenCalled()
  })

  it('falls back to the door when plant does not leave a cookie', async () => {
    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    jarEmpty()
    mintDeploymentSessionForDashboard.mockResolvedValue({
      deploymentUrl: ORIGIN,
      setCookies: [],
    })
    await expect(ensureCloudDashboardSession('cloud')).resolves.toEqual({
      useCloudOrigin: false,
      origin: ORIGIN,
    })
  })

  it('does not plant when the workspace is cleared during mint', async () => {
    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    jarEmpty()
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

  it('clears a plant that finished after the workspace disappeared', async () => {
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

  it('does not restore a cookie after disconnect wins the race', async () => {
    let onCleared: ((url: string) => void) | undefined
    setCloudWorkspaceRecordClearedListener.mockImplementation((listener) => {
      onCleared = listener
    })
    registerCloudDashboardCookieCleanup()

    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    jarEmpty()
    let finishMint!: (value: { deploymentUrl: string; setCookies: string[] }) => void
    mintDeploymentSessionForDashboard.mockReturnValue(
      new Promise((resolve) => {
        finishMint = resolve
      }),
    )

    const pending = ensureCloudDashboardSession('cloud')
    await vi.waitFor(() => {
      expect(mintDeploymentSessionForDashboard).toHaveBeenCalled()
    })
    readCloudWorkspaceRecord.mockReturnValue(null)
    onCleared?.(`${ORIGIN}/`)
    finishMint({ deploymentUrl: ORIGIN, setCookies: [LINE] })

    await expect(pending).resolves.toEqual({
      useCloudOrigin: false,
      origin: ORIGIN,
    })
    expect(cookies.set).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(cookies.remove).toHaveBeenCalledWith(`${ORIGIN}/`, COOKIE_NAME)
    })
  })

  it('does not accept a leftover cookie after a waiter outlives a same-origin switch', async () => {
    let onCleared: ((url: string) => void) | undefined
    setCloudWorkspaceRecordClearedListener.mockImplementation((listener) => {
      onCleared = listener
    })
    registerCloudDashboardCookieCleanup()

    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    jarEmpty()
    let finishMint!: (value: { deploymentUrl: string; setCookies: string[] }) => void
    mintDeploymentSessionForDashboard.mockReturnValue(
      new Promise((resolve) => {
        finishMint = resolve
      }),
    )

    const first = ensureCloudDashboardSession('cloud')
    await vi.waitFor(() => {
      expect(mintDeploymentSessionForDashboard).toHaveBeenCalled()
    })
    const second = ensureCloudDashboardSession('cloud')
    await Promise.resolve()

    onCleared?.(`${ORIGIN}/`)
    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    jarHasCookie()
    finishMint({ deploymentUrl: ORIGIN, setCookies: [LINE] })

    await expect(first).resolves.toMatchObject({ useCloudOrigin: false })
    await expect(second).resolves.toEqual({
      useCloudOrigin: false,
      origin: null,
    })
  })

  it('does not report the cloud origin after a clear during the last cookie lookup', async () => {
    let onCleared: ((url: string) => void) | undefined
    setCloudWorkspaceRecordClearedListener.mockImplementation((listener) => {
      onCleared = listener
    })
    registerCloudDashboardCookieCleanup()

    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    let finishLookup!: (value: unknown) => void
    cookies.get
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          finishLookup = resolve
        }),
      )
    mintDeploymentSessionForDashboard.mockResolvedValue({
      deploymentUrl: ORIGIN,
      setCookies: [LINE],
    })

    const pending = ensureCloudDashboardSession('cloud')
    await vi.waitFor(() => {
      expect(cookies.set).toHaveBeenCalled()
    })
    readCloudWorkspaceRecord.mockReturnValue(null)
    onCleared?.(`${ORIGIN}/`)
    finishLookup([{ name: COOKIE_NAME, value: 'x' }])

    await expect(pending).resolves.toEqual({
      useCloudOrigin: false,
      origin: null,
    })
    expect(cookies.remove).toHaveBeenCalledWith(`${ORIGIN}/`, COOKIE_NAME)
  })
})
