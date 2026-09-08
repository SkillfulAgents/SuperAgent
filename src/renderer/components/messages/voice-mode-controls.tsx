import { AudioLines, AudioLinesOff } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { ReadAloudSpeedSelect } from './read-aloud-controls'
import { useUpdateUserSettings, useUserSettings } from '@renderer/hooks/use-user-settings'
import { resolveHoldSound } from '@shared/lib/voice/tts-preferences'
import { cn } from '@shared/lib/utils/cn'

/** The person's own hold-sound preference, as voice mode applies it. */
export function useHoldSoundPreference(): boolean {
  const { data: userSettings } = useUserSettings()
  return resolveHoldSound(userSettings?.voice?.holdSound)
}

/**
 * The controls under the mic that are voice mode's own: the reading speed
 * and the hold sound, both written to the person's settings so they hold
 * across sessions.
 */
export function VoiceModeControls() {
  const holdSound = useHoldSoundPreference()
  const updateUserSettings = useUpdateUserSettings()
  const label = holdSound ? 'Hold sound on' : 'Hold sound off'

  return (
    <TooltipProvider>
      <div className="flex items-center gap-0.5" data-testid="voice-mode-controls">
        <ReadAloudSpeedSelect testId="voice-mode-speed" align="center" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-pressed={holdSound}
              aria-label={label}
              data-testid="voice-mode-hold-sound"
              // From the settings as they are when the write runs, not as
              // shown: two quick clicks toggle twice rather than cancel out.
              onClick={() => updateUserSettings.mutate((current) => ({ voice: { holdSound: !resolveHoldSound(current.voice?.holdSound) } }))}
              className={cn(
                'inline-flex h-6 w-6 items-center justify-center rounded transition-colors',
                'hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.1]',
                holdSound ? 'text-muted-foreground' : 'text-muted-foreground/50',
              )}
            >
              {holdSound ? <AudioLines className="h-3.5 w-3.5" /> : <AudioLinesOff className="h-3.5 w-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {holdSound ? 'Hold sound while the agent works. Click to mute.' : 'Hold sound muted. Click to play it while the agent works.'}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}
