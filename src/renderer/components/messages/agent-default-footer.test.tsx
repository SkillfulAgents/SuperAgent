// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const useSettingsMock = vi.fn()
vi.mock('@renderer/hooks/use-settings', () => ({
  useModelSettings: () => useSettingsMock(),
}))

const useAgentPreferencesMock = vi.fn()
const mutateMock = vi.fn()
vi.mock('@renderer/hooks/use-agent-preferences', () => ({
  useAgentPreferences: () => useAgentPreferencesMock(),
  useUpdateAgentPreferences: () => ({ mutate: mutateMock, isPending: false }),
}))

const canAdminAgentMock = vi.fn(() => true)
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ canAdminAgent: canAdminAgentMock }),
}))

const navigateMock = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { AgentDefaultFooter } from './agent-default-footer'
import type { ComposerOptionsState } from './composer-options'
import type { EffortLevel, SpeedLevel } from '@shared/lib/container/types'

const ALL = ['low', 'medium', 'high', 'xhigh', 'max']
const STD = ['low', 'medium', 'high']
const CATALOG = [
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', family: 'haiku', isLatest: true, icon: 'anthropic', supportedEfforts: STD },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', family: 'sonnet', isLatest: true, icon: 'anthropic', supportedEfforts: STD },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', family: 'opus', icon: 'anthropic', supportedEfforts: ALL },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', family: 'opus', isLatest: true, icon: 'anthropic', supportedEfforts: ALL },
]

function stateWith(overrides: Partial<ComposerOptionsState> = {}): ComposerOptionsState {
  return {
    effort: 'medium' as EffortLevel,
    setEffort: vi.fn(),
    speed: 'normal' as SpeedLevel,
    setSpeed: vi.fn(),
    model: 'claude-opus-4-8',
    setModel: vi.fn(),
    autopilot: false,
    setAutopilot: vi.fn(),
    catalog: CATALOG as ComposerOptionsState['catalog'],
    webProvider: undefined,
    toRuntimeOptions: () => ({}),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  canAdminAgentMock.mockReturnValue(true)
  useSettingsMock.mockReturnValue({
    data: { models: { agentModel: 'opus', agentEffort: 'medium' } },
  })
  useAgentPreferencesMock.mockReturnValue({ data: {}, isFetched: true })
})

describe('AgentDefaultFooter', () => {
  it('renders nothing until agent preferences have answered', () => {
    useAgentPreferencesMock.mockReturnValue({ data: undefined, isFetched: false })
    render(<AgentDefaultFooter agentSlug="my-agent" state={stateWith()} />)
    expect(screen.queryByTestId('composer-agent-default')).not.toBeInTheDocument()
  })

  it('shows the status label when the pick already is the agent default (alias vs concrete latest)', () => {
    // Default is the bare alias 'opus'; the composer holds the concrete latest id.
    render(<AgentDefaultFooter agentSlug="my-agent" state={stateWith({ model: 'claude-opus-4-8' })} />)
    expect(screen.getByTestId('composer-agent-default-current')).toHaveTextContent('Current Agent Default')
    expect(screen.queryByTestId('composer-agent-default')).not.toBeInTheDocument()
  })

  it('promotes a diverging pick, storing the family alias for a latest model', async () => {
    const user = userEvent.setup()
    render(
      <AgentDefaultFooter
        agentSlug="my-agent"
        state={stateWith({ model: 'claude-sonnet-4-6', effort: 'high' as EffortLevel })}
      />,
    )
    const promote = screen.getByTestId('composer-agent-default')
    expect(promote).toBeEnabled()
    await user.click(promote)
    expect(mutateMock).toHaveBeenCalledWith(
      { defaultModel: 'sonnet', defaultEffort: 'high', defaultSpeed: null },
      expect.anything(),
    )
  })

  it('stores the concrete id when the pick is a pinned older version', async () => {
    const user = userEvent.setup()
    render(<AgentDefaultFooter agentSlug="my-agent" state={stateWith({ model: 'claude-opus-4-7' })} />)
    await user.click(screen.getByTestId('composer-agent-default'))
    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModel: 'claude-opus-4-7' }),
      expect.anything(),
    )
  })

  it('enables the promote action on an effort-only divergence', () => {
    render(
      <AgentDefaultFooter agentSlug="my-agent" state={stateWith({ effort: 'xhigh' as EffortLevel })} />,
    )
    expect(screen.getByTestId('composer-agent-default')).toBeEnabled()
  })

  it('compares against the agent preference when one is set, not the app-wide default', () => {
    useAgentPreferencesMock.mockReturnValue({
      data: { defaultModel: 'sonnet', defaultEffort: 'high' },
      isFetched: true,
    })
    render(
      <AgentDefaultFooter
        agentSlug="my-agent"
        state={stateWith({ model: 'claude-sonnet-4-6', effort: 'high' as EffortLevel })}
      />,
    )
    expect(screen.getByTestId('composer-agent-default-current')).toBeInTheDocument()
    expect(screen.queryByTestId('composer-agent-default')).not.toBeInTheDocument()
  })

  it('shows members a read-only line naming the default instead of the button', () => {
    canAdminAgentMock.mockReturnValue(false)
    render(<AgentDefaultFooter agentSlug="my-agent" state={stateWith()} />)
    expect(screen.queryByTestId('composer-agent-default')).not.toBeInTheDocument()
    expect(screen.getByTestId('composer-agent-default-readonly')).toHaveTextContent(
      'Agent default: Opus · Medium',
    )
  })

  it('links to the agent home page where the default-model card lives', async () => {
    const user = userEvent.setup()
    render(<AgentDefaultFooter agentSlug="my-agent" state={stateWith()} />)
    await user.click(screen.getByTestId('composer-agent-default-change'))
    expect(navigateMock).toHaveBeenCalledWith({ to: '/agents/$slug', params: { slug: 'my-agent' } })
  })

  it('hides the home link when the host is the agent home page itself', () => {
    render(<AgentDefaultFooter agentSlug="my-agent" state={stateWith()} agentHomeLink={false} />)
    expect(screen.queryByTestId('composer-agent-default-change')).not.toBeInTheDocument()
  })

  it('swaps the status label for the promote action when the pick diverges', () => {
    const { rerender } = render(<AgentDefaultFooter agentSlug="my-agent" state={stateWith()} />)
    expect(screen.getByTestId('composer-agent-default-current')).toBeInTheDocument()
    rerender(<AgentDefaultFooter agentSlug="my-agent" state={stateWith({ model: 'claude-sonnet-4-6' })} />)
    expect(screen.getByTestId('composer-agent-default')).toBeInTheDocument()
    expect(screen.queryByTestId('composer-agent-default-current')).not.toBeInTheDocument()
  })
})
