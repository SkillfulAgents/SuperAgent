// @vitest-environment jsdom
import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const platformAuthMock = vi.fn()
const useUserMock = vi.fn()

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => useUserMock(),
}))

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => platformAuthMock(),
}))

vi.mock('@renderer/lib/host-features', () => ({
  canUseHostFeatures: () => false,
}))

vi.mock('@renderer/components/connections/connections-list', () => ({
  NewIntegrationButton: () => null,
}))

vi.mock('./users-tab', () => ({
  UsersTab: ({
    platformControlled,
    platformInviteHref,
  }: {
    platformControlled?: boolean
    platformInviteHref?: string
  }) => (
    <div
      data-testid="users-tab"
      data-platform-controlled={platformControlled ? '1' : '0'}
      data-invite-href={platformInviteHref ?? ''}
    />
  ),
}))

vi.mock('./auth-tab', () => ({
  AuthTab: ({ hideLocalAuthSections }: { hideLocalAuthSections?: boolean }) => (
    <div data-testid="auth-tab" data-hide-local={hideLocalAuthSections ? '1' : '0'} />
  ),
}))

vi.mock('./mobile-tab', () => ({ MobileTab: () => null }))
vi.mock('./general-tab', () => ({ GeneralTab: () => null }))
vi.mock('./runtime-tab', () => ({ RuntimeTab: () => null }))
vi.mock('./account-provider-tab', () => ({ AccountProviderTab: () => null }))
vi.mock('./notifications-tab', () => ({ NotificationsTab: () => null }))
vi.mock('./browser-tab', () => ({ BrowserTab: () => null }))
vi.mock('./skillsets-tab', () => ({ SkillsetsTab: () => null }))
vi.mock('./usage-tab', () => ({ UsageTab: () => null }))
vi.mock('./connections-tab', () => ({ ConnectionsTab: () => null }))
vi.mock('./llm-tab', () => ({ LlmTab: () => null }))
vi.mock('./admin-tab', () => ({ AdminTab: () => null }))
vi.mock('./voice-tab', () => ({ VoiceTab: () => null }))
vi.mock('./web-tab', () => ({ WebTab: () => null }))
vi.mock('./analytics-tab', () => ({ AnalyticsTab: () => null }))
vi.mock('./platform-tab', () => ({ PlatformTab: () => null }))
vi.mock('./computer-use-tab', () => ({ ComputerUseTab: () => null }))
vi.mock('./capabilities-tab', () => ({ CapabilitiesTab: () => null }))
vi.mock('./audit-log-tab', () => ({ AuditLogTab: () => null }))

vi.mock('./settings-page', () => ({
  SettingsPage: ({
    groups,
  }: {
    groups: Array<{ label?: string; sections: Array<{ id: string; render: () => React.ReactNode }> }>
  }) => (
    <div>
      {groups.map((g) => (
        <div key={g.label} data-testid={`group-order:${g.label}`}>
          {g.sections.map((s) => s.id).join(',')}
        </div>
      ))}
      {groups
        .flatMap((g) => g.sections)
        .filter((s) => s.id === 'users' || s.id === 'auth')
        .map((s) => (
          <div key={s.id} data-testid={`section-${s.id}`}>
            {s.render()}
          </div>
        ))}
    </div>
  ),
}))

import { GlobalSettingsPage } from './global-settings-page'

describe('GlobalSettingsPage platform-controlled Users/Auth', () => {
  beforeEach(() => {
    useUserMock.mockReturnValue({ isAuthMode: true, isAdmin: true })
    platformAuthMock.mockReturnValue({ data: undefined })
  })

  it('hides local auth sections and routes invite to Platform Team when platformControlled', async () => {
    platformAuthMock.mockReturnValue({
      data: {
        platformControlled: true,
        platformBaseUrl: 'https://platform.example',
        orgId: 'org_abc',
        source: 'env',
      },
    })
    render(<GlobalSettingsPage onClose={() => {}} onOpenWizard={() => {}} />)
    expect(await screen.findByTestId('auth-tab')).toHaveAttribute('data-hide-local', '1')
    const usersTab = await screen.findByTestId('users-tab')
    expect(usersTab).toHaveAttribute('data-platform-controlled', '1')
    expect(usersTab).toHaveAttribute(
      'data-invite-href',
      'https://platform.example/dashboard/organizations/org_abc?tab=team',
    )
  })

  it('falls back to /dashboard when orgId is null but platformControlled', async () => {
    platformAuthMock.mockReturnValue({
      data: {
        platformControlled: true,
        platformBaseUrl: 'https://platform.example/',
        orgId: null,
        source: 'env',
      },
    })
    render(<GlobalSettingsPage onClose={() => {}} onOpenWizard={() => {}} />)
    expect(await screen.findByTestId('auth-tab')).toHaveAttribute('data-hide-local', '1')
    const usersTab = await screen.findByTestId('users-tab')
    expect(usersTab).toHaveAttribute('data-platform-controlled', '1')
    expect(usersTab).toHaveAttribute(
      'data-invite-href',
      'https://platform.example/dashboard',
    )
  })

  it('keeps platformControlled when base URL is missing', async () => {
    platformAuthMock.mockReturnValue({
      data: {
        platformControlled: true,
        platformBaseUrl: '',
        orgId: 'org_abc',
        source: 'env',
      },
    })
    render(<GlobalSettingsPage onClose={() => {}} onOpenWizard={() => {}} />)
    expect(await screen.findByTestId('auth-tab')).toHaveAttribute('data-hide-local', '1')
    const usersTab = await screen.findByTestId('users-tab')
    expect(usersTab).toHaveAttribute('data-platform-controlled', '1')
    expect(usersTab).toHaveAttribute('data-invite-href', '')
  })

  it('keeps local invite when not platformControlled', async () => {
    platformAuthMock.mockReturnValue({
      data: {
        platformControlled: false,
        platformBaseUrl: 'https://platform.example',
        orgId: 'org_abc',
        source: 'env',
      },
    })
    render(<GlobalSettingsPage onClose={() => {}} onOpenWizard={() => {}} />)
    expect(await screen.findByTestId('auth-tab')).toHaveAttribute('data-hide-local', '0')
    const usersTab = await screen.findByTestId('users-tab')
    expect(usersTab).toHaveAttribute('data-platform-controlled', '0')
    expect(usersTab).toHaveAttribute('data-invite-href', '')
  })
})

describe('GlobalSettingsPage nav order', () => {
  beforeEach(() => {
    platformAuthMock.mockReturnValue({ data: undefined })
  })

  function groupOrder(label: string): string[] {
    return screen.getByTestId(`group-order:${label}`).textContent!.split(',')
  }

  function renderPage() {
    render(<GlobalSettingsPage onClose={() => {}} onOpenWizard={() => {}} />)
  }

  it('anchors General first and Admin last in App Settings for an auth-mode admin', () => {
    useUserMock.mockReturnValue({ isAuthMode: true, isAdmin: true })
    renderPage()
    const order = groupOrder('App Settings')
    expect(order[0]).toBe('general')
    expect(order.at(-1)).toBe('admin')
    // Auth sits directly above Admin — the mode-gated items stay between the anchors.
    expect(order.at(-2)).toBe('auth')
  })

  it('anchors General first and Admin last in App Settings in local mode', () => {
    useUserMock.mockReturnValue({ isAuthMode: false, isAdmin: false })
    renderPage()
    const order = groupOrder('App Settings')
    expect(order[0]).toBe('general')
    expect(order.at(-1)).toBe('admin')
  })

  it('keeps General first for a non-admin auth user, who has no Admin entry', () => {
    useUserMock.mockReturnValue({ isAuthMode: true, isAdmin: false })
    renderPage()
    const order = groupOrder('App Settings')
    expect(order[0]).toBe('general')
    expect(order).not.toContain('admin')
  })

  it('leads Agent Capabilities with Mobile in auth mode, ahead of Connections', () => {
    useUserMock.mockReturnValue({ isAuthMode: true, isAdmin: true })
    renderPage()
    expect(groupOrder('Agent Capabilities').slice(0, 2)).toEqual(['mobile', 'connections'])
    expect(groupOrder('App Settings')).not.toContain('mobile')
  })

  it('has no Mobile entry in local mode, so Connections leads Agent Capabilities', () => {
    useUserMock.mockReturnValue({ isAuthMode: false, isAdmin: false })
    renderPage()
    const order = groupOrder('Agent Capabilities')
    expect(order[0]).toBe('connections')
    expect(order).not.toContain('mobile')
  })
})
