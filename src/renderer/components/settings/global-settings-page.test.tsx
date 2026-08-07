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

vi.mock('./profile-tab', () => ({ ProfileTab: () => null }))
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
    groups: Array<{ sections: Array<{ id: string; render: () => React.ReactNode }> }>
  }) => (
    <div>
      {groups
        .flatMap((g) => g.sections)
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

  it('hides local auth sections and routes invite to Platform Team when platformControlled', () => {
    platformAuthMock.mockReturnValue({
      data: {
        platformControlled: true,
        platformBaseUrl: 'https://platform.example',
        orgId: 'org_abc',
        source: 'env',
      },
    })
    render(<GlobalSettingsPage onClose={() => {}} onOpenWizard={() => {}} />)
    expect(screen.getByTestId('auth-tab')).toHaveAttribute('data-hide-local', '1')
    expect(screen.getByTestId('users-tab')).toHaveAttribute('data-platform-controlled', '1')
    expect(screen.getByTestId('users-tab')).toHaveAttribute(
      'data-invite-href',
      'https://platform.example/dashboard/organizations/org_abc?tab=team',
    )
  })

  it('falls back to /dashboard when orgId is null but platformControlled', () => {
    platformAuthMock.mockReturnValue({
      data: {
        platformControlled: true,
        platformBaseUrl: 'https://platform.example/',
        orgId: null,
        source: 'env',
      },
    })
    render(<GlobalSettingsPage onClose={() => {}} onOpenWizard={() => {}} />)
    expect(screen.getByTestId('auth-tab')).toHaveAttribute('data-hide-local', '1')
    expect(screen.getByTestId('users-tab')).toHaveAttribute('data-platform-controlled', '1')
    expect(screen.getByTestId('users-tab')).toHaveAttribute(
      'data-invite-href',
      'https://platform.example/dashboard',
    )
  })

  it('keeps platformControlled when base URL is missing', () => {
    platformAuthMock.mockReturnValue({
      data: {
        platformControlled: true,
        platformBaseUrl: '',
        orgId: 'org_abc',
        source: 'env',
      },
    })
    render(<GlobalSettingsPage onClose={() => {}} onOpenWizard={() => {}} />)
    expect(screen.getByTestId('auth-tab')).toHaveAttribute('data-hide-local', '1')
    expect(screen.getByTestId('users-tab')).toHaveAttribute('data-platform-controlled', '1')
    expect(screen.getByTestId('users-tab')).toHaveAttribute('data-invite-href', '')
  })

  it('keeps local invite when not platformControlled', () => {
    platformAuthMock.mockReturnValue({
      data: {
        platformControlled: false,
        platformBaseUrl: 'https://platform.example',
        orgId: 'org_abc',
        source: 'env',
      },
    })
    render(<GlobalSettingsPage onClose={() => {}} onOpenWizard={() => {}} />)
    expect(screen.getByTestId('auth-tab')).toHaveAttribute('data-hide-local', '0')
    expect(screen.getByTestId('users-tab')).toHaveAttribute('data-platform-controlled', '0')
    expect(screen.getByTestId('users-tab')).toHaveAttribute('data-invite-href', '')
  })
})
