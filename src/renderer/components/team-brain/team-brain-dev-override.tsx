import { useSyncExternalStore } from 'react'
import { Check, FlaskConical } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'

/**
 * Dev builds only: which set-up this window gets and what the desktop finds in the cloud, so connecting to the cloud's
 * Team Brain can be tried without a cloud workspace that has one, and from a browser. Every pick starts live; one
 * stands in until it is set back or the app reloads. Held in memory, nothing stored.
 */
export const DEV_OVERRIDE_ENABLED = import.meta.env.DEV

export interface TeamBrainDevOverride {
  /** The desktop's set-up (connect, or set one up here), or only setting one up here. */
  window: 'live' | 'desktop' | 'setup'
  /** What the desktop finds when it looks for the cloud's Team Brain. */
  cloud: 'live' | 'signed-out' | 'no-workspace' | 'asleep' | 'unreachable' | 'no-brain' | 'found'
}

const LIVE: TeamBrainDevOverride = { window: 'live', cloud: 'live' }
let picked = LIVE
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function pick(changes: Partial<TeamBrainDevOverride>) {
  picked = { ...picked, ...changes }
  listeners.forEach((listener) => listener())
}

/** What the dev menu stands in; always live outside dev builds. */
export function useTeamBrainDevOverride(): TeamBrainDevOverride {
  const current = useSyncExternalStore(subscribe, () => picked)
  return DEV_OVERRIDE_ENABLED ? current : LIVE
}

const GROUPS: { key: keyof TeamBrainDevOverride; label: string; options: { value: string; label: string }[] }[] = [
  {
    key: 'window',
    label: 'Window',
    options: [
      { value: 'live', label: 'Live' },
      { value: 'desktop', label: 'Desktop' },
      { value: 'setup', label: 'Set up here' },
    ],
  },
  {
    key: 'cloud',
    label: 'Cloud Team Brain (desktop)',
    options: [
      { value: 'live', label: 'Live' },
      { value: 'signed-out', label: 'Signed out' },
      { value: 'no-workspace', label: 'No workspace' },
      { value: 'asleep', label: 'Asleep' },
      { value: 'unreachable', label: 'Unreachable' },
      { value: 'no-brain', label: 'No Team Brain' },
      { value: 'found', label: 'Found' },
    ],
  },
]

/** The dev menu, in the pitch's corner; a dot on it while anything is not live. */
export function TeamBrainDevOverrideMenu({ className }: { className?: string }) {
  const current = useTeamBrainDevOverride()
  if (!DEV_OVERRIDE_ENABLED) return null
  const overridden = GROUPS.some((group) => current[group.key] !== 'live')
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn('h-7 gap-1.5 border-dashed bg-background/80 px-2 text-[11px] text-muted-foreground backdrop-blur', className)}
          data-testid="team-brain-dev-override"
        >
          <FlaskConical className="h-3.5 w-3.5" />
          Desktop set-up
          {overridden && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-label="Overridden" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-64 space-y-3 p-3">
        {GROUPS.map((group) => (
          <div key={group.key} role="radiogroup" aria-label={group.label}>
            <p className="mb-1 px-1 text-[11px] text-muted-foreground">{group.label}</p>
            <div className="grid grid-cols-2 gap-0.5">
              {group.options.map((option) => {
                const on = current[group.key] === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => pick({ [group.key]: option.value } as Partial<TeamBrainDevOverride>)}
                    className={cn(
                      'flex items-center justify-between gap-1 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent',
                      on ? 'text-foreground' : 'text-muted-foreground',
                    )}
                    data-testid={`team-brain-dev-${group.key}-${option.value}`}
                  >
                    {option.label}
                    {on && <Check className="h-3 w-3 shrink-0" aria-hidden="true" />}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
        <button type="button" onClick={() => pick(LIVE)} className="w-full rounded-sm px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent">
          Back to live
        </button>
      </PopoverContent>
    </Popover>
  )
}
