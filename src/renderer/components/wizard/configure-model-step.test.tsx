// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GlobalSettingsResponse } from '@renderer/hooks/use-settings'
import type { ModelDefinition, ProviderDefaultModelOption } from '@shared/lib/llm-provider'

const state = vi.hoisted(() => ({
  settings: undefined as GlobalSettingsResponse | undefined,
  mutate: vi.fn(),
}))

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => ({ data: state.settings }),
  useUpdateSettings: () => ({ mutate: state.mutate }),
}))

vi.mock('@renderer/components/settings/settings-model-select', () => ({
  SettingsModelSelect: ({ onModelChange }: { onModelChange: (model: string) => void }) => (
    <button type="button" data-testid="full-catalog-picker" onClick={() => onModelChange('kimi')}>
      Full catalog
    </button>
  ),
}))

import { ConfigureModelStep, findDefaultModelOption } from './configure-model-step'

const CATALOG: ModelDefinition[] = [
  { id: 'claude-opus-5', label: 'Opus 5', family: 'opus', isLatest: true, supportedEfforts: ['low', 'medium', 'high'] },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', family: 'gpt', isLatest: true, supportedEfforts: ['low', 'medium', 'high'] },
  { id: 'grok-4.5', label: 'Grok 4.5', family: 'grok', isLatest: true, supportedEfforts: ['low', 'medium', 'high'] },
  { id: 'kimi-k3', label: 'Kimi K3', family: 'kimi', isLatest: true, supportedEfforts: ['low', 'medium', 'high'] },
]

const OPTIONS: ProviderDefaultModelOption[] = [
  { model: 'opus', label: 'Opus', tag: 'Deep reasoning', description: 'Opus copy' },
  { model: 'gpt', label: 'GPT-5.6', tag: 'OpenAI flagship', description: 'GPT copy' },
  { model: 'grok', label: 'Grok 4.5', tag: 'Recommended', description: 'Grok copy' },
]

function platformSettings(agentModel = 'grok'): GlobalSettingsResponse {
  return {
    llmProvider: 'platform',
    llmProviderStatus: [{
      id: 'platform',
      name: 'Platform',
      isConfigured: true,
      catalog: [...CATALOG],
      defaultModels: { agent: 'grok', summarizer: 'haiku', browser: 'sonnet' },
      defaultModelOptions: OPTIONS,
      capabilities: { modelSearch: false },
    }],
    models: {
      agentModel,
      summarizerModel: 'haiku',
      browserModel: 'sonnet',
      dashboardBuilderModel: 'opus',
      agentEffort: 'medium',
    },
  } as unknown as GlobalSettingsResponse
}

function renderStep() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(['settings'], state.settings)
  return render(
    <QueryClientProvider client={queryClient}>
      <ConfigureModelStep />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  state.settings = platformSettings()
  state.mutate.mockReset()
})

describe('ConfigureModelStep', () => {
  it('renders the provider-owned Platform shortlist with Grok selected by default', () => {
    renderStep()

    expect(screen.getByRole('radio', { name: /Opus/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /GPT-5\.6/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Grok 4\.5/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('radio', { name: /Sonnet/ })).not.toBeInTheDocument()
  })

  it('shows the full catalog picker under Other and persists its selection', async () => {
    const user = userEvent.setup()
    renderStep()

    expect(screen.queryByTestId('full-catalog-picker')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('wizard-model-other'))
    expect(screen.getByTestId('full-catalog-picker')).toBeInTheDocument()

    await user.click(screen.getByTestId('full-catalog-picker'))
    await waitFor(() => {
      expect(state.mutate).toHaveBeenCalledWith(
        { models: { agentModel: 'kimi' } },
        expect.objectContaining({ onError: expect.any(Function) }),
      )
    })
  })

  it('opens Other automatically for a model outside the curated shortlist', () => {
    state.settings = platformSettings('kimi')
    renderStep()

    expect(screen.getByTestId('wizard-model-other')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('full-catalog-picker')).toBeInTheDocument()
  })
})

describe('findDefaultModelOption', () => {
  it('matches pinned versions by family while leaving non-shortlisted families to Other', () => {
    expect(findDefaultModelOption('claude-opus-5', OPTIONS, [...CATALOG])?.model).toBe('opus')
    expect(findDefaultModelOption('kimi-k3', OPTIONS, [...CATALOG])).toBeUndefined()
  })
})
