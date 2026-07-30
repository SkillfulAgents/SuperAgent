// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeExtras } from './home-extras'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openFolder: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('@renderer/context/file-preview-context', () => ({
  useFilePreview: () => ({ openFolder: mocks.openFolder }),
}))

// The default-model row is a real child here (its own behaviour lives in
// home-default-model.test.tsx) — only its data hooks are stubbed, so this
// file still covers the composition rather than a placeholder.
vi.mock('@renderer/hooks/use-settings', () => ({
  useModelSettings: () => ({
    data: {
      llmProvider: 'anthropic',
      llmProviderStatus: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          isConfigured: true,
          catalog: [
            { id: 'claude-opus-4-8', label: 'Opus 4.8', family: 'opus', isLatest: true, icon: 'anthropic', supportedEfforts: ['low', 'medium', 'high'] },
          ],
        },
      ],
      models: { agentModel: 'claude-opus-4-8', agentEffort: 'medium' },
    },
  }),
}))

vi.mock('@renderer/hooks/use-agent-preferences', () => ({
  useAgentPreferences: () => ({ data: {} }),
  useUpdateAgentPreferences: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ isAuthMode: false, isAdmin: false }),
}))

describe('HomeExtras', () => {
  it('opens Agent Directory in the built-in folder browser', async () => {
    const user = userEvent.setup()
    render(<HomeExtras agentSlug="test-agent" />)

    await user.click(screen.getByTestId('home-agent-directory-open-browser'))

    expect(mocks.openFolder).toHaveBeenCalledWith('/workspace', 'test-agent')
    expect(screen.getByText('Agent Directory')).toBeVisible()
  })

  it('renders the agent default model as the first row, above System Prompt', () => {
    render(<HomeExtras agentSlug="test-agent" />)

    const row = screen.getByTestId('home-default-model-card')
    expect(row).toBeVisible()
    // Its picker is live, not a placeholder — the row wires through to the
    // real SettingsModelSelect and shows the app-wide default.
    expect(screen.getByTestId('settings-model-trigger')).toHaveTextContent('Opus 4.8')

    const labels = screen.getAllByText(/Agent Default Model|System Prompt/)
    expect(labels[0]).toHaveTextContent('Agent Default Model')
  })
})
