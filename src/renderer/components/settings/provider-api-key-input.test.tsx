// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProviderApiKeyInput } from './provider-api-key-input'
import { renderWithProviders } from '@renderer/test/test-utils'

const mockSettings = {
  data: {
    apiKeyStatus: {
      anthropic: {
        isConfigured: true,
        source: 'settings' as const,
      },
    },
  },
}

const mockUpdateSettings = {
  mutateAsync: vi.fn().mockResolvedValue({}),
}

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => mockSettings,
  useUpdateSettings: () => mockUpdateSettings,
}))

vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(),
}))

describe('ProviderApiKeyInput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens a confirmation dialog before removing a saved key', async () => {
    const user = userEvent.setup()

    renderWithProviders(
      <ProviderApiKeyInput
        providerId="anthropic"
        label="Anthropic API Key"
        apiKeySettingsField="anthropicApiKey"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Remove Saved Key' }))

    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Remove Saved Key' })).toBeInTheDocument()
    expect(mockUpdateSettings.mutateAsync).not.toHaveBeenCalled()
  })

  it('does not remove the key when the dialog is cancelled', async () => {
    const user = userEvent.setup()

    renderWithProviders(
      <ProviderApiKeyInput
        providerId="anthropic"
        label="Anthropic API Key"
        apiKeySettingsField="anthropicApiKey"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Remove Saved Key' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    expect(mockUpdateSettings.mutateAsync).not.toHaveBeenCalled()
  })

  it('removes the key after confirmation', async () => {
    const user = userEvent.setup()

    renderWithProviders(
      <ProviderApiKeyInput
        providerId="anthropic"
        label="Anthropic API Key"
        apiKeySettingsField="anthropicApiKey"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Remove Saved Key' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() => {
      expect(mockUpdateSettings.mutateAsync).toHaveBeenCalledWith({
        apiKeys: { anthropicApiKey: '' },
      })
    })
  })
})
