// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockOnAidOpened = vi.fn()
const mockOnStartVoiceMode = vi.fn()
const mockOnImportComplete = vi.fn()

vi.mock('@renderer/hooks/use-agent-templates', () => ({
  useDiscoverableAgents: () => ({ data: [{ skillsetId: 's1', path: 'agents/x/' }] }),
  useImportAgentTemplate: () => ({
    mutateAsync: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null,
  }),
}))

vi.mock('@renderer/hooks/use-voice-input', () => ({
  useCanUseVoiceMode: () => true,
}))

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))

import { AgentCreationAids } from './agent-creation-aids'

describe('AgentCreationAids onAidOpened', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fires onAidOpened for browse, voice, and import entry points', async () => {
    const user = userEvent.setup()
    render(
      <AgentCreationAids
        onStartVoiceMode={mockOnStartVoiceMode}
        onImportComplete={mockOnImportComplete}
        onAidOpened={mockOnAidOpened}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Browse Templates/i }))
    expect(mockOnAidOpened).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/explore' })

    await user.click(screen.getByRole('button', { name: /Brainstorm with Voice/i }))
    expect(mockOnAidOpened).toHaveBeenCalledTimes(2)
    expect(mockOnStartVoiceMode).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: /Import an Agent/i }))
    expect(mockOnAidOpened).toHaveBeenCalledTimes(3)
  })
})

/**
 * Browse Templates leaves for `/explore`, and the wizard hosts this component
 * in a full-screen overlay mounted ABOVE the router. Navigating first would
 * park the user on a page the overlay covers, so the hook has to finish before
 * the navigation — an ordering neither the component's own render nor the
 * wizard e2e can observe, since both orders reach the same end state.
 */
describe('AgentCreationAids onNavigateAway', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function renderAids(onNavigateAway?: () => Promise<void>) {
    render(
      <AgentCreationAids
        onStartVoiceMode={mockOnStartVoiceMode}
        onImportComplete={mockOnImportComplete}
        onNavigateAway={onNavigateAway}
      />,
    )
  }

  it('waits for the hook to settle before navigating', async () => {
    const user = userEvent.setup()
    let finishNavigateAway = () => {}
    const onNavigateAway = vi.fn(
      () => new Promise<void>((resolve) => { finishNavigateAway = resolve }),
    )
    renderAids(onNavigateAway)

    await user.click(screen.getByRole('button', { name: /Browse Templates/i }))
    expect(onNavigateAway).toHaveBeenCalledTimes(1)
    expect(mockNavigate).not.toHaveBeenCalled()

    await act(async () => { finishNavigateAway() })
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/explore' })
  })

  it('still navigates when the hook rejects', async () => {
    const user = userEvent.setup()
    // The wizard's hook is a settings PUT whose mutation sets
    // `skipGlobalErrorToast`, so a rejection here is silent — swallowing the
    // navigation with it would leave the card looking dead.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderAids(vi.fn(() => Promise.reject(new Error('settings write failed'))))

    await user.click(screen.getByRole('button', { name: /Browse Templates/i }))

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/explore' })
    consoleError.mockRestore()
  })
})
