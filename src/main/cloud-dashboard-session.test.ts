import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  hasCloudDashboardCookie,
  plantCloudDashboardCookie,
  clearCloudDashboardCookie,
  mintDeploymentSessionForDashboard,
  readCloudWorkspaceRecord,
  setCloudWorkspaceRecordClearedListener,
} = vi.hoisted(() => ({
  hasCloudDashboardCookie: vi.fn(),
  plantCloudDashboardCookie: vi.fn(),
  clearCloudDashboardCookie: vi.fn(),
  mintDeploymentSessionForDashboard: vi.fn(),
  readCloudWorkspaceRecord: vi.fn(),
  setCloudWorkspaceRecordClearedListener: vi.fn(),
}))

vi.mock('./cloud-dashboard-cookie', () => ({
  hasCloudDashboardCookie,
  plantCloudDashboardCookie,
  clearCloudDashboardCookie,
}))

vi.mock('@shared/lib/services/cloud-workspace-service', () => ({
  mintDeploymentSessionForDashboard,
}))

vi.mock('@shared/lib/platform-auth/cloud-workspace-record', () => ({
  readCloudWorkspaceRecord,
  setCloudWorkspaceRecordClearedListener,
}))

import {
  ensureCloudDashboardSession,
  registerCloudDashboardCookieCleanup,
} from './cloud-dashboard-session'

const ORIGIN = 'https://ws.example.com'
const COOKIE = '__Secure-better-auth.session_token=x; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=None'

beforeEach(() => {
  hasCloudDashboardCookie.mockReset()
  plantCloudDashboardCookie.mockReset()
  clearCloudDashboardCookie.mockReset()
  mintDeploymentSessionForDashboard.mockReset()
  readCloudWorkspaceRecord.mockReset()
  setCloudWorkspaceRecordClearedListener.mockReset()
  clearCloudDashboardCookie.mockResolvedValue(undefined)
})

describe('ensureCloudDashboardSession', () => {
  it('stays on the door when the window is driving Local', async () => {
    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    hasCloudDashboardCookie.mockResolvedValue(true)
    await expect(ensureCloudDashboardSession('local')).resolves.toEqual({
      useCloudOrigin: false,
      origin: null,
    })
    expect(mintDeploymentSessionForDashboard).not.toHaveBeenCalled()
    expect(hasCloudDashboardCookie).not.toHaveBeenCalled()
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
    hasCloudDashboardCookie.mockResolvedValue(true)
    await expect(ensureCloudDashboardSession('cloud')).resolves.toEqual({
      useCloudOrigin: true,
      origin: ORIGIN,
    })
    expect(mintDeploymentSessionForDashboard).not.toHaveBeenCalled()
  })

  it('plants after a forced connect and then uses the cloud origin', async () => {
    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    hasCloudDashboardCookie.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    mintDeploymentSessionForDashboard.mockResolvedValue({
      deploymentUrl: ORIGIN,
      setCookies: [COOKIE],
    })
    plantCloudDashboardCookie.mockResolvedValue(true)

    await expect(ensureCloudDashboardSession('cloud')).resolves.toEqual({
      useCloudOrigin: true,
      origin: ORIGIN,
    })
    expect(plantCloudDashboardCookie).toHaveBeenCalledWith(ORIGIN, expect.any(Array))
  })

  it('falls back to the door when mint returns nothing', async () => {
    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    hasCloudDashboardCookie.mockResolvedValue(false)
    mintDeploymentSessionForDashboard.mockResolvedValue(null)
    await expect(ensureCloudDashboardSession('cloud')).resolves.toEqual({
      useCloudOrigin: false,
      origin: ORIGIN,
    })
    expect(plantCloudDashboardCookie).not.toHaveBeenCalled()
  })

  it('falls back to the door when plant does not leave a cookie', async () => {
    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    hasCloudDashboardCookie.mockResolvedValue(false)
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
    hasCloudDashboardCookie.mockResolvedValue(false)
    mintDeploymentSessionForDashboard.mockImplementation(async () => {
      readCloudWorkspaceRecord.mockReturnValue(null)
      return { deploymentUrl: ORIGIN, setCookies: [COOKIE] }
    })
    await expect(ensureCloudDashboardSession('cloud')).resolves.toEqual({
      useCloudOrigin: false,
      origin: ORIGIN,
    })
    expect(plantCloudDashboardCookie).not.toHaveBeenCalled()
  })

  it('clears a plant that finished after the workspace disappeared', async () => {
    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    hasCloudDashboardCookie.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    mintDeploymentSessionForDashboard.mockResolvedValue({
      deploymentUrl: ORIGIN,
      setCookies: [COOKIE],
    })
    plantCloudDashboardCookie.mockImplementation(async () => {
      readCloudWorkspaceRecord.mockReturnValue(null)
      return true
    })
    await expect(ensureCloudDashboardSession('cloud')).resolves.toEqual({
      useCloudOrigin: false,
      origin: null,
    })
    expect(clearCloudDashboardCookie).toHaveBeenCalledWith(ORIGIN)
  })

  it('does not restore a cookie after disconnect wins the race', async () => {
    let onCleared: ((url: string) => void) | undefined
    setCloudWorkspaceRecordClearedListener.mockImplementation((listener) => {
      onCleared = listener
    })
    registerCloudDashboardCookieCleanup()

    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    hasCloudDashboardCookie.mockResolvedValue(false)
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
    finishMint({ deploymentUrl: ORIGIN, setCookies: [COOKIE] })

    await expect(pending).resolves.toEqual({
      useCloudOrigin: false,
      origin: ORIGIN,
    })
    expect(plantCloudDashboardCookie).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(clearCloudDashboardCookie).toHaveBeenCalledWith(ORIGIN)
    })
  })

  it('does not accept a leftover cookie after a waiter outlives a same-origin switch', async () => {
    let onCleared: ((url: string) => void) | undefined
    setCloudWorkspaceRecordClearedListener.mockImplementation((listener) => {
      onCleared = listener
    })
    registerCloudDashboardCookieCleanup()

    readCloudWorkspaceRecord.mockReturnValue({ deploymentUrl: ORIGIN })
    hasCloudDashboardCookie.mockResolvedValue(false)
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
    hasCloudDashboardCookie.mockResolvedValue(true)
    finishMint({ deploymentUrl: ORIGIN, setCookies: [COOKIE] })

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
    let finishLookup!: (value: boolean) => void
    hasCloudDashboardCookie
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          finishLookup = resolve
        }),
      )
    mintDeploymentSessionForDashboard.mockResolvedValue({
      deploymentUrl: ORIGIN,
      setCookies: [COOKIE],
    })
    plantCloudDashboardCookie.mockResolvedValue(true)

    const pending = ensureCloudDashboardSession('cloud')
    await vi.waitFor(() => {
      expect(plantCloudDashboardCookie).toHaveBeenCalled()
    })
    readCloudWorkspaceRecord.mockReturnValue(null)
    onCleared?.(`${ORIGIN}/`)
    finishLookup(true)

    await expect(pending).resolves.toEqual({
      useCloudOrigin: false,
      origin: null,
    })
    expect(clearCloudDashboardCookie).toHaveBeenCalledWith(ORIGIN)
  })
})
