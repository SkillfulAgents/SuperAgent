// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IntegrationModelEffort } from './integration-settings-menu'
import type { ChatIntegration } from '@shared/lib/db/schema'
import type { ComposerModel } from '@shared/lib/llm-provider'

const MODELS: ComposerModel[] = [
  { family: 'haiku', modelId: 'haiku', label: 'Haiku' },
  { family: 'sonnet', modelId: 'sonnet', label: 'Sonnet' },
  { family: 'opus', modelId: 'opus', label: 'Opus' },
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
        composerModels: MODELS,
      }],
    },
  }),
}))

function makeIntegration(overrides: Partial<ChatIntegration> = {}): ChatIntegration {
  return {
    id: 'int-1',
    agentSlug: 'test-agent',
    provider: 'telegram',
    name: 'Test Bot',
    config: '{}',
    showToolCalls: false,
    sessionTimeout: null,
    model: null,
    effort: null,
    status: 'active',
    errorMessage: null,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ChatIntegration
}

describe('IntegrationModelEffort', () => {
  beforeEach(() => {
    mutateMock.mockReset()
  })

  it('renders the composer options trigger', () => {
    render(<IntegrationModelEffort integration={makeIntegration()} />)
    expect(screen.getByTestId('composer-options-trigger')).toBeInTheDocument()
  })

  it('shows default effort (Medium) when integration has no effort set', () => {
    render(<IntegrationModelEffort integration={makeIntegration()} />)
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('Medium')
  })

  it('shows the integration model when set', () => {
    render(<IntegrationModelEffort integration={makeIntegration({ model: 'opus' })} />)
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('Opus')
  })

  it('shows the integration effort when set', () => {
    render(<IntegrationModelEffort integration={makeIntegration({ effort: 'low' })} />)
    expect(screen.getByTestId('composer-options-trigger')).toHaveTextContent('Low')
  })

  it('does NOT call mutate on initial render', () => {
    render(<IntegrationModelEffort integration={makeIntegration()} />)
    expect(mutateMock).not.toHaveBeenCalled()
  })

  it('does NOT call mutate on initial render even with values set', () => {
    render(<IntegrationModelEffort integration={makeIntegration({ model: 'opus', effort: 'xhigh' })} />)
    expect(mutateMock).not.toHaveBeenCalled()
  })

  it('calls mutate with model when user selects a model', async () => {
    const user = userEvent.setup()
    render(<IntegrationModelEffort integration={makeIntegration({ model: 'sonnet' })} />)

    await user.click(screen.getByTestId('composer-options-trigger'))
    await user.click(await screen.findByTestId('model-option-opus'))

    expect(mutateMock).toHaveBeenCalledWith({ id: 'int-1', model: 'opus' })
  })

  it('calls mutate with effort when user selects an effort', async () => {
    const user = userEvent.setup()
    render(<IntegrationModelEffort integration={makeIntegration({ model: 'sonnet', effort: 'high' })} />)

    await user.click(screen.getByTestId('composer-options-trigger'))
    await user.click(await screen.findByTestId('effort-option-low'))

    expect(mutateMock).toHaveBeenCalledWith({ id: 'int-1', effort: 'low' })
  })

  it('uses the correct integration id in mutation calls', async () => {
    const user = userEvent.setup()
    render(<IntegrationModelEffort integration={makeIntegration({ id: 'custom-id', model: 'sonnet' })} />)

    await user.click(screen.getByTestId('composer-options-trigger'))
    await user.click(await screen.findByTestId('model-option-haiku'))

    expect(mutateMock).toHaveBeenCalledWith({ id: 'custom-id', model: 'haiku' })
  })
})
