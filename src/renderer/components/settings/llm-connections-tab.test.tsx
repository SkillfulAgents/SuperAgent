// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const state = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutate: vi.fn(),
}))
vi.mock('@renderer/hooks/use-llm-connections', () => ({
  useLlmConnections: () => ({ data: state.data }),
  useConnectionMutation: () => ({ mutate: state.mutate, mutateAsync: state.mutate, isPending: false }),
}))
vi.mock('@renderer/hooks/use-settings', () => ({
  useModelSettings: () => ({ data: { llmProviderStatus: [] } }),
  useUpdateSettings: () => ({ mutate: vi.fn() }),
}))
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ isAdmin: true, isAuthMode: false }),
}))
vi.mock('./settings-model-select', () => ({
  ModelPickerPopover: () => null,
  SettingsModelSelect: ({ directApiOnly, model, llmProviderId, appDefault }: {
    directApiOnly?: boolean; model?: string; llmProviderId?: string
    appDefault?: { isOverride: boolean; onUseAppDefault: () => void; label?: string }
  }) => (
    <>
      <div data-testid={directApiOnly ? 'summarizer-selection' : 'default-selection'}>{llmProviderId}:{model}</div>
      {appDefault && <button type="button" disabled={!appDefault.isOverride} onClick={appDefault.onUseAppDefault}>{appDefault.label}</button>}
    </>
  ),
}))
vi.mock('./model-catalog/catalog-editor', () => ({ CatalogEditor: () => null }))
import { LlmConnectionsTab } from './llm-connections-tab'

beforeEach(() => {
  vi.clearAllMocks()
  // Radix Select needs these in jsdom.
  HTMLElement.prototype.hasPointerCapture = () => false
  HTMLElement.prototype.scrollIntoView = () => {}
  state.data = {
    connections: [{ id: 'api', name: 'API', userId: null, supportsDirectApi: true, canDelete: false, deletionBlockedReason: 'Change the app default first' }],
    defaultSelection: { llmProviderId: 'api', model: 'sonnet' },
    summarizerSelection: null,
  }
})

describe('global helper settings', () => {
  it('does not claim inheritance without an app default', () => {
    state.data.defaultSelection = null
    render(<LlmConnectionsTab />)
    expect(screen.queryByText('Using app default')).not.toBeInTheDocument()
  })

  it('identifies an inherited summarizer explicitly', () => {
    render(<LlmConnectionsTab />)
    expect(screen.getByText('Using app default')).toBeVisible()
    expect(screen.getByTestId('summarizer-selection')).toHaveTextContent('api:sonnet')
    expect(screen.getByRole('button', { name: 'Use app default' })).toBeDisabled()
  })

  it('explains why an agent-only default requires its separate helper', async () => {
    state.data = { ...state.data,
      connections: [{ id: 'sub', name: 'Subscription', supportsDirectApi: false, canDelete: true }],
      defaultSelection: { llmProviderId: 'sub', model: 'opus' },
      summarizerSelection: { llmProviderId: 'api', model: 'haiku' },
    }
    render(<LlmConnectionsTab />)
    expect(screen.getByText('This app default requires a separate API-capable summarizer.')).toBeVisible()
    const inherit = screen.getByRole('button', { name: 'Use app default' })
    expect(inherit).toBeDisabled()
    await userEvent.click(inherit)
    expect(state.mutate).not.toHaveBeenCalled()
  })

  it('does not display an agent-only model as the missing summarizer', () => {
    state.data = { ...state.data,
      connections: [{ id: 'sub', name: 'Subscription', supportsDirectApi: false, canDelete: true }],
      defaultSelection: { llmProviderId: 'sub', model: 'opus' },
    }
    render(<LlmConnectionsTab />)
    expect(screen.getByTestId('summarizer-selection')).not.toHaveTextContent('opus')
  })

  it('shows the server deletion blocker verbatim', async () => {
    render(<LlmConnectionsTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Actions for API' }))
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
    expect(screen.getByText('Change the app default first')).toBeVisible()
  })

  it('allows returning to an API-capable app default', async () => {
    state.data.summarizerSelection = { llmProviderId: 'api', model: 'haiku' }
    render(<LlmConnectionsTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Use app default' }))
    expect(state.mutate).toHaveBeenCalledWith({ path: '/defaults/summarizer', method: 'PUT', body: null }, expect.anything())
  })
})


describe('generic API formats', () => {
  it('defaults to Messages and saves an explicitly selected OpenAI format', async () => {
    const user = userEvent.setup()
    render(<LlmConnectionsTab />)
    await user.click(screen.getByRole('button', { name: 'Add connection' }))
    await user.click(screen.getByRole('button', { name: /^Generic/ }))
    expect(screen.getByRole('heading', { name: 'Set up Generic connection' })).toBeInTheDocument()
    expect(screen.getByLabelText('API format')).toHaveTextContent('Anthropic Messages')
    await user.click(screen.getByLabelText('API format'))
    await user.click(screen.getByRole('option', { name: 'OpenAI Responses' }))
    await user.type(screen.getByLabelText('Base URL'), 'https://api.example.com/v1')
    await user.type(screen.getByLabelText('API key'), 'temporary-key')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(state.mutate).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({
      provider: 'generic', config: expect.objectContaining({ apiFormat: 'responses' }),
    }) }))
  })
})
