// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const useSettingsMock = vi.fn()
vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => useSettingsMock(),
}))

const usePreferencesMock = vi.fn()
const mutateMock = vi.fn()
vi.mock('@renderer/hooks/use-agent-preferences', () => ({
  useAgentPreferences: () => usePreferencesMock(),
  useUpdateAgentPreferences: () => ({ mutate: mutateMock, isPending: false }),
}))

import { HomeDefaultModel } from './home-default-model'

const ALL = ['low', 'medium', 'high', 'xhigh', 'max']
const SPEEDY_CATALOG = [
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    family: 'opus',
    isLatest: true,
    icon: 'anthropic',
    supportedEfforts: ALL,
    supportedSpeeds: ['slow', 'normal', 'fast'],
  },
]
const NO_SPEED_CATALOG = [
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    family: 'opus',
    isLatest: true,
    icon: 'anthropic',
    supportedEfforts: ALL,
  },
]

function mockSettings(catalog: unknown[]) {
  useSettingsMock.mockReturnValue({
    data: {
      llmProvider: 'anthropic',
      llmProviderStatus: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          isConfigured: true,
          catalog,
          defaultModels: { agent: 'opus', summarizer: 'haiku', browser: 'sonnet' },
        },
      ],
      models: { agentModel: 'claude-opus-4-8', agentEffort: 'medium' },
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSettings(SPEEDY_CATALOG)
  usePreferencesMock.mockReturnValue({ data: {} })
})

describe('HomeDefaultModel speed override', () => {
  it('stores an off-default speed pick as the agent default', async () => {
    const user = userEvent.setup()
    render(<HomeDefaultModel agentSlug="agent-one" />)

    await user.click(screen.getByTestId('settings-model-trigger'))
    await user.click(await screen.findByTestId('speed-option-fast'))

    expect(mutateMock).toHaveBeenCalledWith({ defaultSpeed: 'fast' })
  })

  it('picking Normal clears the override instead of persisting the literal value', async () => {
    usePreferencesMock.mockReturnValue({ data: { defaultSpeed: 'fast' } })
    const user = userEvent.setup()
    render(<HomeDefaultModel agentSlug="agent-one" />)

    await user.click(screen.getByTestId('settings-model-trigger'))
    await user.click(await screen.findByTestId('speed-option-normal'))

    expect(mutateMock).toHaveBeenCalledWith({ defaultSpeed: null })
  })

  it('clears the override (not a literal normal) when the speed clamp auto-fires', async () => {
    // A stored 'fast' on a model whose serving path offers no speed choice
    // gets clamped on render — the clamp write must clear the key too.
    mockSettings(NO_SPEED_CATALOG)
    usePreferencesMock.mockReturnValue({ data: { defaultSpeed: 'fast' } })
    render(<HomeDefaultModel agentSlug="agent-one" />)

    await waitFor(() => expect(mutateMock).toHaveBeenCalledWith({ defaultSpeed: null }))
  })

  it('shows the Custom reset affordance only for a real override', () => {
    usePreferencesMock.mockReturnValue({ data: {} })
    const { rerender } = render(<HomeDefaultModel agentSlug="agent-one" />)
    expect(screen.queryByTestId('home-default-model-reset')).not.toBeInTheDocument()
    expect(screen.getByText('Global')).toBeInTheDocument()

    usePreferencesMock.mockReturnValue({ data: { defaultSpeed: 'fast' } })
    rerender(<HomeDefaultModel agentSlug="agent-one" />)
    expect(screen.getByTestId('home-default-model-reset')).toBeInTheDocument()
  })
})
