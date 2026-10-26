import { useSyncExternalStore } from 'react'
import { Check, FlaskConical } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import type { ApiScheduledTask } from '@renderer/hooks/use-scheduled-tasks'
import type { TeamBrainSync } from '@renderer/lib/team-brain/team-brain-syncs'

/**
 * Dev builds only: the Team Brain home page's states, each one a click away, so the page can be looked at in all of
 * them without breaking a drive or waiting for a sync. Every group starts live (what the page really reads); a pick
 * stands in for that part of the page until it is set back or the app reloads. Held in memory, nothing stored.
 */
export const DEV_STATES_ENABLED = import.meta.env.DEV

export interface TeamBrainDevStates {
  drive: 'live' | 'loading' | 'unreadable' | 'partial' | 'none' | 'empty'
  upkeep: 'live' | 'none' | 'active' | 'paused'
  syncs: 'live' | 'none' | 'unreadable' | 'sample'
}

const LIVE: TeamBrainDevStates = { drive: 'live', upkeep: 'live', syncs: 'live' }
let states = LIVE
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function setDevState(patch: Partial<TeamBrainDevStates>) {
  states = { ...states, ...patch }
  listeners.forEach((listener) => listener())
}

/** The states picked in the dev menu; always live outside dev builds. */
export function useTeamBrainDevStates(): TeamBrainDevStates {
  const picked = useSyncExternalStore(subscribe, () => states)
  return DEV_STATES_ENABLED ? picked : LIVE
}

/** Reading the drive as the dev menu has it: still listing, unreadable whole or in part, or listed and empty. */
export function devDrive<Drive extends readonly unknown[]>(state: TeamBrainDevStates['drive'], live: { drive: Drive; ready: boolean; error: string | null }) {
  switch (state) {
    case 'loading':
      return { drive: [] as unknown as Drive, ready: false, error: null }
    case 'unreadable':
      return { drive: [] as unknown as Drive, ready: false, error: 'The drive is not available.' }
    case 'partial':
      return { ...live, ready: true, error: 'signal timed out' }
    case 'empty':
      return { drive: [] as unknown as Drive, ready: true, error: null }
    default:
      return live
  }
}

const HOUR = 3_600_000

/** The upkeep task as the dev menu has it: none yet, or a daily one active or paused. */
export function devUpkeep(state: TeamBrainDevStates['upkeep'], live: ApiScheduledTask | undefined): ApiScheduledTask | undefined {
  if (state === 'live') return live
  if (state === 'none') return undefined
  const now = Date.now()
  // Only what the page reads is real; the rest of a task's fields keep the live task's, or none.
  const task = {
    ...live,
    id: live?.id ?? 'dev-brain-upkeep',
    name: 'Brain upkeep',
    scheduleType: 'cron',
    scheduleExpression: '0 0 * * *',
    nextExecutionAt: new Date(now + 22 * HOUR),
    lastExecutedAt: new Date(now - 2 * HOUR),
    status: state === 'paused' ? 'paused' : 'pending',
  } as ApiScheduledTask
  return task
}

/** A few syncs' summaries as an upkeep run writes them, for the sample state. */
function sampleSyncs(): TeamBrainSync[] {
  const at = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString()
  return [
    {
      id: '_brain/syncs/dev-3.md',
      at: at(2),
      session: null,
      sources: ['slack', 'notion', 'gmail', 'linear'],
      added: 3,
      updated: 9,
      highlights: [
        { title: 'Acme’s renewal moves to Q1', body: 'Acme asked in #sales to push their renewal to Q1 while their budget resets. [Acme Corp](../../customers/acme.md) has the new date and the two people who sign off.' },
        { title: 'The Team Brain launch has a plan', body: 'Marketing’s launch brief landed in Notion. [Team Brain launch](../../marketing/team-brain-launch.md) has the date and the three messages to lead with.' },
      ],
      changes: ['Cycle 14 closed in Linear; [Roadmap](../../product/roadmap.md) marks two projects shipped.', 'Four new bugs went into [Bugs and triage](../../engineering/bugs-and-triage.md).'],
      needsYou: { blocked: ['Gmail asked to be reconnected, so threads after Tuesday were skipped.'], toDecide: ['Initech and Initech Ltd look like one customer. Filed both under [Initech](../../customers/initech.md) for now.'] },
    },
    {
      id: '_brain/syncs/dev-2.md',
      at: at(26),
      session: null,
      sources: ['confluence', 'slack'],
      added: 2,
      updated: 6,
      highlights: [{ title: 'On-call has a runbook', body: 'The Ops space’s on-call guide came over from Confluence as [On-call](../../engineering/on-call.md), with the escalation path.' }],
      changes: ['Three more customers asked for SSO; [Feedback themes](../../product/feedback-themes.md) now puts it first.'],
      needsYou: { blocked: [], toDecide: [] },
    },
  ]
}

/** The sync summaries as the dev menu has them: none yet, unreadable, or a sample of two. */
export function devSyncs(state: TeamBrainDevStates['syncs'], live: { syncs: TeamBrainSync[]; unreadable: boolean }) {
  switch (state) {
    case 'none':
      return { syncs: [], unreadable: false }
    case 'unreadable':
      return { syncs: [], unreadable: true }
    case 'sample':
      return { syncs: sampleSyncs(), unreadable: false }
    default:
      return live
  }
}

const GROUPS: { key: keyof TeamBrainDevStates; label: string; options: { value: string; label: string }[] }[] = [
  {
    key: 'drive',
    label: 'Drive',
    options: [
      { value: 'live', label: 'Live' },
      { value: 'loading', label: 'Loading' },
      { value: 'unreadable', label: 'Unreadable' },
      { value: 'partial', label: 'Part unreadable' },
      { value: 'none', label: 'No drive' },
      { value: 'empty', label: 'Empty' },
    ],
  },
  {
    key: 'upkeep',
    label: 'Upkeep',
    options: [
      { value: 'live', label: 'Live' },
      { value: 'none', label: 'Not scheduled' },
      { value: 'active', label: 'Active' },
      { value: 'paused', label: 'Paused' },
    ],
  },
  {
    key: 'syncs',
    label: 'Sync summaries',
    options: [
      { value: 'live', label: 'Live' },
      { value: 'none', label: 'None' },
      { value: 'unreadable', label: 'Unreadable' },
      { value: 'sample', label: 'Sample' },
    ],
  },
]

/** The dev menu itself, in the page's corner; a dot on it while anything is not live. */
export function TeamBrainDevStatesMenu({ className }: { className?: string }) {
  const picked = useTeamBrainDevStates()
  if (!DEV_STATES_ENABLED) return null
  const mocked = GROUPS.some((group) => picked[group.key] !== 'live')
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn('h-7 gap-1.5 border-dashed bg-background/80 px-2 text-[11px] text-muted-foreground backdrop-blur', className)}
          data-drawer-opener
          data-testid="team-brain-dev-states"
        >
          <FlaskConical className="h-3.5 w-3.5" />
          Dev states
          {mocked && <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-label="Mocked" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-64 space-y-3 p-3">
        {GROUPS.map((group) => (
          <div key={group.key} role="radiogroup" aria-label={group.label}>
            <p className="mb-1 px-1 text-[11px] text-muted-foreground">{group.label}</p>
            <div className="grid grid-cols-2 gap-0.5">
              {group.options.map((option) => {
                const on = picked[group.key] === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setDevState({ [group.key]: option.value } as Partial<TeamBrainDevStates>)}
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
        <button type="button" onClick={() => setDevState(LIVE)} className="w-full rounded-sm px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent">
          Back to live
        </button>
      </PopoverContent>
    </Popover>
  )
}
