import { useState, type ReactNode } from 'react'
import { Brain, Folder, Loader2 } from 'lucide-react'
import { useAgents } from '@renderer/hooks/use-agents'
import { volumeSetupRegistry } from '@renderer/components/volumes/volume-setup-registry'
import { parseVolumeSource, type VolumeSetupDefinition } from '@renderer/components/volumes/volume-setup'
import { VolumeEveryoneOnlyContext, VolumeSetupFooterContext, type VolumeSetupFooterProps } from '@renderer/components/volumes/volume-setup-layout'
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
import { usesTeamBrain, useTeamBrain, type TeamBrainStore } from '@renderer/lib/team-brain/team-brain-store'
import { teamBrainSteps, type TeamBrainLocationId, type TeamBrainSourceId, type TeamBrainStep } from '@renderer/lib/team-brain/team-brain-schema'
import { useCloudTeamBrain } from '@renderer/hooks/use-cloud-team-brain'
import { TeamBrainSourceIcon } from './team-brain-source-icon'
import { LocationChoices, ScheduleChoices } from './team-brain-choices'
import { teamBrainLocation } from './team-brain-locations'
import { AgentAccessList, EveryAgentRow } from './team-brain-agent-access'
import { PRIMARY, SECONDARY, StepPanel, TeamBrainModal } from './team-brain-modal'
import { HowStep, ReadersStep } from './team-brain-connect'

/** The rail's names for each step. */
const STEP_LABELS: Record<TeamBrainStep, string> = {
  how: 'Choose how',
  readers: 'Choose its agents',
  location: 'Choose where it lives',
  agents: 'Choose its agents',
  schedule: 'Set a schedule',
  intake: 'Context ingestion',
}

/** How a "Next: …" button names the step it goes to. */
const NEXT_LABELS: Record<TeamBrainStep, string> = {
  how: 'How',
  readers: 'Agents',
  location: 'Location',
  agents: 'Agents',
  schedule: 'Schedule',
  intake: 'Context ingestion',
}


/**
 * Set-up as one mid-size modal, laid out like Figma's Dev Mode welcome: a
 * dark rail with the brain glyph, the title and the numbered steps, the
 * current one in a filled pill; the step on the right under a short title and
 * grey subtitle; Back and "Next: …" in a ruled footer. Closing asks first.
 *
 * It asks what a form asks best (where it lives, what each agent may do, how
 * often it syncs), then hands over to `onStartChat`: a chat with Team Brain
 * for the team's context. Saving the drive calls `onPrepare`.
 *
 * On the `desktop` it first asks how (team-brain-connect.tsx): connect to the
 * cloud workspace's Team Brain, read-only, and choose which agents here read
 * it, or set one up on this computer, the steps above. The rail follows the
 * path chosen, or preselected.
 */
export function TeamBrainOnboarding({
  open,
  desktop = false,
  onPrepare,
  onDiscard,
  onStartChat,
  onCancel,
}: {
  open: boolean
  desktop?: boolean
  onPrepare: (source: VolumeSource, details: VolumeDetails) => Promise<boolean>
  /** Drop what was prepared, staying in set-up: the desktop turned to connecting instead. */
  onDiscard?: () => Promise<void>
  onStartChat: () => Promise<void>
  onCancel: () => void
}) {
  const tb = useTeamBrain()
  // Asked only while set-up is open on the desktop.
  const lookup = useCloudTeamBrain(desktop && open)
  // Connecting is preselected once the cloud has a Team Brain to connect to.
  const path = tb.state.path ?? (lookup.state === 'found' ? 'cloud' : null)
  const steps = teamBrainSteps(desktop, path)
  // Connecting needs the Team Brain it found; should a fresh check lose it, how comes back.
  const at = tb.state.step === 'readers' && lookup.state !== 'found' ? 'how' : tb.state.step
  const index = Math.max(steps.indexOf(at), 0)
  const step = steps[index]
  const nav: StepNav = {
    back: index > 0 ? () => tb.goToStep(steps[index - 1]) : undefined,
    nextLabel: steps[index + 1] ? `Next: ${NEXT_LABELS[steps[index + 1]]}` : '',
    next: () => steps[index + 1] && tb.goToStep(steps[index + 1]),
  }
  const [confirmCancel, setConfirmCancel] = useState(false)
  // Nothing is made before where it lives, or while connecting, so closing then just closes.
  const close = () => (!tb.state.prepared && (step === 'how' || step === 'readers') ? onCancel() : setConfirmCancel(true))
  const leaveHow = () => {
    if (!path) return
    if (path === 'cloud' && tb.state.prepared) void onDiscard?.()
    tb.choosePath(path)
    nav.next()
  }

  return (
    <>
      <TeamBrainModal
        open={open}
        title={['Set up', 'Team Brain']}
        steps={steps.map((s) => ({ id: s, label: STEP_LABELS[s] }))}
        current={step}
        onClose={close}
        close={{ label: 'Close set-up', testId: 'team-brain-cancel' }}
        testId="team-brain-onboarding"
      >
        {step === 'how' && (
          <HowStep
            lookup={lookup}
            path={path}
            onChoose={tb.choosePath}
            onLeave={onCancel}
            next={{ label: path ? nav.nextLabel : 'Next', onClick: leaveHow }}
          />
        )}
        {step === 'readers' && lookup.state === 'found' && <ReadersStep tb={tb} brain={lookup.brain} onBack={() => tb.goToStep('how')} />}
        {step === 'location' && <LocationStep tb={tb} nav={nav} onPrepare={onPrepare} />}
        {step === 'agents' && <AgentsStep tb={tb} nav={nav} />}
        {step === 'schedule' && <SyncStep tb={tb} nav={nav} />}
        {step === 'intake' && <IntakeStep nav={nav} onStart={onStartChat} />}
      </TeamBrainModal>

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

// ── 01 Where it lives ────────────────────────────────────────────────────────

/**
 * Choosing a home only selects it; Next opens that drive's own set-up in place of the cards, and saving it prepares
 * Team Brain there. Back on this step with the prepared home still chosen, Next goes straight on.
 */
function LocationStep({
  tb,
  nav,
  onPrepare,
}: {
  tb: TeamBrainStore
  nav: StepNav
  onPrepare: (source: VolumeSource, details: VolumeDetails) => Promise<boolean>
}) {
  const [picked, setPicked] = useState<TeamBrainLocationId | null>(tb.state.location)
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
      // False when set-up was cancelled meanwhile: nothing to go on with.
      if (!(await onPrepare(parseVolumeSource(setup.definition, config), details.data))) return
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
      // The set-up's form fills the panel, so its buttons can sit in the ruled bar at the foot (`DriveSetupFooter`);
      // its header sits as far above the form as the other steps' subtitles sit above theirs, and goes without its
      // supporting line: the drive's name and title say enough here.
      <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-6 pt-11 sm:px-[52px] [&>form]:flex [&>form]:flex-1 [&>form]:flex-col [&_[data-volume-setup-description]]:hidden" data-testid="team-brain-drive-setup">
        <VolumeSetupFooterContext.Provider value={DriveSetupFooter}>
          {/* Every member gets Team Brain, so every member must be able to read its drive. */}
          <VolumeEveryoneOnlyContext.Provider value>
          <Setup
            initialConfig={setup.config}
            initialDetails={{ name: 'Team Brain', visibility: 'public' }}
            onSubmit={save}
            onBack={() => { setSetup(null); setError(null) }}
            onCancel={() => { setSetup(null); setError(null) }}
            isSaving={isSaving}
            error={error}
            clearError={() => setError(null)}
            attachToAgent
          />
          </VolumeEveryoneOnlyContext.Provider>
        </VolumeSetupFooterContext.Provider>
      </div>
    )
  }

  const ready = !!tb.state.prepared && picked === tb.state.location
  return (
    <StepPanel
      title="Choose where Team Brain knowledge is stored"
      subtitle="Every agent you connect to Team Brain will read and add to the knowledge in this storage. It is possible to migrate later if needed."
      back={nav.back}
      next={{
        label: ready || !picked ? nav.nextLabel : `Next: Set up ${teamBrainLocation(picked).name}`,
        disabled: !picked,
        onClick: () => { if (ready) nav.next(); else if (picked) void choose(picked) },
      }}
    >
      <LocationChoices value={picked} onChoose={(id) => { setPicked(id); setError(null) }} />
      {error && <p role="alert" className="mt-4 text-[13px] text-destructive">{error}</p>}
    </StepPanel>
  )
}

/**
 * A drive set-up's buttons in the modal's own ruled bar, as every other step has them: pinned to the foot of the
 * panel however long the set-up runs. Back and the set-up's own next step only; Back at its first screen already
 * returns to the homes, which is all its Cancel did here.
 */
function DriveSetupFooter({ onBack, isSaving, disabled, submitLabel }: VolumeSetupFooterProps) {
  return (
    <>
      {/* Takes up the slack, so a short form leaves the bar at the foot and a long one still keeps room above it. */}
      <div className="min-h-6 flex-1" aria-hidden="true" />
      <footer className="sticky bottom-0 -mx-6 flex h-[60px] shrink-0 items-center justify-end gap-2 border-t bg-background px-[18px] sm:-mx-[52px]" data-testid="team-brain-drive-footer">
        {onBack && (
          <button type="button" className={SECONDARY} onClick={onBack} disabled={isSaving} data-testid="team-brain-back">
            Back
          </button>
        )}
        <button type="submit" className={PRIMARY} disabled={disabled || isSaving} data-testid="team-brain-drive-submit">
          {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {submitLabel}
        </button>
      </footer>
    </>
  )
}

// ── 02 Agents ───────────────────────────────────────────────────────────────

/** Every agent (a global drive, as in Settings → Drives), or the agents switched on below. */
function AgentsStep({ tb, nav }: { tb: TeamBrainStore; nav: StepNav }) {
  const { data = [] } = useAgents()
  const agents = data.filter((agent) => agent.slug !== tb.state.prepared?.agentSlug)
  return (
    <StepPanel
      title="Give your agents access to Team Brain"
      subtitle="Each agent reads your team’s context and can message Team Brain to add what it learns. You can change this later."
      back={nav.back}
      next={{ label: nav.nextLabel, onClick: nav.next }}
    >
      <EveryAgentRow checked={tb.state.everyAgent} canGoGlobal onCheckedChange={tb.setEveryAgent} className="pb-3" />
      {agents.length > 0 ? (
        <AgentAccessList
          agents={agents}
          everyAgent={tb.state.everyAgent}
          isOn={(slug) => usesTeamBrain(tb.state, slug)}
          onToggle={tb.setUsesTeamBrain}
          className="border-y"
        />
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
      next={{ label: nav.nextLabel, onClick: nav.next }}
    >
      <ScheduleChoices value={tb.state.schedule} onChoose={tb.setSchedule} />
      <p className="mt-4 text-[13px] text-muted-foreground">You can change this any time.</p>
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
