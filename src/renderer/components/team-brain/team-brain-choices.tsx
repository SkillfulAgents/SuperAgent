import { useEffect, useRef, useState } from 'react'
import { CalendarDays, Clock, Sunrise, type LucideIcon } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { TEAM_BRAIN_SCHEDULES, type TeamBrainLocationId, type TeamBrainSchedule } from '@renderer/lib/team-brain/team-brain-schema'
import { SCHEDULE_LABELS } from '@renderer/lib/team-brain/team-brain-format'
import { TEAM_BRAIN_LOCATIONS, teamBrainLocation, type TeamBrainLocation } from './team-brain-locations'

/**
 * The two rigid set-up questions, where Team Brain lives and how often it
 * syncs, as choice cards. Both set-up modals ask them; the agent-led one
 * offers fewer homes.
 */

/** Mock timing for a storage choice that has to connect first. Short enough to watch, long enough to read. */
const CONNECT_MS = 700

export const SECTION_LABEL = 'text-[14px] text-foreground'
/** A choice card: hairline border, brand border when chosen. */
export const CHOICE =
  'relative rounded-lg border bg-background text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'
export const CHOICE_ON = 'border-brand ring-1 ring-brand'
export const CHOICE_OFF = 'hover:border-foreground/25'

const SCHEDULE_ICONS: Record<TeamBrainSchedule, LucideIcon> = {
  hourly: Clock,
  daily: Sunrise,
  weekly: CalendarDays,
}

/** The trade-off each schedule makes, out of three: fresher context costs more syncs. */
const SCHEDULE_TRADEOFF: Record<TeamBrainSchedule, { freshness: number; cost: number }> = {
  hourly: { freshness: 3, cost: 3 },
  daily: { freshness: 2, cost: 2 },
  weekly: { freshness: 1, cost: 1 },
}

function Meter({ label, level }: { label: string; level: number }) {
  return (
    <span className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
      {label}
      <span className="flex gap-0.5" aria-label={`${level} of 3`}>
        {[1, 2, 3].map((n) => (
          <span key={n} className={cn('h-1.5 w-3 rounded-full', n <= level ? 'bg-foreground/60' : 'bg-foreground/10')} />
        ))}
      </span>
    </span>
  )
}

/** A radio dot: an empty ring, or a brand ring with a dot when chosen. */
export function RadioDot({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-[18px] shrink-0 place-items-center rounded-full border-[1.5px] bg-background',
        checked ? 'border-brand' : 'border-foreground/30',
      )}
    >
      {checked && <span className="size-2.5 rounded-full bg-brand" />}
    </span>
  )
}

export function Spinner() {
  return <span aria-hidden="true" className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-foreground/15 border-t-foreground" />
}

export function Recommended() {
  return <span className="shrink-0 rounded-[5px] bg-brand/10 px-1.5 py-0.5 text-[11px] font-medium text-brand">Recommended</span>
}

/**
 * Where Team Brain lives: Gamut-hosted on top, then the storage it can use,
 * or just the homes in `only`, in that order. A storage choice connects first
 * (a beat in the mock); `onChoose` fires once it has, and `onPendingChange`
 * reports the wait.
 */
export function LocationChoices({
  value,
  onChoose,
  onPendingChange,
  disabled,
  only,
}: {
  value: TeamBrainLocationId | null
  onChoose: (id: TeamBrainLocationId) => void
  onPendingChange?: (pending: boolean) => void
  disabled?: boolean
  only?: readonly TeamBrainLocationId[]
}) {
  const [pending, setPending] = useState<TeamBrainLocationId | null>(null)
  const [connected, setConnected] = useState<Set<TeamBrainLocationId>>(() => new Set(value ? [value] : []))
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])

  const choose = (location: TeamBrainLocation) => {
    if (disabled || pending || !location.isAvailable()) return
    if (location.connects && !connected.has(location.id)) {
      // The real flow opens the drive's own sign-in or key form; the mock takes a beat.
      setPending(location.id)
      onPendingChange?.(true)
      timer.current = setTimeout(() => {
        setPending(null)
        onPendingChange?.(false)
        setConnected((prev) => new Set(prev).add(location.id))
        onChoose(location.id)
      }, CONNECT_MS)
      return
    }
    onChoose(location.id)
  }

  const hosted = only ? [] : TEAM_BRAIN_LOCATIONS.filter((l) => l.group === 'hosted')
  const storage = only ? only.map(teamBrainLocation) : TEAM_BRAIN_LOCATIONS.filter((l) => l.group === 'storage')
  const selected = value ? teamBrainLocation(value) : null

  return (
    <>
      {hosted.length > 0 && <p className={SECTION_LABEL}>Hosted</p>}
      <div role="radiogroup" aria-label="Hosted" className="mt-2">
        {hosted.map((location) => {
          const Icon = location.Icon
          const on = value === location.id
          return (
            <button
              key={location.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled && !on}
              onClick={() => choose(location)}
              data-testid={`team-brain-location-${location.id}`}
              className={cn(CHOICE, on ? CHOICE_ON : CHOICE_OFF, 'flex min-h-[48px] w-full items-center gap-3 px-4 py-3')}
            >
              <Icon className="size-6 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-[14px] font-medium">
                  {location.name}
                  <Recommended />
                </span>
                <span className="mt-0.5 block text-[13px] text-muted-foreground">{location.description}</span>
              </span>
              <RadioDot checked={on} />
            </button>
          )
        })}
      </div>

      {hosted.length > 0 && <p className={cn(SECTION_LABEL, 'mt-7')}>Your storage</p>}
      <div
        role="radiogroup"
        aria-label={hosted.length > 0 ? 'Your storage' : 'Where it lives'}
        className={cn('grid grid-cols-2 gap-3', hosted.length > 0 && 'mt-2 sm:grid-cols-3')}
      >
        {storage.map((location) => {
          const Icon = location.Icon
          const on = value === location.id
          const available = location.isAvailable()
          return (
            <button
              key={location.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!available || (disabled && !on)}
              title={available ? location.description : location.unavailableReason}
              onClick={() => choose(location)}
              data-testid={`team-brain-location-${location.id}`}
              className={cn(CHOICE, on ? CHOICE_ON : CHOICE_OFF, 'flex min-h-[92px] flex-col justify-between gap-3 p-4')}
            >
              <span className="flex w-full items-start justify-between">
                <Icon className="size-6" />
                {pending === location.id ? <Spinner /> : <RadioDot checked={on} />}
              </span>
              <span className="block text-[14px]/5 font-medium">
                {location.name}
                {!available && <span className="block text-[12px] font-normal text-muted-foreground">Desktop app only</span>}
                {pending === location.id && <span className="block text-[12px] font-normal text-muted-foreground">Connecting</span>}
              </span>
            </button>
          )
        })}
      </div>

      {selected && selected.group === 'storage' && storage.includes(selected) && (
        <p className="mt-4 text-[13px] text-muted-foreground" data-testid="team-brain-location-detail">
          Creates <span className="whitespace-nowrap font-mono text-[12px] text-foreground/80">{selected.target}</span>
        </p>
      )}
    </>
  )
}

/** How often Team Brain checks its sources: hourly, nightly (recommended) or weekly. */
export function ScheduleChoices({
  value,
  onChoose,
  disabled,
}: {
  value: TeamBrainSchedule | null
  onChoose: (schedule: TeamBrainSchedule) => void
  disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label="Schedule" className="grid grid-cols-3 gap-3">
      {TEAM_BRAIN_SCHEDULES.map((option) => {
        const Icon = SCHEDULE_ICONS[option]
        const on = option === value
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled && !on}
            onClick={() => !disabled && onChoose(option)}
            data-testid={`team-brain-schedule-${option}`}
            className={cn(CHOICE, on ? CHOICE_ON : CHOICE_OFF, 'flex flex-col gap-5 px-3 py-5')}
          >
            <span className="flex w-full items-start justify-between">
              <Icon className="size-6 text-muted-foreground/70" strokeWidth={1.5} />
              <RadioDot checked={on} />
            </span>
            <span>
              <span className="flex flex-wrap items-center gap-1 text-[14px] font-medium">
                {SCHEDULE_LABELS[option].title}
                {option === 'daily' && <Recommended />}
              </span>
              <span className="mt-1.5 line-clamp-3 text-[12px]/4 text-muted-foreground">{SCHEDULE_LABELS[option].detail}</span>
            </span>
            <span className="mt-auto block w-full space-y-2 border-t pt-3.5">
              <Meter label="Freshness" level={SCHEDULE_TRADEOFF[option].freshness} />
              <Meter label="Cost" level={SCHEDULE_TRADEOFF[option].cost} />
            </span>
          </button>
        )
      })}
    </div>
  )
}
