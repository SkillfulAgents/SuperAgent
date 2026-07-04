// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { IntegrationSettingsCard } from './integration-settings-card'
import { makeChatIntegration as makeIntegration } from './test-factories'

const updateMock = vi.fn()
const setApprovalMock = vi.fn()
vi.mock('@renderer/hooks/use-chat-integrations', () => ({
  useUpdateChatIntegration: () => ({ mutate: updateMock, isPending: false }),
  useSetRequireApproval: () => ({ mutate: setApprovalMock, isPending: false, isError: false }),
}))
vi.mock('./integration-settings-controls', () => ({
  ToggleRow: ({ label, onCheckedChange }: any) => (
    <button aria-label={label} onClick={() => onCheckedChange(true)}>{label}</button>
  ),
  SessionTimeoutSelect: () => null,
}))
vi.mock('@shared/lib/chat-integrations/config-schema', () => ({
  parseChatIntegrationConfig: (provider: string) =>
    provider === 'slack' ? { onlyMentioned: false, answerInThread: false, newSessionPerThread: false } : null,
}))

describe('IntegrationSettingsCard', () => {
  beforeEach(() => { updateMock.mockReset(); setApprovalMock.mockReset() })

  it('does NOT render the status toggle or connection row (they live in the Status card)', () => {
    render(<IntegrationSettingsCard integration={makeIntegration({ status: 'active' })} />)
    expect(screen.queryByLabelText(/pause integration/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Connection')).not.toBeInTheDocument()
  })

  it('shows Slack-only toggles only for Slack', () => {
    const { rerender } = render(<IntegrationSettingsCard integration={makeIntegration()} />)
    expect(screen.queryByLabelText(/only respond when @mentioned/i)).not.toBeInTheDocument()
    rerender(<IntegrationSettingsCard integration={makeIntegration({ provider: 'slack' })} />)
    expect(screen.getByLabelText(/only respond when @mentioned/i)).toBeInTheDocument()
  })

  it.each([
    { desc: 'shows the require-approval gate for a Telegram access-admin', overrides: {}, canManageAccess: true, visible: true },
    { desc: 'hides require-approval without access-admin rights', overrides: {}, canManageAccess: false, visible: false },
    { desc: 'hides require-approval for non-Telegram providers', overrides: { provider: 'slack' as const }, canManageAccess: true, visible: false },
  ])('$desc', ({ overrides, canManageAccess, visible }) => {
    render(<IntegrationSettingsCard integration={makeIntegration(overrides)} canManageAccess={canManageAccess} />)
    const gate = screen.queryByLabelText(/require approval/i)
    if (visible) expect(gate).toBeInTheDocument()
    else expect(gate).not.toBeInTheDocument()
  })

  it('does NOT render a Delete button (that lives in the page title bar)', () => {
    render(<IntegrationSettingsCard integration={makeIntegration()} />)
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument()
  })
})
