// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { _setFactsForTest } from '@renderer/lib/facts'
import { NotificationsTab } from './notifications-tab'

const openExternalUrl = vi.hoisted(() => vi.fn())
vi.mock('@renderer/lib/open-external', () => ({ openExternalUrl }))
vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: () => ({ data: { notifications: {} }, isLoading: false }),
  useUpdateUserSettings: () => ({ mutate: vi.fn() }),
}))
vi.mock('@renderer/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/env')>()),
  isElectron: () => true,
}))

function asMacApp(distribution: 'direct' | 'mac-app-store') {
  _setFactsForTest({ client: { shell: 'electron', os: 'darwin', distribution }, server: { os: 'darwin', distribution } })
  // macOS has the app's notifications turned off, which is when the link shows.
  window.electronAPI = { getOsNotificationsBlocked: () => Promise.resolve(true) } as unknown as typeof window.electronAPI
}

afterEach(() => {
  delete (window as { electronAPI?: unknown }).electronAPI
  openExternalUrl.mockReset()
})

describe('Open System Settings', () => {
  it.each([
    ['direct', 'com.superagent.app'],
    ['mac-app-store', 'so.gamut.app'],
  ] as const)('opens the %s build’s own notification settings (%s)', async (distribution, bundleId) => {
    asMacApp(distribution)
    render(<NotificationsTab />)

    await userEvent.click(await screen.findByRole('button', { name: 'Open System Settings' }))

    expect(openExternalUrl).toHaveBeenCalledWith(
      `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${bundleId}`,
    )
  })
})
