import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { ArrowUpRight, Brain, Cloud, CloudOff, FileText, Laptop, Loader2 } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { useDialogs } from '@renderer/context/dialog-context'
import { useListedAgents } from '@renderer/hooks/use-agents'
import type { CloudTeamBrainLookup } from '@renderer/hooks/use-cloud-team-brain'
import { useTargetSwitch } from '@renderer/hooks/use-target-switch'
import { openExternalUrl } from '@renderer/lib/open-external'
import { useCloudConnection, type CloudTeamBrain } from '@renderer/lib/team-brain/team-brain-cloud'
import { formatSince, SCHEDULE_LABELS } from '@renderer/lib/team-brain/team-brain-format'
import type { TeamBrainPath } from '@renderer/lib/team-brain/team-brain-schema'
import { teamBrainSource } from '@renderer/lib/team-brain/team-brain-sources'
import { usesTeamBrain, type TeamBrainStore } from '@renderer/lib/team-brain/team-brain-store'
import { AgentAccessList, EveryAgentRow } from './team-brain-agent-access'
import { CHOICE, CHOICE_OFF, CHOICE_ON, RadioDot, Recommended } from './team-brain-choices'
import { volumeSetupRegistry } from '@renderer/components/volumes/volume-setup-registry'
import { teamBrainLocation } from './team-brain-locations'
import { StepPanel } from './team-brain-modal'
import { TeamBrainSourceIcon } from './team-brain-source-icon'

/**
 * Set-up's desktop steps (team-brain-cloud.ts): how to get Team Brain, and, connecting to the cloud's, which agents
 * here read it. Setting one up here goes on to set-up's own steps instead.
 */

type Lookup = CloudTeamBrainLookup & { checkAgain: () => void }

// ── 01 How ───────────────────────────────────────────────────────────────────

/**
 * Connect to the Team Brain the organization's cloud workspace has, read-only, or set one up on this computer,
 * independent of it. The cloud's card shows what it found, or what is in the way and how to clear it; it can only be
 * chosen once there is a Team Brain to connect to, and is then chosen to begin with (`path`).
 */
export function HowStep({
  lookup,
  path,
  onChoose,
  onLeave,
  next,
}: {
  lookup: Lookup
  /** Chosen, or preselected. */
  path: TeamBrainPath | null
  onChoose: (path: TeamBrainPath) => void
  /** Leave set-up, as closing it does: signing in to Gamut happens in its account settings, in place of set-up. */
  onLeave: () => void
  next: { label: string; onClick: () => void }
}) {
  const found = lookup.state === 'found'
  const cloud = path === 'cloud'
  const here = path === 'here'
  return (
    <StepPanel
      title="How do you want to use Team Brain?"
      subtitle="Your team’s Team Brain is set up once, in your organization’s cloud workspace. You can read it here, or set up one of your own on this computer."
      next={{ label: next.label, onClick: next.onClick, disabled: !path }}
    >
      <div role="radiogroup" aria-label="How to use Team Brain" className="space-y-3">
        <div className={cn(CHOICE, 'overflow-hidden', cloud ? CHOICE_ON : found && CHOICE_OFF)} data-testid="team-brain-how-cloud-card">
          <button
            type="button"
            role="radio"
            aria-checked={cloud}
            disabled={!found}
            onClick={() => onChoose('cloud')}
            className="flex w-full items-center gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed [&:disabled>*]:opacity-60"
            data-testid="team-brain-how-cloud"
          >
            <Cloud className="size-6 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-[14px] font-medium">
                Your team’s Team Brain
                {found && <Recommended />}
              </span>
              <span className="mt-0.5 block text-[13px] text-muted-foreground">
                Read it from your cloud workspace, which keeps it up to date. Agents here can’t change it.
              </span>
            </span>
            <RadioDot checked={cloud} />
          </button>
          <div className="border-t">{found ? <CloudFacts brain={lookup.brain} /> : <LookupRow lookup={lookup} onLeave={onLeave} />}</div>
        </div>

        <button
          type="button"
          role="radio"
          aria-checked={here}
          onClick={() => onChoose('here')}
          className={cn(CHOICE, here ? CHOICE_ON : CHOICE_OFF, 'flex w-full items-center gap-3 px-4 py-3')}
          data-testid="team-brain-how-here"
        >
          <Laptop className="size-6 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium">A Team Brain on this computer</span>
            <span className="mt-0.5 block text-[13px] text-muted-foreground">
              Set up your own, kept and synced here. Only agents on this computer use it.
            </span>
          </span>
          <RadioDot checked={here} />
        </button>
      </div>
    </StepPanel>
  )
}

/** "Slack, Notion and Gmail". */
function namesOf(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The Team Brain it found: which workspace, where it keeps its pages, how many and how fresh, and what it reads. */
function CloudFacts({ brain }: { brain: CloudTeamBrain }) {
  const location = teamBrainLocation(brain.location)
  const LocationIcon = location.Icon
  return (
    <dl className="divide-y text-[13px]" data-testid="team-brain-how-found">
      <FactRow icon={<Brain className="size-4 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />} label="In">
        <span data-testid="team-brain-how-workspace">{brain.workspace}</span>
      </FactRow>
      <FactRow icon={<LocationIcon className="size-4" />} label="Kept in">
        {location.name} · {brain.place}
      </FactRow>
      <FactRow icon={<FileText className="size-4 text-muted-foreground" aria-hidden="true" />} label="Holds">
        {brain.pages.toLocaleString()} pages · synced {formatSince(brain.lastSyncAt)}, {SCHEDULE_LABELS[brain.schedule].title.toLowerCase()}
      </FactRow>
      <FactRow
        icon={
          <span className="flex -space-x-1" aria-hidden="true">
            {brain.sources.slice(0, 3).map((id) => (
              <span key={id} className="grid size-4 place-items-center rounded-full bg-background ring-1 ring-background">
                <TeamBrainSourceIcon id={id} className="size-3" />
              </span>
            ))}
          </span>
        }
        label="Reads"
      >
        {namesOf(brain.sources.map((id) => teamBrainSource(id).name))}
      </FactRow>
    </dl>
  )
}

function FactRow({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2">
      {/* As wide as the card's own icon above, so the rows line up under its title. */}
      <span className="flex w-6 shrink-0 justify-center">{icon}</span>
      <dt className="w-14 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 truncate">{children}</dd>
    </div>
  )
}

/** A step of the way that isn't there yet, and what to do about it. */
interface LookupRowContent {
  Icon: ComponentType<{ className?: string }>
  title: string
  detail: string
  /** The coloured actions on the right, as set-up's rows have them. */
  actions?: { label: string; onClick: () => void; external?: boolean; testId: string }[]
  busy?: boolean
}

const NOT_RUNNING_COPY: Record<'starting' | 'asleep' | 'error', Pick<LookupRowContent, 'title' | 'detail'>> = {
  starting: { title: 'Your cloud workspace is setting up', detail: 'This takes about a minute. Check again when it’s ready.' },
  asleep: { title: 'Your cloud workspace is asleep', detail: 'Wake it on Gamut. It takes about a minute, then check again.' },
  error: { title: 'Your cloud workspace ran into a problem', detail: 'See what went wrong on Gamut, then check again.' },
}

/** Where looking for it stopped: not signed in, no workspace, a workspace not running or out of reach, or no Team Brain in it. */
function LookupRow({ lookup, onLeave }: { lookup: Exclude<CloudTeamBrainLookup, { state: 'found' }> & { checkAgain: () => void }; onLeave: () => void }) {
  const { openSettings } = useDialogs()
  const target = useTargetSwitch()
  const gamut = (page: string | null) => (page ? [{ label: 'Gamut', onClick: () => void openExternalUrl(page), external: true, testId: 'team-brain-how-gamut' }] : [])
  const checkAgain = { label: 'Check again', onClick: lookup.checkAgain, testId: 'team-brain-how-check-again' }
  const content = ((): LookupRowContent => {
    switch (lookup.state) {
      case 'checking':
        return { Icon: Cloud, title: 'Looking for your cloud workspace', detail: 'Asking Gamut where your organization’s Team Brain is.', busy: true }
      case 'signed-out':
        return {
          Icon: volumeSetupRegistry.platform.Logo,
          title: 'Connect your Gamut account',
          detail: 'It’s how this computer finds your organization’s cloud workspace.',
          actions: [{ label: 'Connect', onClick: () => { onLeave(); openSettings('platform') }, testId: 'team-brain-how-sign-in' }],
        }
      case 'no-workspace':
        return {
          Icon: Cloud,
          title: 'Your organization has no cloud workspace yet',
          detail: 'Set one up on Gamut, then check again.',
          actions: [...gamut(lookup.platformPage), checkAgain],
        }
      case 'not-running':
        return { Icon: Cloud, ...NOT_RUNNING_COPY[lookup.status], actions: [...gamut(lookup.platformPage), checkAgain] }
      case 'unreachable':
        return { Icon: CloudOff, title: 'Couldn’t reach your cloud workspace', detail: 'Check your connection, then try again.', actions: [{ ...checkAgain, label: 'Try again' }] }
      case 'no-brain':
        return {
          Icon: Brain,
          title: 'Your cloud workspace has no Team Brain yet',
          detail: 'Switch to Cloud to set it up for everyone, or ask an admin to.',
          actions: [{ label: target.switching ? 'Switching…' : 'Switch to Cloud', onClick: () => void target.switchTo('cloud'), testId: 'team-brain-how-switch' }],
        }
    }
  })()
  const { Icon } = content
  return (
    <div className="flex items-center gap-3 bg-muted/40 px-4 py-3" data-testid="team-brain-how-lookup" data-state={lookup.state}>
      <span className="flex w-6 shrink-0 justify-center">
        {content.busy ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" /> : <Icon className="size-4 text-muted-foreground" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{content.title}</span>
        <span className="block text-[12px] text-muted-foreground">{content.detail}</span>
      </span>
      {content.actions && (
        <span className="flex shrink-0 items-center gap-3">
          {content.actions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              disabled={target.switching}
              className="inline-flex items-center gap-0.5 rounded-sm text-[13px] font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              data-testid={action.testId}
            >
              {action.label}
              {action.external && <ArrowUpRight className="size-3.5" aria-hidden="true" />}
            </button>
          ))}
        </span>
      )}
    </div>
  )
}

// ── 02 Its agents, connecting ────────────────────────────────────────────────

/** How long the stand-in connection takes, so Connect reads as doing something. */
const CONNECT_MS = 700

/**
 * Which agents here read the cloud's Team Brain: every agent, including ones made later, or each switched on below.
 * Connect finishes set-up; the page then shows the connected Team Brain's read-only home.
 */
export function ReadersStep({ tb, brain, onBack }: { tb: TeamBrainStore; brain: CloudTeamBrain; onBack: () => void }) {
  const cloud = useCloudConnection()
  const { data: agents = [] } = useListedAgents()
  const [connecting, setConnecting] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const connect = () => {
    setConnecting(true)
    setTimeout(() => {
      // Closed meanwhile: nothing connects.
      if (!mounted.current) return
      cloud.connect(brain, { agents: tb.state.agents, everyAgent: tb.state.everyAgent })
      tb.cancelSetup()
    }, CONNECT_MS)
  }
  return (
    <StepPanel
      title="Choose which agents read Team Brain"
      subtitle="They read your team’s context as they work, from their next start. It stays read only here: Team Brain keeps it up to date in your cloud workspace. You can change this later."
      back={connecting ? undefined : onBack}
      next={{
        label: connecting ? <><Loader2 className="size-3.5 animate-spin" aria-hidden="true" />Connecting</> : 'Connect',
        onClick: connect,
        disabled: connecting,
        testId: 'team-brain-connect-confirm',
      }}
    >
      <EveryAgentRow checked={tb.state.everyAgent} canGoGlobal onCheckedChange={tb.setEveryAgent} className="pb-3" />
      {agents.length > 0 ? (
        <AgentAccessList
          agents={agents}
          everyAgent={tb.state.everyAgent}
          isOn={(slug) => usesTeamBrain(tb.state, slug)}
          onToggle={tb.setUsesTeamBrain}
          className={cn('border-y', connecting && 'pointer-events-none opacity-60')}
        />
      ) : (
        <p className="text-[13px] text-muted-foreground">No agents on this computer yet. With Every agent on, the ones you make later read it too.</p>
      )}
    </StepPanel>
  )
}
