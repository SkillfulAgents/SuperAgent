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
    catalog: CATALOG as ComposerOptionsState['catalog'],
    defaultModel: 'opus',
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

const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByTestId('composer-agent-default-menu'))
}

describe('AgentDefaultFooter', () => {
  it('renders nothing until agent preferences have answered', () => {
    useAgentPreferencesMock.mockReturnValue({ data: undefined, isFetched: false })
    render(<AgentDefaultFooter agentSlug="my-agent" state={stateWith()} />)
    expect(screen.queryByTestId('composer-agent-default-current')).not.toBeInTheDocument()
  })

  it('checks the default line when the pick already is the agent default (alias vs concrete latest)', async () => {
    const user = userEvent.setup()
    render(<AgentDefaultFooter agentSlug="my-agent" state={stateWith({ model: 'claude-opus-4-8' })} />)
    const line = screen.getByTestId('composer-agent-default-current')
    expect(line).toHaveTextContent('Agent Default · Opus · Medium')
    expect(line.querySelector('svg')).toBeInTheDocument()
    await openMenu(user)
    expect(screen.getByTestId('composer-agent-default')).toHaveAttribute('data-disabled')
  })

  it('keeps the default line visible, unchecked, when the pick diverges', () => {
    render(<AgentDefaultFooter agentSlug="my-agent" state={stateWith({ model: 'claude-sonnet-4-6' })} />)
    const line = screen.getByTestId('composer-agent-default-current')
    expect(line).toHaveTextContent('Agent Default · Opus · Medium')
    expect(line.querySelector('svg')).not.toBeInTheDocument()
  })

  it('promotes a diverging pick, storing the family alias for a latest model', async () => {
    const user = userEvent.setup()
    render(
      <AgentDefaultFooter
        agentSlug="my-agent"
        state={stateWith({ model: 'claude-sonnet-4-6', effort: 'high' as EffortLevel })}
      />,
    )
    await openMenu(user)
    await user.click(screen.getByTestId('composer-agent-default'))
    expect(mutateMock).toHaveBeenCalledWith(
      { defaultModel: 'sonnet', defaultEffort: 'high', defaultSpeed: null },
      expect.anything(),
    )
  })

  it('stores the concrete id when the pick is a pinned older version', async () => {
    const user = userEvent.setup()
    render(<AgentDefaultFooter agentSlug="my-agent" state={stateWith({ model: 'claude-opus-4-7' })} />)
    await openMenu(user)
    await user.click(screen.getByTestId('composer-agent-default'))
    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModel: 'claude-opus-4-7' }),
      expect.anything(),
    )
  })

  it('enables promotion on an effort-only divergence', async () => {
    const user = userEvent.setup()
    render(<AgentDefaultFooter agentSlug="my-agent" state={stateWith({ effort: 'xhigh' as EffortLevel })} />)
    await openMenu(user)
    expect(screen.getByTestId('composer-agent-default')).not.toHaveAttribute('data-disabled')
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
    const line = screen.getByTestId('composer-agent-default-current')
    expect(line).toHaveTextContent('Agent Default · Sonnet · High')
    expect(line.querySelector('svg')).toBeInTheDocument()
  })

  it('clears a custom agent default back to the global default', async () => {
    const user = userEvent.setup()
    useAgentPreferencesMock.mockReturnValue({
      data: { defaultModel: 'sonnet', defaultEffort: 'high' },
      isFetched: true,
    })
    const applyGlobalDefault = vi.fn()
    render(<AgentDefaultFooter agentSlug="my-agent" state={stateWith({ applyGlobalDefault })} />)
    await openMenu(user)
    await user.click(screen.getByTestId('composer-agent-default-reset'))
    expect(applyGlobalDefault).toHaveBeenCalledOnce()
    expect(mutateMock).toHaveBeenCalledWith(
      { defaultModel: null, defaultLlmProviderId: null, defaultEffort: null, defaultSpeed: null },
      expect.anything(),
    )
  })

  it('switches the composer to the global default without writing prefs when the agent already follows it', async () => {
    const user = userEvent.setup()
    const applyGlobalDefault = vi.fn()
    render(
      <AgentDefaultFooter
        agentSlug="my-agent"
        state={stateWith({ model: 'claude-sonnet-4-6', applyGlobalDefault })}
      />,
    )
    await openMenu(user)
    await user.click(screen.getByTestId('composer-agent-default-reset'))
    expect(applyGlobalDefault).toHaveBeenCalledOnce()
    expect(mutateMock).not.toHaveBeenCalled()
  })

  it('disables Use Global Default when the agent and the pick already follow it', async () => {
    const user = userEvent.setup()
    render(<AgentDefaultFooter agentSlug="my-agent" state={stateWith()} />)
    await openMenu(user)
    expect(screen.getByTestId('composer-agent-default-reset')).toHaveAttribute('data-disabled')
  })

  it('shows members a read-only line naming the default instead of the menu', () => {
    canAdminAgentMock.mockReturnValue(false)
    render(<AgentDefaultFooter agentSlug="my-agent" state={stateWith()} />)
    expect(screen.queryByTestId('composer-agent-default-menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('composer-agent-default-readonly')).toHaveTextContent(
      'Agent default: Opus · Medium',
    )
  })
})
