// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { _setFactsForTest } from '@renderer/lib/facts'
import type { ClientFacts, ServerFacts } from '@shared/lib/facts/facts-schema'
import { GeneralTab } from './general-tab'
import { SANDBOX_LEAVES_OUT } from './sandbox-notice'

vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUserSettings: () => ({ data: {}, isLoading: false }),
  useUpdateUserSettings: () => ({ mutate: vi.fn() }),
}))
vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => ({ data: { app: {} } }),
  useUpdateSettings: () => ({ mutate: vi.fn() }),
}))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: false, isAdmin: true }) }))
vi.mock('@renderer/context/analytics-context', () => ({ useAnalyticsTracking: () => ({ track: vi.fn() }) }))
vi.mock('@renderer/context/update-status-context', () => ({ useUpdateStatus: () => ({ state: 'idle' }) }))
vi.mock('./shortcuts-section', () => ({ ShortcutsSection: () => null }))
vi.mock('./auto-delete-select', () => ({ AutoDeleteSelect: () => null }))
vi.mock('./api-log-auto-delete-select', () => ({ ApiLogAutoDeleteSelect: () => null }))
vi.mock('@renderer/components/ui/timezone-picker', () => ({ TimezonePicker: () => null }))

function asBuild(distribution: 'mac-app-store' | 'direct') {
  const client: ClientFacts = { shell: 'electron', os: 'darwin', distribution }
  const server: ServerFacts = { os: 'darwin', distribution }
  _setFactsForTest({ client, server })
  window.electronAPI = { platform: 'darwin' } as unknown as typeof window.electronAPI
}

afterEach(() => {
  delete (window as { electronAPI?: unknown }).electronAPI
})

describe('General settings', () => {
  it('tells a Mac App Store edition’s user what its sandbox leaves out, and offers no Keep Awake', () => {
    asBuild('mac-app-store')
    render(<GeneralTab onOpenWizard={() => {}} />)

    const notice = screen.getByTestId('sandbox-notice')
    expect(within(notice).getByText('Mac App Store edition')).toBeTruthy()
    expect(within(notice).getAllByRole('listitem').map((item) => item.textContent)).toEqual(SANDBOX_LEAVES_OUT)
    expect(screen.queryByText('Keep Awake')).toBeNull()
  })

  it('has no notice in a directly distributed build, which offers Keep Awake', () => {
    asBuild('direct')
    render(<GeneralTab onOpenWizard={() => {}} />)

    expect(screen.queryByTestId('sandbox-notice')).toBeNull()
    expect(screen.getByText('Keep Awake')).toBeTruthy()
  })
})
