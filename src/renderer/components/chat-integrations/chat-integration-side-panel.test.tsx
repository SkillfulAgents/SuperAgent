// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ChatIntegrationSidePanel } from './chat-integration-side-panel'
import { makeChatIntegration } from './test-factories'

vi.mock('./integration-status-card', () => ({ IntegrationStatusCard: () => <div data-testid="status-card" /> }))
vi.mock('./integration-settings-card', () => ({ IntegrationSettingsCard: () => <div data-testid="settings-card" /> }))
vi.mock('./integration-settings-controls', () => ({ IntegrationModelEffort: () => <div data-testid="model-card" /> }))

describe('ChatIntegrationSidePanel', () => {
  it('shows Status, Settings and Model for managers', () => {
    render(<ChatIntegrationSidePanel integration={makeChatIntegration()} canManage canManageAccess />)
    expect(screen.getByTestId('status-card')).toBeInTheDocument()
    expect(screen.getByTestId('settings-card')).toBeInTheDocument()
    expect(screen.getByTestId('model-card')).toBeInTheDocument()
  })
  it('hides the manager cards for viewers', () => {
    render(<ChatIntegrationSidePanel integration={makeChatIntegration()} canManage={false} canManageAccess={false} />)
    expect(screen.queryByTestId('status-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('settings-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-card')).not.toBeInTheDocument()
  })
})
