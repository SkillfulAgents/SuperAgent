// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const useSettingsMock = vi.fn()
vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => useSettingsMock(),
}))

import { SettingsModelSelect } from './settings-model-select'

const AVAILABLE_MODELS = [
  { value: 'claude-haiku-4-5', label: 'Claude 4.5 Haiku' },
  { value: 'claude-sonnet-4-6', label: 'Claude 4.6 Sonnet' },
  { value: 'claude-opus-4-6', label: 'Claude 4.6 Opus' },
  { value: 'claude-opus-4-7', label: 'Claude 4.7 Opus' },
]
const COMPOSER_MODELS = [
  { family: 'haiku', modelId: 'haiku', label: 'Haiku' },
  { family: 'sonnet', modelId: 'sonnet', label: 'Sonnet' },
  { family: 'opus', modelId: 'opus', label: 'Opus' },
]

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    data: {
      llmProvider: 'anthropic',
      llmProviderStatus: [
        { id: 'anthropic', name: 'Anthropic', isConfigured: true, availableModels: AVAILABLE_MODELS, composerModels: COMPOSER_MODELS },
      ],
    },
  })
})

describe('SettingsModelSelect', () => {
  it('persists a concrete model id (not the family alias) when a family is picked', async () => {
    const user = userEvent.setup()
    const onModelChange = vi.fn()
    render(<SettingsModelSelect model="claude-haiku-4-5" onModelChange={onModelChange} />)

    await user.click(screen.getByTestId('composer-options-trigger'))
    await user.click(await screen.findByTestId('model-option-sonnet'))

    expect(onModelChange).toHaveBeenCalledWith('claude-sonnet-4-6')
    expect(onModelChange).not.toHaveBeenCalledWith('sonnet')
  })

  it('persists the bare family alias when emit="family"', async () => {
    const user = userEvent.setup()
    const onModelChange = vi.fn()
    render(<SettingsModelSelect model="claude-sonnet-4-6" onModelChange={onModelChange} emit="family" />)

    await user.click(screen.getByTestId('composer-options-trigger'))
    await user.click(await screen.findByTestId('model-option-opus'))

    expect(onModelChange).toHaveBeenCalledWith('opus')
  })

  it('keeps the exact pinned version when re-picking the current family', async () => {
    const user = userEvent.setup()
    const onModelChange = vi.fn()
    // Currently on Opus 4.7 — re-picking Opus must not downgrade to 4.6.
    render(<SettingsModelSelect model="claude-opus-4-7" onModelChange={onModelChange} />)

    await user.click(screen.getByTestId('composer-options-trigger'))
    await user.click(await screen.findByTestId('model-option-opus'))

    expect(onModelChange).not.toHaveBeenCalled()
  })

  it('does not render the effort section when includeEffort is false', async () => {
    const user = userEvent.setup()
    render(<SettingsModelSelect model="claude-haiku-4-5" onModelChange={vi.fn()} includeEffort={false} />)

    await user.click(screen.getByTestId('composer-options-trigger'))
    expect(screen.queryByText('Effort')).not.toBeInTheDocument()
  })
})
