// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VoiceModeBoundary, voiceModeNotice } from './voice-mode'
import { VOICE_MODE_ENTERED_MESSAGE, VOICE_MODE_EXITED_MESSAGE } from '@shared/lib/voice/voice-mode-messages'
import type { ApiMessage } from '@shared/lib/types/api'

const message = {
  id: 'm1',
  type: 'user',
  content: { text: '' },
  createdAt: new Date('2025-01-01T10:30:00Z'),
} as unknown as ApiMessage

describe('VoiceModeBoundary', () => {
  it('draws the entry notice as a labelled boundary and never shows the notice text', () => {
    const renderMarkdown = vi.fn()
    render(<VoiceModeBoundary text={VOICE_MODE_ENTERED_MESSAGE} message={message} renderMarkdown={renderMarkdown} />)
    const boundary = screen.getByTestId('voice-mode-boundary')
    expect(boundary).toHaveTextContent('Entered Voice Mode')
    expect(boundary).toHaveAttribute('data-notice', 'entered')
    expect(screen.queryByText(/read aloud/)).not.toBeInTheDocument()
    expect(renderMarkdown).not.toHaveBeenCalled()
  })

  it('draws the exit notice', () => {
    render(<VoiceModeBoundary text={VOICE_MODE_EXITED_MESSAGE} message={message} renderMarkdown={vi.fn()} />)
    const boundary = screen.getByTestId('voice-mode-boundary')
    expect(boundary).toHaveTextContent('Exited Voice Mode')
    expect(boundary).toHaveAttribute('data-notice', 'exited')
  })

  it('is registered as a visible row kind', () => {
    expect(voiceModeNotice.chrome).toBe('row')
    expect(voiceModeNotice.hidden).toBe(false)
    expect(voiceModeNotice.match(VOICE_MODE_ENTERED_MESSAGE)).toBe(true)
    expect(voiceModeNotice.match('[SYSTEM] Something else')).toBe(false)
  })
})
