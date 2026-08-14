// @vitest-environment jsdom
/**
 * Override cards must show the same inherit the host sends:
 * surface → agent default → app default.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IntegrationModelEffort } from '@renderer/components/chat-integrations/integration-settings-controls'
import { makeChatIntegration } from '@renderer/components/chat-integrations/test-factories'
import { RuntimeOptionsCard } from './runtime-options-card'
import type { ModelDefinition } from '@shared/lib/llm-provider'
import type { EffortLevel } from '@shared/lib/container/types'

const STD: EffortLevel[] = ['low', 'medium', 'high']
const CATALOG: ModelDefinition[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', family: 'opus', isLatest: true, icon: 'anthropic', supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', family: 'sonnet', isLatest: true, icon: 'anthropic', supportedEfforts: STD },
]

const useSettingsMock = vi.fn()
const useAgentPreferencesMock = vi.fn()
const mutateChat = vi.hoisted(() => vi.fn())

vi.mock('@renderer/hooks/use-chat-integrations', () => ({
  useUpdateChatIntegration: () => ({ mutate: mutateChat, isPending: false }),
}))

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => useSettingsMock(),
  useModelSettings: () => useSettingsMock(),
}))

vi.mock('@renderer/hooks/use-agent-preferences', () => ({
  useAgentPreferences: (slug?: string) => useAgentPreferencesMock(slug),
}))

function settingsWith(models: { agentModel: string; agentEffort: EffortLevel }) {
  return {
    data: {
      llmProvider: 'anthropic',
      llmProviderStatus: [{
        id: 'anthropic',
        catalog: CATALOG,
        defaultModels: { agent: 'opus', summarizer: 'haiku', browser: 'sonnet' },
      }],
      models,
    },
  }
}

function cronCard(onUpdate = vi.fn()) {
  return (
    <RuntimeOptionsCard
      agentSlug="a"
      model={null}
      effort={null}
      speed={null}
      onUpdate={onUpdate}
    />
  )
}

beforeEach(() => {
  mutateChat.mockReset()
  useSettingsMock.mockReturnValue(settingsWith({
    agentModel: 'claude-opus-4-8',
    agentEffort: 'high',
  }))
  useAgentPreferencesMock.mockImplementation(() => ({ data: {} }))
})

describe('override-card inherit', () => {
  it('chat card: unset shows inherited model and effort, not Select model · Medium', () => {
    render(<IntegrationModelEffort integration={makeChatIntegration()} />)
    const text = screen.getByTestId('settings-model-trigger').textContent ?? ''
    expect(text).toContain('Opus 4.8')
    expect(text).toContain('High')
    expect(text).not.toMatch(/Select model/)
    expect(text).not.toContain('Medium')
  })

  it('cron/webhook card: unset effort follows app default Low, not hardcoded High', () => {
    useSettingsMock.mockReturnValue(settingsWith({
      agentModel: 'claude-opus-4-8',
      agentEffort: 'low',
    }))
    render(cronCard())
    const text = screen.getByTestId('settings-model-trigger').textContent ?? ''
    expect(text).toContain('Opus 4.8')
    expect(text).toContain('Low')
    expect(text).not.toContain('High')
    expect(useAgentPreferencesMock).toHaveBeenCalledWith('a')
  })

  it('cron/webhook card: agent default effort beats the app default', () => {
    useAgentPreferencesMock.mockImplementation(() => ({ data: { defaultEffort: 'low' } }))
    render(cronCard())
    const text = screen.getByTestId('settings-model-trigger').textContent ?? ''
    expect(text).toContain('Low')
    expect(text).not.toContain('Medium')
    expect(text).not.toContain('High')
  })

  it('chat card: agent default effort beats the app default and loads prefs by slug', () => {
    useAgentPreferencesMock.mockImplementation(() => ({ data: { defaultEffort: 'low' } }))
    render(<IntegrationModelEffort integration={makeChatIntegration()} />)
    const text = screen.getByTestId('settings-model-trigger').textContent ?? ''
    expect(text).toContain('Low')
    expect(text).not.toContain('High')
    expect(useAgentPreferencesMock).toHaveBeenCalledWith('a')
  })

  it('both cards show a blank state while settings have not loaded', () => {
    useSettingsMock.mockReturnValue({ data: undefined })
    const cron = render(cronCard())
    expect(screen.getByTestId('runtime-inherit-pending')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-model-trigger')).not.toBeInTheDocument()
    cron.unmount()

    render(<IntegrationModelEffort integration={makeChatIntegration()} />)
    expect(screen.getByTestId('runtime-inherit-pending')).toBeInTheDocument()
    expect(screen.queryByTestId('settings-model-trigger')).not.toBeInTheDocument()
  })

  it('opening does not persist a clamp on either card', async () => {
    const onUpdate = vi.fn()
    useSettingsMock.mockReturnValue(settingsWith({
      agentModel: 'claude-sonnet-4-6',
      agentEffort: 'max',
    }))
    // Leftover Fast on a catalog model with no supportedSpeeds — the common case.
    useAgentPreferencesMock.mockImplementation(() => ({ data: { defaultSpeed: 'fast' } }))
    const cron = render(cronCard(onUpdate))
    await waitFor(() => expect(screen.getByTestId('settings-model-trigger')).toBeInTheDocument())
    expect(onUpdate).not.toHaveBeenCalled()
    cron.unmount()

    render(<IntegrationModelEffort integration={makeChatIntegration()} />)
    await waitFor(() => expect(screen.getByTestId('settings-model-trigger')).toBeInTheDocument())
    expect(mutateChat).not.toHaveBeenCalled()
  })

  it('keeps a pick when prefs land after a click', async () => {
    const user = userEvent.setup()
    const onUpdate = vi.fn()
    useAgentPreferencesMock.mockImplementation(() => ({ data: undefined }))
    const { rerender } = render(cronCard(onUpdate))
    await user.click(screen.getByTestId('settings-model-trigger'))
    await user.click(await screen.findByTestId('effort-option-low'))
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate).toHaveBeenCalledWith({ effort: 'low' })

    useAgentPreferencesMock.mockImplementation(() => ({ data: { defaultEffort: 'high' } }))
    rerender(cronCard(onUpdate))
    expect(screen.getByTestId('settings-model-trigger').textContent).toContain('Low')
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('hides Reset for a stored override while settings are down', () => {
    const onUpdate = vi.fn()
    useSettingsMock.mockReturnValue({ data: undefined })
    render(
      <RuntimeOptionsCard
        agentSlug="a"
        model="claude-opus-4-8"
        effort="high"
        speed={null}
        onUpdate={onUpdate}
      />,
    )
    expect(screen.queryByRole('button', { name: /reset/i })).not.toBeInTheDocument()
    expect(onUpdate).not.toHaveBeenCalled()
  })
})
