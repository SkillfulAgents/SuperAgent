import { useCallback } from 'react'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { MiniWaveform } from '@renderer/components/ui/mini-waveform'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Loader2, Mic, MicOff, Square, X } from 'lucide-react'
import { useDialogs } from '@renderer/context/dialog-context'
import { useUser } from '@renderer/context/user-context'
import { useIsVoiceConfigured } from '@renderer/hooks/use-voice-input'
import { cn } from '@shared/lib/utils'
import type { useVoiceInput } from '@renderer/hooks/use-voice-input'

type VoiceInputSize = 'default' | 'sm'

const SIZE_CONFIG = {
  default: { button: 'h-[34px] w-[34px]', pill: 'h-[34px] w-[102px]', waveform: { width: 56, height: 18 } },
  sm: { button: 'h-8 w-8', pill: 'h-8 w-[92px]', waveform: { width: 48, height: 16 } },
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
  const { openSettings } = useDialogs()
  const { isAuthMode, isAdmin } = useUser()
  const hasVoiceConfigured = useIsVoiceConfigured()
  const config = SIZE_CONFIG[size]

  // In auth mode, only admins can configure voice settings
  const canConfigureVoice = !isAuthMode || isAdmin

  const { isRecording, isConnecting, stopRecording, startRecording } = voiceInput

  const handleToggle = useCallback(() => {
    if (!hasVoiceConfigured) {
      if (canConfigureVoice) openSettings('voice')
      return
    }
    if (isRecording || isConnecting) {
      stopRecording()
    } else {
      startRecording(message)
    }
  }, [hasVoiceConfigured, canConfigureVoice, openSettings, isRecording, isConnecting, stopRecording, startRecording, message])

  if (!voiceInput.isSupported) return null

  // Non-admin in auth mode without voice configured: show disabled mic-off with tooltip
  if (!hasVoiceConfigured && !canConfigureVoice) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className={config.button}
                disabled
              >
                <MicOff className="h-4 w-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <p>Voice input must be enabled by an admin</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={disabled && !isRecording && !isConnecting}
      className={cn(
        buttonVariants({ variant: 'outline', size: 'icon' }),
        'overflow-hidden px-0 transition-[width,padding,background-color,border-color,color,border-radius] duration-200 ease-out',
        isRecording || isConnecting
          ? `${config.pill} gap-2 justify-between rounded-md border-input bg-background px-2 text-foreground hover:bg-zinc-100`
          : `gap-0 rounded-md ${config.button}`
      )}
      title={
        isRecording || isConnecting
          ? 'Stop recording'
          : !hasVoiceConfigured
            ? 'Set up voice input'
            : 'Voice input'
      }
    >
      <span
        className={cn(
          'overflow-hidden transition-[max-width,opacity] duration-200 ease-out',
          isRecording || isConnecting ? 'max-w-[64px] opacity-100' : 'max-w-0 opacity-0'
        )}
      >
        <MiniWaveform analyserRef={voiceInput.analyserRef} color="black" {...config.waveform} />
      </span>
      {isConnecting ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
      ) : isRecording ? (
        <Square className="h-3 w-3 shrink-0 fill-current" />
      ) : (
        <Mic className="h-4 w-4 shrink-0" />
      )}
    </button>
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
