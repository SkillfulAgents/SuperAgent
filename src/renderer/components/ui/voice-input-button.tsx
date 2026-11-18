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

type VoiceInputSize = 'default' | 'sm' | 'compact' | 'xs'

const SIZE_CONFIG = {
  default: { button: 'h-[34px] w-[34px]', pill: 'h-[34px] w-[102px]', waveform: { width: 56, height: 18 } },
  sm: { button: 'h-8 w-8', pill: 'h-8 w-[92px]', waveform: { width: 48, height: 16 } },
  compact: { button: 'h-7 w-7', pill: 'h-7 w-[88px]', waveform: { width: 44, height: 14 } },
  xs: { button: 'h-6 w-6', pill: 'h-6 w-[84px]', waveform: { width: 40, height: 12 } },
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
  /** On a Liquid Glass surface (the quick-dispatch launcher): capsule shape, translucent idle fill. */
  glass?: boolean
}

// Idle mic on glass: a translucent fill with a lit top edge in place of the
// outline button's opaque tile. Overrides the outline variant's bg/border/shadow.
const GLASS_IDLE =
  'border-transparent bg-white/40 shadow-[inset_0_0.5px_0_0_rgb(255_255_255/0.8),0_0.5px_1.5px_rgb(0_0_0/0.12)] hover:bg-white/60 dark:bg-white/10 dark:shadow-[inset_0_0.5px_0_0_rgb(255_255_255/0.25)] dark:hover:bg-white/[0.16]'

/**
 * Voice input mic button that transforms into a recording pill with live waveform.
 * Handles the settings check and toggle logic; parent owns the useVoiceInput hook.
 *
 * Returns null if voice input is not supported by the browser.
 */
export function VoiceInputButton({ voiceInput, message, disabled, size = 'default', glass = false }: VoiceInputButtonProps) {
  const { openSettings } = useDialogs()
  const { isAuthMode, isAdmin } = useUser()
  const hasVoiceConfigured = useIsVoiceConfigured()
  const config = SIZE_CONFIG[size]

  // In auth mode, only admins can configure voice settings
  const canConfigureVoice = !isAuthMode || isAdmin

  const { isRecording, isConnecting, isFinalizing, stopRecording, startRecording } = voiceInput
  // Mic engaged: recording, connecting, or flushing the tail after stop.
  const active = isRecording || isConnecting || isFinalizing
  // Spinner while connecting or finalizing (no live waveform to show).
  const busy = isConnecting || isFinalizing

  const handleToggle = useCallback(() => {
    if (!hasVoiceConfigured) {
      if (canConfigureVoice) openSettings('voice')
      return
    }
    if (isRecording || isConnecting) {
      stopRecording()
    }
    // While finalizing we ignore clicks (stop already in progress); otherwise start.
    else if (!isFinalizing) {
      startRecording(message)
    }
  }, [hasVoiceConfigured, canConfigureVoice, openSettings, isRecording, isConnecting, isFinalizing, stopRecording, startRecording, message])

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
                className={cn(config.button, glass && 'rounded-full')}
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
      disabled={disabled && !active}
      data-testid="voice-input-button"
      // An outline button like the shared Button's, so surfaces that restyle those (Agent Home's glass) include it,
      // except while recording, when it is the tinted pill.
      data-variant="outline"
      data-active={active || undefined}
      className={cn(
        buttonVariants({ variant: 'outline', size: 'icon' }),
        'overflow-hidden px-0 transition-[width,padding,background-color,border-color,color,border-radius] duration-200 ease-out',
        active
          ? `${config.pill} gap-2 justify-between border-primary/30 bg-primary/10 px-2 text-foreground hover:bg-primary/15 dark:border-primary/40 dark:bg-primary/15 dark:hover:bg-primary/20`
          : `gap-0 ${config.button}`,
        glass && 'rounded-full',
        glass && !active && GLASS_IDLE,
      )}
      aria-label={active ? 'Stop recording' : !hasVoiceConfigured ? 'Set up voice input' : 'Voice input'}
      title={
        active
          ? 'Stop recording'
          : !hasVoiceConfigured
            ? 'Set up voice input'
            : 'Voice input'
      }
    >
      <span
        className={cn(
          'overflow-hidden transition-[max-width,opacity] duration-200 ease-out',
          active ? 'max-w-[64px] opacity-100' : 'max-w-0 opacity-0'
        )}
      >
        {/* Mounted only while engaged: its draw loop requests a frame every refresh for as long as it exists. */}
        {active && <MiniWaveform analyserRef={voiceInput.analyserRef} color="currentColor" {...config.waveform} />}
      </span>
      {busy ? (
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
