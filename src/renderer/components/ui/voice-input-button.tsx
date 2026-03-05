import { useCallback } from 'react'
import { Button } from '@renderer/components/ui/button'
import { MiniWaveform } from '@renderer/components/ui/mini-waveform'
import { Loader2, Mic, MicOff, Square, X } from 'lucide-react'
import { useSettings } from '@renderer/hooks/use-settings'
import { useDialogs } from '@renderer/context/dialog-context'
import { isVoiceConfigured } from '@renderer/hooks/use-voice-input'
import type { useVoiceInput } from '@renderer/hooks/use-voice-input'

type VoiceInputSize = 'default' | 'sm'

const SIZE_CONFIG = {
  default: { button: 'h-[34px] w-[34px]', pill: 'h-[34px]', waveform: { width: 56, height: 18 } },
  sm: { button: 'h-8 w-8', pill: 'h-8', waveform: { width: 48, height: 16 } },
} as const

interface VoiceInputButtonProps {
  /** The return value of useVoiceInput(). Hook lives in the parent so it can call stopRecording on submit. */
  voiceInput: ReturnType<typeof useVoiceInput>
  /** Current text in the input — passed to startRecording as prefix. */
  message: string
  /** Disable the idle mic button (recording pill is always clickable). */
  disabled?: boolean
  /** Button sizing variant. */
  size?: VoiceInputSize
}

/**
 * Voice input mic button that transforms into a recording pill with live waveform.
 * Handles the settings check and toggle logic; parent owns the useVoiceInput hook.
 *
 * Returns null if voice input is not supported by the browser.
 */
export function VoiceInputButton({ voiceInput, message, disabled, size = 'default' }: VoiceInputButtonProps) {
  const { data: settingsData } = useSettings()
  const { openSettings } = useDialogs()
  const hasVoiceConfigured = isVoiceConfigured(settingsData)
  const config = SIZE_CONFIG[size]

  const { isRecording, isConnecting, stopRecording, startRecording } = voiceInput

  const handleToggle = useCallback(() => {
    if (!hasVoiceConfigured) {
      openSettings('voice')
      return
    }
    if (isRecording || isConnecting) {
      stopRecording()
    } else {
      startRecording(message)
    }
  }, [hasVoiceConfigured, openSettings, isRecording, isConnecting, stopRecording, startRecording, message])

  if (!voiceInput.isSupported) return null

  return isRecording ? (
    <button
      type="button"
      onClick={handleToggle}
      className={`flex items-center gap-1.5 ${config.pill} px-2 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors`}
      title="Stop recording"
    >
      <Square className="h-3 w-3 fill-current" />
      <MiniWaveform analyserRef={voiceInput.analyserRef} {...config.waveform} />
    </button>
  ) : (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className={config.button}
      onClick={handleToggle}
      disabled={disabled}
      title={!hasVoiceConfigured ? 'Set up voice input' : 'Voice input'}
    >
      {isConnecting ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Mic className="h-4 w-4" />
      )}
    </Button>
  )
}

/** Inline error display for voice input errors. */
export function VoiceInputError({ error, onDismiss, className }: { error: string | null; onDismiss?: () => void; className?: string }) {
  if (!error) return null
  return (
    <div className={`flex items-center gap-1.5 text-xs text-destructive ${className ?? ''}`}>
      <MicOff className="h-3 w-3 shrink-0" />
      <span>{error}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="ml-auto shrink-0 hover:opacity-70" aria-label="Dismiss">
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}
