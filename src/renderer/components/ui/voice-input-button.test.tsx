// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VoiceInputButton } from './voice-input-button'

vi.mock('@renderer/context/dialog-context', () => ({
  useDialogs: () => ({ openSettings: vi.fn() }),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ isAuthMode: false, isAdmin: true }),
}))

vi.mock('@renderer/hooks/use-voice-input', () => ({
  useIsVoiceConfigured: () => true,
}))

vi.mock('@renderer/components/ui/mini-waveform', () => ({
  MiniWaveform: ({ color }: { color: string }) => <div data-testid="mini-waveform" data-color={color} />,
}))

describe('VoiceInputButton', () => {
  it('uses theme-aware active styling and keeps the stop control visible', () => {
    render(
      <VoiceInputButton
        message=""
        voiceInput={{
          state: 'recording',
          isRecording: true,
          isConnecting: false,
          isFinalizing: false,
          error: null,
          clearError: vi.fn(),
          isSupported: true,
          analyserRef: { current: null },
          startRecording: vi.fn(),
          stopRecording: vi.fn(),
        }}
      />,
    )

    const button = screen.getByTestId('voice-input-button')
    expect(button).toHaveAccessibleName('Stop recording')
    expect(button).toHaveClass('bg-primary/10', 'text-foreground', 'dark:bg-primary/15')
    expect(button).not.toHaveClass('bg-background', 'hover:bg-zinc-100')
    expect(screen.getByTestId('mini-waveform')).toHaveAttribute('data-color', 'currentColor')
  })
})
