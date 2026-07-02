// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IntegrationModelEffort } from './integration-settings-controls'
import { makeChatIntegration as makeIntegration } from './test-factories'
import type { ModelDefinition } from '@shared/lib/llm-provider'
import type { EffortLevel } from '@shared/lib/container/types'

const ALL: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const STD: EffortLevel[] = ['low', 'medium', 'high']

const CATALOG: ModelDefinition[] = [
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', family: 'haiku', isLatest: true, icon: 'anthropic', supportedEfforts: STD },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', family: 'sonnet', isLatest: true, icon: 'anthropic', supportedEfforts: STD },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', family: 'opus', isLatest: true, icon: 'anthropic', supportedEfforts: ALL },
]

const mutateMock = vi.fn()

vi.mock('@renderer/hooks/use-chat-integrations', () => ({
  useUpdateChatIntegration: () => ({
    mutate: mutateMock,
    isPending: false,
  }),
}))

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => ({
    data: {
      llmProvider: 'anthropic',
      llmProviderStatus: [{
        id: 'anthropic',
        catalog: CATALOG,
        defaultModels: { agent: 'opus', summarizer: 'haiku', browser: 'sonnet' },
      }],
    },
  }),
}))

describe('IntegrationModelEffort', () => {
  beforeEach(() => {
    mutateMock.mockReset()
  })

  it('renders the model trigger', () => {
    render(<IntegrationModelEffort integration={makeIntegration()} />)
    expect(screen.getByTestId('settings-model-trigger')).toBeInTheDocument()
  })

  it('shows default effort (Medium) when integration has no effort set', () => {
    render(<IntegrationModelEffort integration={makeIntegration()} />)
    expect(screen.getByTestId('settings-model-trigger')).toHaveTextContent('Medium')
  })

  it('shows the integration model (bare alias → latest) when set', () => {
    render(<IntegrationModelEffort integration={makeIntegration({ model: 'opus' })} />)
    expect(screen.getByTestId('settings-model-trigger')).toHaveTextContent('Opus · latest')
  })

  it('shows the integration effort when set', () => {
    render(<IntegrationModelEffort integration={makeIntegration({ effort: 'low' })} />)
    expect(screen.getByTestId('settings-model-trigger')).toHaveTextContent('Low')
  })

  it.each([{}, { model: 'opus', effort: 'xhigh' }])('does NOT call mutate on initial render (%o)', (overrides) => {
    render(<IntegrationModelEffort integration={makeIntegration(overrides)} />)
    expect(mutateMock).not.toHaveBeenCalled()
  })

  it('calls mutate with the bare alias when "latest" is picked', async () => {
    const user = userEvent.setup()
    render(<IntegrationModelEffort integration={makeIntegration({ model: 'sonnet' })} />)

    await user.click(screen.getByTestId('settings-model-trigger'))
    await user.click(await screen.findByTestId('model-family-opus'))
    await user.click(await screen.findByTestId('model-latest-opus'))

    expect(mutateMock).toHaveBeenCalledWith({ id: 'int-1', model: 'opus' })
  })

  it('calls mutate with a concrete id when a version is pinned', async () => {
    const user = userEvent.setup()
    render(<IntegrationModelEffort integration={makeIntegration({ model: 'sonnet' })} />)

    await user.click(screen.getByTestId('settings-model-trigger'))
    await user.click(await screen.findByTestId('model-family-opus'))
    await user.click(await screen.findByTestId('model-pinned-claude-opus-4-8'))

    expect(mutateMock).toHaveBeenCalledWith({ id: 'int-1', model: 'claude-opus-4-8' })
  })

  it('calls mutate with effort when user selects an effort', async () => {
    const user = userEvent.setup()
    render(<IntegrationModelEffort integration={makeIntegration({ model: 'sonnet', effort: 'high' })} />)

    await user.click(screen.getByTestId('settings-model-trigger'))
    await user.click(await screen.findByTestId('effort-option-low'))

    expect(mutateMock).toHaveBeenCalledWith({ id: 'int-1', effort: 'low' })
  })

  it('uses the correct integration id in mutation calls', async () => {
    const user = userEvent.setup()
    render(<IntegrationModelEffort integration={makeIntegration({ id: 'custom-id', model: 'sonnet' })} />)

    await user.click(screen.getByTestId('settings-model-trigger'))
    await user.click(await screen.findByTestId('model-family-haiku'))
    await user.click(await screen.findByTestId('model-latest-haiku'))

    expect(mutateMock).toHaveBeenCalledWith({ id: 'custom-id', model: 'haiku' })
  })
})
