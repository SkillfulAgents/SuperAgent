// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const useSettingsMock = vi.fn()
vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => useSettingsMock(),
}))

import { SettingsModelSelect } from './settings-model-select'

const ALL = ['low', 'medium', 'high', 'xhigh', 'max']
const STD = ['low', 'medium', 'high']
const CATALOG = [
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', family: 'haiku', isLatest: true, icon: 'anthropic', supportedEfforts: STD },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', family: 'sonnet', isLatest: true, icon: 'anthropic', supportedEfforts: STD },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', family: 'opus', icon: 'anthropic', supportedEfforts: ALL },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', family: 'opus', icon: 'anthropic', supportedEfforts: ALL },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', family: 'opus', isLatest: true, icon: 'anthropic', supportedEfforts: ALL },
  // A model with no native web tools: the only shape that surfaces the web-tools warning.
  { id: 'glm-4-6', label: 'GLM 4.6', family: 'glm', icon: 'anthropic', supportedEfforts: STD, supportsWebSearch: false },
]

function settingsWith(web: { webProvider: string; webProviderIsDefault?: boolean }) {
  return {
    data: {
      llmProvider: 'anthropic',
      llmProviderStatus: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          isConfigured: true,
          catalog: CATALOG,
          defaultModels: { agent: 'opus', summarizer: 'haiku', browser: 'sonnet' },
        },
      ],
      ...web,
    },
  }
}

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    data: {
      llmProvider: 'anthropic',
      llmProviderStatus: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          isConfigured: true,
          catalog: CATALOG,
          defaultModels: { agent: 'opus', summarizer: 'haiku', browser: 'sonnet' },
        },
      ],
    },
  })
})

describe('SettingsModelSelect (flat picker)', () => {
  it('stores the bare family alias when "latest" is picked', async () => {
    const user = userEvent.setup()
    const onModelChange = vi.fn()
    render(<SettingsModelSelect model="claude-haiku-4-5" onModelChange={onModelChange} />)

    await user.click(screen.getByTestId('settings-model-trigger'))
    await user.click(await screen.findByTestId('model-latest-opus'))

    expect(onModelChange).toHaveBeenCalledWith('opus')
  })

  it('stores the concrete id when a specific version is pinned', async () => {
    const user = userEvent.setup()
    const onModelChange = vi.fn()
    render(<SettingsModelSelect model="claude-haiku-4-5" onModelChange={onModelChange} />)

    await user.click(screen.getByTestId('settings-model-trigger'))
    await user.click(await screen.findByTestId('model-pinned-claude-opus-4-7'))

    expect(onModelChange).toHaveBeenCalledWith('claude-opus-4-7')
  })

  it('marks a bare alias selection as "latest" in the trigger', () => {
    render(<SettingsModelSelect model="opus" onModelChange={vi.fn()} />)
    expect(screen.getByTestId('settings-model-trigger')).toHaveTextContent('Opus · latest')
  })

  it('marks a concrete id selection as "pinned" in the trigger', () => {
    render(<SettingsModelSelect model="claude-opus-4-8" onModelChange={vi.fn()} />)
    expect(screen.getByTestId('settings-model-trigger')).toHaveTextContent('Opus 4.8 · pinned')
  })

  it('does not render the effort section when includeEffort is false', async () => {
    const user = userEvent.setup()
    render(<SettingsModelSelect model="claude-haiku-4-5" onModelChange={vi.fn()} includeEffort={false} />)

    await user.click(screen.getByTestId('settings-model-trigger'))
    expect(screen.queryByText('Effort')).not.toBeInTheDocument()
  })

  it('hides xhigh/max effort for the selected Sonnet model', async () => {
    const user = userEvent.setup()
    render(
      <SettingsModelSelect
        model="claude-sonnet-4-6"
        onModelChange={vi.fn()}
        includeEffort
        effort="medium"
        onEffortChange={vi.fn()}
      />,
    )
    await user.click(screen.getByTestId('settings-model-trigger'))
    expect(screen.getByTestId('effort-option-high')).toBeInTheDocument()
    expect(screen.queryByTestId('effort-option-xhigh')).not.toBeInTheDocument()
    expect(screen.queryByTestId('effort-option-max')).not.toBeInTheDocument()
  })

  describe('web-tools warning reads the active vendor', () => {
    it('stays hidden when a host vendor is active', async () => {
      useSettingsMock.mockReturnValue(settingsWith({ webProvider: 'platform', webProviderIsDefault: true }))
      const user = userEvent.setup()
      render(<SettingsModelSelect model="glm-4-6" onModelChange={vi.fn()} />)

      await user.click(screen.getByTestId('settings-model-trigger'))
      expect(screen.queryByTestId('model-no-websearch-warning')).not.toBeInTheDocument()
    })

    it('shows when the active vendor is native and the model has no web tools', async () => {
      useSettingsMock.mockReturnValue(settingsWith({ webProvider: 'native', webProviderIsDefault: true }))
      const user = userEvent.setup()
      render(<SettingsModelSelect model="glm-4-6" onModelChange={vi.fn()} />)

      await user.click(screen.getByTestId('settings-model-trigger'))
      expect(await screen.findByTestId('model-no-websearch-warning')).toBeInTheDocument()
    })
  })
})
