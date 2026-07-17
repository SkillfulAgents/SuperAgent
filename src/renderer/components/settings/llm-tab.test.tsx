// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const useSettingsMock = vi.fn()
const mutateMock = vi.fn()
const apiFetchMock = vi.fn()
const useProviderModelSearchMock = vi.fn()

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => useSettingsMock(),
  useModelConfig: () => {
    const result = useSettingsMock()
    const active = result.data?.llmProviderStatus?.find(
      (provider: { id: string }) => provider.id === result.data?.llmProvider,
    )
    return {
      ...result,
      data: result.data ? {
        llmProvider: result.data.llmProvider,
        catalog: active?.catalog ?? [],
        defaultModels: active?.defaultModels,
        models: result.data.models,
        webProvider: result.data.webProvider,
      } : undefined,
    }
  },
  useProviderModelSearch: (...args: unknown[]) => useProviderModelSearchMock(...args),
  useUpdateSettings: () => ({ mutate: mutateMock }),
}))

vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => ({ data: { connected: true } }),
}))

import { LlmTab } from './llm-tab'
import type { ModelDefinition } from '@shared/lib/llm-provider'

type TestProvider = 'anthropic' | 'openrouter' | 'platform'
type TestUser = ReturnType<typeof userEvent.setup>

const BUILTIN: ModelDefinition[] = [
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    family: 'gpt',
    icon: 'openai',
    supportedEfforts: ['low', 'medium', 'high'],
    pricing: { inputPerMtok: 2.5, outputPerMtok: 15 },
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    family: 'gpt',
    isLatest: true,
    icon: 'openai',
    supportedEfforts: ['low', 'medium', 'high'],
    pricing: { inputPerMtok: 5, outputPerMtok: 30 },
  },
]

function renderWithSettings(options?: {
  modelCatalog?: Record<string, { overrides: unknown[] }>
  catalog?: ModelDefinition[]
  providerId?: TestProvider
  modelSearch?: boolean
}) {
  // Default to a self-managed provider so the catalog editor is rendered (the
  // platform provider intentionally hides it).
  const providerId = options?.providerId ?? 'anthropic'
  const providerName =
    providerId === 'openrouter' ? 'OpenRouter' : providerId === 'platform' ? 'Platform' : 'Anthropic'
  useSettingsMock.mockReturnValue({
    isLoading: false,
    data: {
      llmProvider: providerId,
      llmProviderStatus: [
        {
          id: providerId,
          name: providerName,
          isConfigured: true,
          catalog: options?.catalog ?? BUILTIN,
          builtinCatalog: BUILTIN,
          defaultModels: { agent: 'gpt', summarizer: 'gpt', browser: 'gpt' },
          capabilities: { modelSearch: options?.modelSearch ?? false },
        },
      ],
      modelCatalog: options?.modelCatalog ?? {},
      models: {
        agentModel: 'gpt',
        summarizerModel: 'gpt',
        dashboardBuilderModel: 'gpt',
        agentEffort: 'medium',
      },
      hasRunningAgents: false,
      enableToolSearch: true,
    },
  })
  return render(<LlmTab />)
}

/** The catalog editor is collapsed by default; open it before touching rows. */
async function openCatalog(user: TestUser) {
  await user.click(screen.getByTestId('catalog-disclosure-trigger'))
}

beforeEach(() => {
  vi.clearAllMocks()
  apiFetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({}),
  })
  useProviderModelSearchMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  })
})

describe('LlmTab model catalog editor', () => {
  it('keeps the catalog collapsed until the disclosure is opened', async () => {
    const user = userEvent.setup()
    renderWithSettings()

    // Editor wrapper is present, but rows are hidden behind the disclosure.
    expect(screen.getByTestId('model-catalog-editor')).toBeInTheDocument()
    expect(screen.queryByTestId('catalog-toggle-gpt-5.5')).not.toBeInTheDocument()

    await openCatalog(user)
    expect(screen.getByTestId('catalog-toggle-gpt-5.5')).toBeInTheDocument()
  })

  it('does not render the catalog editor for the platform provider', () => {
    renderWithSettings({ providerId: 'platform' })
    expect(screen.queryByTestId('model-catalog-editor')).not.toBeInTheDocument()
  })

  it('toggles a built-in model by writing a disabled override', async () => {
    const user = userEvent.setup()
    renderWithSettings()
    await openCatalog(user)

    await user.click(screen.getByTestId('catalog-toggle-gpt-5.5'))

    expect(mutateMock).toHaveBeenCalledWith({
      modelCatalog: {
        anthropic: { overrides: [{ id: 'gpt-5.5', disabled: true }] },
      },
    })
  })

  it('opens a pricing modal from the built-in row gear and writes pricing patches', async () => {
    const user = userEvent.setup()
    const firstRender = renderWithSettings()
    await openCatalog(user)

    await user.click(screen.getByTestId('catalog-customize-gpt-5.5'))
    expect(screen.getByLabelText('Input price')).toBe(screen.getByTestId('catalog-builtin-price-input'))
    expect(screen.getByLabelText('Output price')).toBe(screen.getByTestId('catalog-builtin-price-output'))
    expect(screen.getByTestId('catalog-builtin-price-input')).toHaveAccessibleDescription('USD per million tokens')
    expect(screen.getAllByText('$')).toHaveLength(2)

    fireEvent.change(screen.getByTestId('catalog-builtin-price-input'), {
      target: { value: '6' },
    })
    await user.click(screen.getByTestId('catalog-save-builtin-pricing'))

    expect(mutateMock).toHaveBeenCalledWith({
      modelCatalog: {
        anthropic: {
          overrides: [{ id: 'gpt-5.5', pricing: { inputPerMtok: 6, outputPerMtok: 30 } }],
        },
      },
    })

    mutateMock.mockClear()
    firstRender.unmount()
    renderWithSettings({
      modelCatalog: {
        anthropic: {
          overrides: [{ id: 'gpt-5.5', pricing: { inputPerMtok: 6, outputPerMtok: 30 } }],
        },
      },
    })
    fireEvent.click(screen.getByTestId('catalog-disclosure-trigger'))
    fireEvent.click(screen.getByTestId('catalog-customize-gpt-5.5'))
    fireEvent.click(screen.getByTestId('catalog-reset-pricing-gpt-5.5'))
    expect(mutateMock).toHaveBeenCalledWith({ modelCatalog: {} })
  })

  it('requires a label and effort before adding a custom model', async () => {
    const user = userEvent.setup()
    renderWithSettings()
    await openCatalog(user)

    await user.click(screen.getByTestId('catalog-open-add-custom-model'))
    expect(screen.getByLabelText('Model ID')).toBeInTheDocument()
    expect(screen.getByLabelText('Display label')).toBeInTheDocument()
    expect(screen.getByLabelText('Family')).toBeInTheDocument()
    expect(screen.getByLabelText('Icon key')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload model icon' })).toBeInTheDocument()
    expect(screen.getByText('Supported efforts')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Model ID'), 'custom-model-1')
    expect(screen.getByTestId('catalog-add-custom-model')).toBeDisabled()

    await user.type(screen.getByLabelText('Display label'), 'Custom Model')
    await user.click(screen.getByTestId('catalog-add-custom-model'))

    expect(mutateMock).toHaveBeenCalledWith({
      modelCatalog: {
        anthropic: {
          overrides: [
            {
              id: 'custom-model-1',
              label: 'Custom Model',
              supportedEfforts: ['low', 'medium', 'high'],
            },
          ],
        },
      },
    })
  })

  it('uploads a custom icon and persists the returned icon key', async () => {
    const user = userEvent.setup()
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ icon: 'uploaded:test-icon.svg' }),
    })
    renderWithSettings()
    await openCatalog(user)

    await user.click(screen.getByTestId('catalog-open-add-custom-model'))
    await user.upload(
      screen.getByTestId('catalog-custom-icon-file'),
      new File(['<svg />'], 'test-icon.svg', { type: 'image/svg+xml' }),
    )

    expect(apiFetchMock).toHaveBeenCalledWith('/api/settings/model-icons', {
      method: 'POST',
      body: expect.any(FormData),
    })
    expect(screen.getByLabelText('Icon key')).toHaveValue('uploaded:test-icon.svg')

    await user.type(screen.getByLabelText('Model ID'), 'custom-model-1')
    await user.type(screen.getByLabelText('Display label'), 'Custom Model')
    await user.click(screen.getByTestId('catalog-add-custom-model'))

    expect(mutateMock).toHaveBeenCalledWith({
      modelCatalog: {
        anthropic: {
          overrides: [
            {
              id: 'custom-model-1',
              label: 'Custom Model',
              icon: 'uploaded:test-icon.svg',
              supportedEfforts: ['low', 'medium', 'high'],
            },
          ],
        },
      },
    })
  })

  it('prefills custom model details from provider model search', async () => {
    const user = userEvent.setup()
    useProviderModelSearchMock.mockReturnValue({
      data: [
        {
          id: 'qwen/qwen3-max',
          label: 'Qwen3 Max',
          family: 'qwen',
          blurb: 'Qwen model from OpenRouter.',
          supportedEfforts: ['low', 'medium', 'high'],
          pricing: { inputPerMtok: 0.4, outputPerMtok: 1.2 },
          contextWindow: 262144,
          supportsWebSearch: false,
          supportsImageInput: true,
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    })
    renderWithSettings({ providerId: 'openrouter', modelSearch: true })
    await openCatalog(user)

    await user.click(screen.getByTestId('catalog-open-add-custom-model'))
    await user.type(screen.getByLabelText('Search provider models'), 'qwen')

    await waitFor(() => {
      expect(screen.getByTestId('catalog-search-result-qwen/qwen3-max')).toBeInTheDocument()
    })
    await user.click(screen.getByTestId('catalog-search-result-qwen/qwen3-max'))

    expect(screen.getByLabelText('Model ID')).toHaveValue('qwen/qwen3-max')
    expect(screen.getByLabelText('Display label')).toHaveValue('Qwen3 Max')
    expect(screen.getByLabelText('Family')).toHaveValue('qwen')
    expect(screen.getByLabelText('Input price')).toHaveValue(0.4)
    expect(screen.getByLabelText('Output price')).toHaveValue(1.2)

    await user.click(screen.getByTestId('catalog-add-custom-model'))

    expect(mutateMock).toHaveBeenCalledWith({
      modelCatalog: {
        openrouter: {
          overrides: [
            {
              id: 'qwen/qwen3-max',
              label: 'Qwen3 Max',
              family: 'qwen',
              blurb: 'Qwen model from OpenRouter.',
              supportedEfforts: ['low', 'medium', 'high'],
              pricing: { inputPerMtok: 0.4, outputPerMtok: 1.2 },
              contextWindow: 262144,
              supportsWebSearch: false,
              supportsImageInput: true,
            },
          ],
        },
      },
    })
  })

  it('fully edits a custom model from its row gear, preserving id and carried-through fields', async () => {
    const user = userEvent.setup()
    const custom: ModelDefinition = {
      id: 'custom-model-1',
      label: 'Custom Model',
      family: 'custom',
      icon: 'uploaded:test-icon.svg',
      blurb: 'A carried-through blurb.',
      contextWindow: 100000,
      supportsWebSearch: false,
      supportedEfforts: ['low'],
      pricing: { inputPerMtok: 1, outputPerMtok: 2 },
    }
    renderWithSettings({
      modelCatalog: { anthropic: { overrides: [custom] } },
      catalog: [BUILTIN[0], custom],
    })
    await openCatalog(user)

    // Built-in gear is pricing-only; the custom gear opens the full editor.
    await user.click(screen.getByTestId('catalog-customize-custom-model-1'))
    expect(screen.getByLabelText('Model ID')).toHaveValue('custom-model-1')
    expect(screen.getByLabelText('Model ID')).toBeDisabled()
    expect(screen.getByLabelText('Display label')).toHaveValue('Custom Model')
    expect(screen.getByLabelText('Family')).toHaveValue('custom')

    const labelField = screen.getByLabelText('Display label')
    await user.clear(labelField)
    await user.type(labelField, 'Renamed Model')
    await user.click(screen.getByTestId('catalog-save-custom-model'))

    expect(mutateMock).toHaveBeenCalledWith({
      modelCatalog: {
        anthropic: {
          overrides: [
            {
              id: 'custom-model-1',
              label: 'Renamed Model',
              family: 'custom',
              icon: 'uploaded:test-icon.svg',
              supportedEfforts: ['low'],
              pricing: { inputPerMtok: 1, outputPerMtok: 2 },
              blurb: 'A carried-through blurb.',
              contextWindow: 100000,
              supportsWebSearch: false,
            },
          ],
        },
      },
    })
  })

  it('removes custom models while disabled built-ins remain visible in the editor', async () => {
    const user = userEvent.setup()
    const custom: ModelDefinition = {
      id: 'custom-model-1',
      label: 'Custom Model',
      supportedEfforts: ['low'],
      pricing: { inputPerMtok: 1, outputPerMtok: 2 },
    }

    renderWithSettings({
      modelCatalog: {
        anthropic: {
          overrides: [
            { id: 'gpt-5.5', disabled: true },
            {
              id: 'custom-model-1',
              label: 'Custom Model',
              supportedEfforts: ['low'],
              pricing: { inputPerMtok: 1, outputPerMtok: 2 },
            },
          ],
        },
      },
      catalog: [BUILTIN[0], custom],
    })
    await openCatalog(user)

    expect(screen.getByText('GPT-5.5')).toBeInTheDocument()
    expect(screen.getByText('$1/$2/MTok')).toBeInTheDocument()
    expect(screen.getByTestId('catalog-toggle-custom-model-1')).toHaveAttribute('data-state', 'checked')
    expect(screen.getByTestId('catalog-customize-custom-model-1')).toBeInTheDocument()
    await user.click(screen.getByTestId('catalog-remove-custom-custom-model-1'))
    expect(screen.getByText('Delete Custom Model')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Delete Model' }))

    expect(mutateMock).toHaveBeenCalledWith({
      modelCatalog: {
        anthropic: { overrides: [{ id: 'gpt-5.5', disabled: true }] },
      },
    })
  })

  it('toggles custom models without dropping their saved model details', async () => {
    const user = userEvent.setup()
    const customOverride: ModelDefinition = {
      id: 'custom-model-1',
      label: 'Custom Model',
      family: 'custom',
      icon: 'uploaded:test-icon.svg',
      supportedEfforts: ['low'],
      pricing: { inputPerMtok: 1, outputPerMtok: 2 },
    }
    const firstRender = renderWithSettings({
      modelCatalog: {
        anthropic: {
          overrides: [customOverride],
        },
      },
      catalog: [BUILTIN[0], customOverride],
    })
    await openCatalog(user)

    await user.click(screen.getByTestId('catalog-toggle-custom-model-1'))

    expect(mutateMock).toHaveBeenCalledWith({
      modelCatalog: {
        anthropic: {
          overrides: [{ ...customOverride, disabled: true }],
        },
      },
    })

    mutateMock.mockClear()
    firstRender.unmount()
    renderWithSettings({
      modelCatalog: {
        anthropic: {
          overrides: [{ ...customOverride, disabled: true }],
        },
      },
      catalog: BUILTIN,
    })
    await openCatalog(user)

    expect(screen.getByText('Custom Model')).toBeInTheDocument()
    expect(screen.getByText('$1/$2/MTok')).toBeInTheDocument()
    expect(screen.getByTestId('catalog-toggle-custom-model-1')).toHaveAttribute('data-state', 'unchecked')

    await user.click(screen.getByTestId('catalog-toggle-custom-model-1'))

    expect(mutateMock).toHaveBeenCalledWith({
      modelCatalog: {
        anthropic: {
          overrides: [customOverride],
        },
      },
    })
  })
})
