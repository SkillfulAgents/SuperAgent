// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProviderApiKeyInput } from './provider-api-key-input'
import { renderWithProviders } from '@renderer/test/test-utils'
import { apiFetch } from '@renderer/lib/api'

const mockSettings = {
  data: {
    apiKeyStatus: {},
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

  it('extracts a readable message from JSON validation errors', async () => {
    const user = userEvent.setup()
    vi.mocked(apiFetch).mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        valid: false,
        error: JSON.stringify({
          type: 'authentication_error',
          message: 'Invalid API key',
          request_id: 'req_123',
        }),
      }),
    } as unknown as Response)

    renderWithProviders(
      <ProviderApiKeyInput
        providerId="anthropic"
        label="Anthropic API Key"
        apiKeySettingsField="anthropicApiKey"
      />
    )

    await user.type(screen.getByLabelText('Anthropic API Key'), 'bad-key')
    await user.click(screen.getByRole('button', { name: 'Validate & Save' }))

    await waitFor(() => {
      expect(screen.getByText('Invalid API key')).toBeInTheDocument()
    })
    expect(screen.queryByText(/request_id/i)).not.toBeInTheDocument()
  })

  it('shows plain-text validation errors unchanged', async () => {
    const user = userEvent.setup()
    vi.mocked(apiFetch).mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        valid: false,
        error: 'OpenRouter API error: 401',
      }),
    } as unknown as Response)

    renderWithProviders(
      <ProviderApiKeyInput
        providerId="openrouter"
        label="OpenRouter API Key"
        apiKeySettingsField="openrouterApiKey"
      />
    )

    await user.type(screen.getByLabelText('OpenRouter API Key'), 'bad-key')
    await user.click(screen.getByRole('button', { name: 'Validate & Save' }))

    await waitFor(() => {
      expect(screen.getByText('OpenRouter API error: 401')).toBeInTheDocument()
    })
  })
})
