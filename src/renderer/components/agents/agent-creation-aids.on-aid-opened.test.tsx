// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockOnAidOpened = vi.fn()
const mockOnVoiceResult = vi.fn()
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
  useIsVoiceAgentConfigured: () => true,
}))

vi.mock('@renderer/lib/api', () => ({
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({ prompt: 'voice system prompt' }),
  })),
}))

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))

vi.mock('@renderer/components/ui/voice-agent', () => ({
  VoiceAgent: () => null,
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
        onVoiceResult={mockOnVoiceResult}
        onImportComplete={mockOnImportComplete}
        onAidOpened={mockOnAidOpened}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Browse Templates/i }))
    expect(mockOnAidOpened).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/explore' })

    await user.click(screen.getByRole('button', { name: /Brainstorm with Voice/i }))
    expect(mockOnAidOpened).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole('button', { name: 'Close' }))

    await user.click(screen.getByRole('button', { name: /Import an Agent/i }))
    expect(mockOnAidOpened).toHaveBeenCalledTimes(3)
  })
})
