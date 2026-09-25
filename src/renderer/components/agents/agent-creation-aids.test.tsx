// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockOnStartVoiceMode = vi.fn()
const mockOnImportComplete = vi.fn()
let mockCanUseVoiceMode = true

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
  useCanUseVoiceMode: () => mockCanUseVoiceMode,
}))

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))

import { AgentCreationAids } from './agent-creation-aids'

describe('AgentCreationAids', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCanUseVoiceMode = true
  })

  function renderAids() {
    render(
      <AgentCreationAids
        onStartVoiceMode={mockOnStartVoiceMode}
        onImportComplete={mockOnImportComplete}
      />,
    )
  }

  it('routes each card to its action', async () => {
    const user = userEvent.setup()
    renderAids()

    await user.click(screen.getByRole('button', { name: /Browse Templates/i }))
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/explore' })

    await user.click(screen.getByRole('button', { name: /Brainstorm with Voice/i }))
    expect(mockOnStartVoiceMode).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: /Import an Agent/i }))
    expect(await screen.findByRole('dialog', { name: 'Import an Agent' })).toBeTruthy()
  })

  it('hides the voice card when voice mode is unavailable', () => {
    mockCanUseVoiceMode = false
    renderAids()

    expect(screen.queryByRole('button', { name: /Brainstorm with Voice/i })).toBeNull()
    expect(screen.getByRole('button', { name: /Import an Agent/i })).toBeTruthy()
  })
})
