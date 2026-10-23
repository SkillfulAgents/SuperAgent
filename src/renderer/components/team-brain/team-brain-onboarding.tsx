import { useState, type ReactNode } from 'react'
import { Brain, Folder, X } from 'lucide-react'
import { useAgents } from '@renderer/hooks/use-agents'
import { Switch } from '@renderer/components/ui/switch'
import { useUser } from '@renderer/context/user-context'
import { volumeSetupRegistry } from '@renderer/components/volumes/volume-setup-registry'
import { parseVolumeSource, type VolumeSetupDefinition } from '@renderer/components/volumes/volume-setup'
import { volumeDetailsSchema, type VolumeDetails } from '@renderer/components/volumes/volume-details-schema'
import type { VolumeSource } from '@shared/lib/volumes/volume-config-schema'
import { cn } from '@shared/lib/utils/cn'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@renderer/components/ui/dialog'
import { useTeamBrain, type TeamBrainStore } from '@renderer/lib/team-brain/team-brain-store'
import { TEAM_BRAIN_STEPS, type TeamBrainLocationId, type TeamBrainSourceId, type TeamBrainStep } from '@renderer/lib/team-brain/team-brain-schema'
import { TeamBrainSourceIcon } from './team-brain-source-icon'
import { LocationChoices, ScheduleChoices } from './team-brain-choices'
import { AgentAccessList } from './team-brain-agent-access'

/** The rail's names for each step. */
const STEP_LABELS: Record<TeamBrainStep, string> = {
  location: 'Choose where it lives',
  agents: 'Choose its agents',
  schedule: 'Set a schedule',
  intake: 'Context ingestion',
}

/** How a "Next: …" button names the step it goes to. */
const NEXT_LABELS: Record<TeamBrainStep, string> = {
  location: 'Location',
  agents: 'Agents',
  schedule: 'Schedule',
  intake: 'Context ingestion',
}

/** The homes set-up offers, in this order. */
const LOCATIONS: readonly TeamBrainLocationId[] = ['local', 's3', 'dropbox', 'googledrive']

// The look of Figma's Dev Mode welcome modal (UI Inspo, node 57:3), in this
// app's tokens: brand blue where Figma uses its green.
const BUTTON_BASE =
  'inline-flex h-7 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-3 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'
const PRIMARY = cn(BUTTON_BASE, 'bg-brand font-medium text-white hover:bg-brand/90')
const SECONDARY = cn(BUTTON_BASE, 'border bg-background hover:bg-muted')

/**
 * Set-up as one mid-size modal, laid out like Figma's Dev Mode welcome: a
 * dark rail with the brain glyph, the title and the numbered steps, the
 * current one in a filled pill; the step on the right under a short title and
 * grey subtitle; Back and "Next: …" in a ruled footer. Closing asks first.
 *
 * It asks what a form asks best (where it lives, what each agent may do, how
 * often it syncs), then hands over to `onStartChat`: a chat with Team Brain
 * for the team's context. Saving the drive on step 01 calls `onPrepare`.
 */
export function TeamBrainOnboarding({
  open,
  onPrepare,
  onStartChat,
  onCancel,
}: {
  open: boolean
  onPrepare: (source: VolumeSource, details: VolumeDetails) => Promise<void>
  onStartChat: () => Promise<void>
  onCancel: () => void
}) {
  const tb = useTeamBrain()
  const steps = TEAM_BRAIN_STEPS
  const index = Math.max(steps.indexOf(tb.state.step), 0)
  const step = steps[index]
  const nav: StepNav = {
    back: index > 0 ? () => tb.goToStep(steps[index - 1]) : undefined,
    nextLabel: steps[index + 1] ? `Next: ${NEXT_LABELS[steps[index + 1]]}` : '',
    next: () => steps[index + 1] && tb.goToStep(steps[index + 1]),
  }
  const [confirmCancel, setConfirmCancel] = useState(false)

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!next) setConfirmCancel(true) }}>
        <DialogContent
          hideClose
          className="flex h-[min(600px,calc(100vh-2rem))] w-[min(900px,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden border-0 p-0 shadow-2xl sm:rounded-2xl"
          data-testid="team-brain-onboarding"
          aria-describedby="team-brain-onboarding-step"
        >
          <aside className="flex w-[300px] shrink-0 flex-col justify-between bg-[#1e1e1e] pb-5 pt-11 text-white max-sm:hidden dark:bg-black">
            <div className="px-9">
              <Brain className="size-8" strokeWidth={1.5} aria-hidden="true" />
              <DialogTitle className="mt-6 text-[33px]/[1.2] font-normal tracking-[-0.01em]">
                <span className="block">Set up</span>
                <span className="block">Team Brain</span>
              </DialogTitle>
            </div>
            <ol className="space-y-0.5 px-5" aria-label="Set-up steps">
              {steps.map((s, i) => (
                <li
                  key={s}
                  aria-current={i === index ? 'step' : undefined}
                  className={cn(
                    'flex h-11 items-center gap-4 rounded-md px-3.5 text-[14px] text-white transition-colors',
                    i === index && 'bg-brand',
                  )}
                >
                  <span className={cn('min-w-[26px] text-[19px]/none font-light tabular-nums', i !== index && 'text-white/40')}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{STEP_LABELS[s]}</span>
                </li>
              ))}
            </ol>
          </aside>

          <section className="relative flex min-w-0 flex-1 flex-col bg-background" data-testid="team-brain-onboarding-step" data-step={step}>
            <DialogDescription id="team-brain-onboarding-step" className="sr-only">
              Step {index + 1} of {steps.length}: {STEP_LABELS[step]}
            </DialogDescription>
            <button
              type="button"
              onClick={() => setConfirmCancel(true)}
              className="absolute right-3 top-3 z-10 grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Close set-up"
              data-testid="team-brain-cancel"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
            {step === 'location' && <LocationStep tb={tb} nav={nav} onPrepare={onPrepare} />}
            {step === 'agents' && <AgentsStep tb={tb} nav={nav} />}
            {step === 'schedule' && <SyncStep tb={tb} nav={nav} />}
            {step === 'intake' && <IntakeStep nav={nav} onStart={onStartChat} />}
          </section>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop setting up Team Brain?</AlertDialogTitle>
            <AlertDialogDescription>
              {tb.state.prepared ? 'The Team Brain agent and drive made so far will be removed.' : 'Nothing has been created yet.'} Your choices will be forgotten; you can start again any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep going</AlertDialogCancel>
            <AlertDialogAction onClick={onCancel} data-testid="team-brain-cancel-confirm">Stop set-up</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────────────

/** Where Back and Next go from the current step. */
interface StepNav {
  back?: () => void
  nextLabel: string
  next: () => void
}

/**
 * The right panel for one step: title and subtitle, the step's content
 * centred in the space beneath them (scrolling when it's long), and the ruled
 * footer with its buttons.
 */
function StepPanel({
  title,
  subtitle,
  children,
  back,
  next,
  hint,
}: {
  title: string
  subtitle: ReactNode
  children: ReactNode
  back?: () => void
  next?: { label: string; onClick: () => void; disabled?: boolean; testId?: string }
  hint?: ReactNode
}) {
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-8 pt-11 sm:px-[52px]">
        <h2 className="pr-8 text-[18px] font-medium tracking-[-0.005em]">{title}</h2>
        <p className="mt-2 text-[13px] text-muted-foreground">{subtitle}</p>
        {/* Short content sits midway down the space left under the subtitle; long content just scrolls. */}
        <div className="my-auto pt-7">{children}</div>
      </div>
      <footer className="flex h-[60px] shrink-0 items-center justify-end gap-2 border-t px-[18px]">
        {hint && <span className="mr-auto min-w-0 text-[13px] text-muted-foreground">{hint}</span>}
        {back && (
          <button type="button" className={SECONDARY} onClick={back} data-testid="team-brain-back">
            Back
          </button>
        )}
        {next && (
          <button type="button" className={PRIMARY} onClick={next.onClick} disabled={next.disabled} data-testid={next.testId ?? 'team-brain-next'}>
            {next.label}
          </button>
        )}
      </footer>
    </>
  )
}

// ── 01 Where it lives ────────────────────────────────────────────────────────

/** Choosing a home opens that drive's own set-up in place of the cards; saving it prepares Team Brain there. */
function LocationStep({
  tb,
  nav,
  onPrepare,
}: {
  tb: TeamBrainStore
  nav: StepNav
  onPrepare: (source: VolumeSource, details: VolumeDetails) => Promise<void>
}) {
  const { isAuthMode, isAdmin } = useUser()
  const [setup, setSetup] = useState<{ definition: VolumeSetupDefinition; config: unknown } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const choose = async (id: TeamBrainLocationId) => {
    const definition = Object.values(volumeSetupRegistry).find((d) => d.type === id)
    if (!definition) return
    setError(null)
    try {
      const config = definition.begin ? await definition.begin() : undefined
      if (config !== null) setSetup({ definition, config })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not select this source')
    }
  }

  const save = async (config: unknown, values: VolumeDetails) => {
    if (!setup || isSaving) return
    setError(null)
    const details = volumeDetailsSchema.safeParse(values)
    if (!details.success) { setError(details.error.issues[0].message); return }
    setIsSaving(true)
    try {
      await onPrepare(parseVolumeSource(setup.definition, config), details.data)
      tb.setLocation(setup.definition.type)
      setSetup(null)
      nav.next()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set up this drive')
    } finally { setIsSaving(false) }
  }

  if (setup) {
    const Setup = setup.definition.Setup
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6 pt-11 sm:px-[52px]" data-testid="team-brain-drive-setup">
        <Setup
          initialConfig={setup.config}
          // Only a drive everyone can add can go to every agent.
          initialDetails={{ name: 'Team Brain', visibility: isAuthMode && !isAdmin ? 'private' : 'public' }}
          onSubmit={save}
          onBack={() => { setSetup(null); setError(null) }}
          onCancel={() => { setSetup(null); setError(null) }}
          isSaving={isSaving}
          error={error}
          clearError={() => setError(null)}
          attachToAgent
        />
      </div>
    )
  }

  return (
    <StepPanel
      title="Choose where Team Brain knowledge is stored"
      subtitle="Every agent you connect to Team Brain will read and add to the knowledge in this storage. It is possible to migrate later if needed."
      next={{ label: nav.nextLabel, disabled: !tb.state.prepared, onClick: nav.next }}
    >
      <LocationChoices value={tb.state.location} onChoose={(id) => void choose(id)} only={LOCATIONS} />
      {error && <p role="alert" className="mt-4 text-[13px] text-destructive">{error}</p>}
    </StepPanel>
  )
}

// ── 02 Agents ───────────────────────────────────────────────────────────────

/** Every agent (a global drive, as in Settings → Drives), or the agents switched on below. */
function AgentsStep({ tb, nav }: { tb: TeamBrainStore; nav: StepNav }) {
  const { data = [] } = useAgents()
  const agents = data.filter((agent) => agent.slug !== tb.state.prepared?.agentSlug)
  const canGoGlobal = !!tb.state.prepared?.isPublic
  return (
    <StepPanel
      title="Give your agents access to Team Brain"
      subtitle="Each agent reads your team’s context and can message Team Brain to add what it learns. You can change this later."
      back={nav.back}
      next={{ label: nav.nextLabel, onClick: nav.next }}
    >
      <div className="flex items-center gap-3 pb-3" data-testid="team-brain-every-agent">
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">Every agent</span>
          <span className="block text-[12px] text-muted-foreground">
            {canGoGlobal ? 'Includes agents you make later.' : 'Only a drive everyone can add can go to every agent.'}
          </span>
        </span>
        <Switch
          checked={tb.state.everyAgent}
          disabled={!canGoGlobal}
          onCheckedChange={tb.setEveryAgent}
          aria-label="Every agent"
          data-testid="team-brain-every-agent-switch"
        />
      </div>
      {agents.length > 0 ? (
        <AgentAccessList agents={agents} everyAgent={tb.state.everyAgent} className="border-y" />
      ) : (
        <p className="text-[13px] text-muted-foreground">No agents yet. Agents you make later can add the Team Brain drive from their Drives.</p>
      )}
    </StepPanel>
  )
}

// ── 03 Sync ─────────────────────────────────────────────────────────────────

function SyncStep({ tb, nav }: { tb: TeamBrainStore; nav: StepNav }) {
  return (
    <StepPanel
      title="Set how often it syncs"
      subtitle="Each sync reads what changed in your sources, which costs tokens. Syncing more often keeps your agents’ context fresher; less often costs less."
      back={nav.back}
      hint="You can change this any time."
      next={{ label: nav.nextLabel, onClick: nav.next }}
    >
      <ScheduleChoices value={tb.state.schedule} onChoose={tb.setSchedule} />
    </StepPanel>
  )
}

// ── 04 Context ingestion ─────────────────────────────────────────────────────

/** A few of the apps the intake can read, overlapped like a stack of avatars. */
const INTAKE_SOURCES: readonly TeamBrainSourceId[] = ['slack', 'notion', 'googledrive', 'github', 'linear']

function SourceStack() {
  return (
    <span className="flex -space-x-2">
      {INTAKE_SOURCES.map((id) => (
        <span key={id} className="grid size-[30px] place-items-center rounded-full bg-background shadow-sm ring-2 ring-muted">
          <TeamBrainSourceIcon id={id} className="size-[17px]" />
        </span>
      ))}
    </span>
  )
}

/** Reading everything, then a question it couldn't settle and the person's answer, in miniature. */
function IngestPreview() {
  return (
    <span className="w-full space-y-1.5 whitespace-nowrap px-3 text-[11px]/[14px]">
      <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <Brain className="size-3 shrink-0" aria-hidden="true" />
        <span className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/10">
          <span className="block h-full w-3/4 rounded-full bg-brand" />
        </span>
        1,204 docs
      </span>
      <span className="block w-fit rounded-md rounded-bl-sm bg-background px-2 py-1 shadow-sm">Is DataWiz our old name?</span>
      <span className="ml-auto block w-fit rounded-md rounded-br-sm bg-brand px-2 py-1 text-white">Yes, we rebranded</span>
    </span>
  )
}

/** The structure it proposes, in miniature, one folder just filed. */
function TreePreview() {
  return (
    <span className="w-full space-y-0.5 px-4 text-[11px]/[14px] text-muted-foreground">
      {['Customers', 'Product', 'Brand'].map((name, i) => (
        <span key={name} className={cn('flex items-center gap-1.5 rounded px-1.5 py-1', i === 1 && 'bg-brand/10 text-brand')}>
          <Folder className="size-3 shrink-0" aria-hidden="true" />
          {name}
        </span>
      ))}
    </span>
  )
}

const INTAKE_STAGES: { title: string; detail: string; Preview: () => ReactNode }[] = [
  { title: 'Connect apps & share docs', detail: 'Connect the apps your team works in, and share any docs it should read.', Preview: SourceStack },
  { title: 'Ingest & clarify', detail: 'Team Brain reads and makes sense of it all, then asks you to clarify anything confusing.', Preview: IngestPreview },
  { title: 'Approve and launch', detail: 'Review the structure it proposes, then launch it to your agents.', Preview: TreePreview },
]

function IntakeStep({ nav, onStart }: { nav: StepNav; onStart: () => Promise<void> }) {
  const [starting, setStarting] = useState(false)
  const start = async () => {
    setStarting(true)
    try { await onStart() } finally { setStarting(false) }
  }
  return (
    <StepPanel
      title="Chat with Team Brain to share your team’s context"
      subtitle="It all happens in one conversation, and you can ask it anything along the way."
      back={nav.back}
      next={{ label: 'Start chat', onClick: () => void start(), disabled: starting, testId: 'team-brain-start-chat' }}
    >
      <ol className="space-y-3" aria-label="What happens next">
        {INTAKE_STAGES.map(({ title, detail, Preview }, i) => (
          <li
            key={title}
            className="flex items-center gap-4 rounded-lg border bg-background p-2.5 duration-500 animate-in fade-in slide-in-from-bottom-2 fill-mode-both motion-reduce:animate-none"
            style={{ animationDelay: `${i * 120}ms` }}
          >
            <span aria-hidden="true" className="flex h-[88px] w-[176px] shrink-0 items-center justify-center rounded-md bg-muted/60">
              <Preview />
            </span>
            <span className="min-w-0 flex-1 pr-2">
              <span className="flex items-baseline gap-1.5 text-[14px] font-medium">
                <span className="text-[12px] font-normal tabular-nums text-muted-foreground">{i + 1}</span>
                {title}
              </span>
              <span className="mt-0.5 block text-[13px] text-muted-foreground">{detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </StepPanel>
  )
}
