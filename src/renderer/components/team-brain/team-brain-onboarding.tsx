import { useState, type ReactNode } from 'react'
import { Brain, Folder, Loader2, X } from 'lucide-react'
import { useAgents } from '@renderer/hooks/use-agents'
import { useSkillsets } from '@renderer/hooks/use-skillsets'
import { usePreparedDriveHealth, type useTeamBrainSetup } from '@renderer/hooks/use-team-brain-setup'
import { Button } from '@renderer/components/ui/button'
import { volumeSetupRegistry } from '@renderer/components/volumes/volume-setup-registry'
import { parseVolumeSource, type VolumeSetupDefinition } from '@renderer/components/volumes/volume-setup'
import { VolumeEveryoneOnlyContext, VolumeSetupFooterContext, type VolumeSetupFooterProps } from '@renderer/components/volumes/volume-setup-layout'
import { volumeDetailsSchema, type VolumeDetails } from '@renderer/components/volumes/volume-details-schema'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'
import { cn } from '@shared/lib/utils/cn'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@renderer/components/ui/dialog'
import { usesTeamBrain, useTeamBrain } from '@renderer/lib/team-brain/team-brain-store'
import type { TeamBrainSourceId } from '@renderer/lib/team-brain/team-brain-schema'
import { TEAM_BRAIN_STEPS, type TeamBrainLocationId, type TeamBrainStep } from '@shared/lib/config/team-brain-schema'
import { TeamBrainSourceIcon } from './team-brain-source-icon'
import { LocationChoices, ScheduleChoices } from './team-brain-choices'
import { teamBrainLocation } from './team-brain-locations'
import { AgentAccessList, EveryAgentRow } from './team-brain-agent-access'

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
 * grey subtitle; Back and "Next: …" in a ruled footer. Closing keeps the
 * set-up: the page offers Resume and Discard.
 *
 * It asks what a form asks best (where it lives, what each agent may do, how
 * often it syncs), then hands over to Start chat: a chat with Team Brain for
 * the team's context. Saving the drive on step 01 claims the set-up.
 */
export function TeamBrainOnboarding({ open, setup }: { open: boolean; setup: TeamBrainSetupActions }) {
  const tb = useTeamBrain()
  const waiting = driveWait(usePreparedDriveHealth(setup.prepared))
  const steps = TEAM_BRAIN_STEPS
  const index = Math.max(steps.indexOf(tb.state.step), 0)
  const step = steps[index]
  const nav: StepNav = {
    back: index > 0 ? () => tb.goToStep(steps[index - 1]) : undefined,
    nextLabel: steps[index + 1] ? `Next: ${NEXT_LABELS[steps[index + 1]]}` : '',
    next: () => steps[index + 1] && setup.goForward(steps[index + 1]),
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!next) tb.close() }}>
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
              onClick={tb.close}
              className="absolute right-3 top-3 z-10 grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Close set-up"
              data-testid="team-brain-cancel"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
            {step === 'location' && <LocationStep setup={setup} nav={nav} />}
            {step === 'agents' && <AgentsStep setup={setup} nav={nav} />}
            {step === 'schedule' && <SyncStep setup={setup} nav={nav} />}
            {step === 'intake' && <IntakeStep nav={nav} waiting={waiting} onStart={setup.startChat} />}
          </section>
        </DialogContent>
      </Dialog>

    </>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────────────

type TeamBrainSetupActions = ReturnType<typeof useTeamBrainSetup>

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
}: {
  title: string
  subtitle: ReactNode
  children: ReactNode
  back?: () => void
  next?: { label: string; onClick: () => void; disabled?: boolean; testId?: string }
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

/**
 * Choosing a home only selects it; Next opens that drive's own set-up in place of the cards, and saving it prepares
 * Team Brain there. Back on this step with the prepared home still chosen, Next goes straight on.
 */
function LocationStep({ setup, nav }: { setup: TeamBrainSetupActions; nav: StepNav }) {
  const [picked, setPicked] = useState<TeamBrainLocationId | null>(setup.setup?.location ?? null)
  const [drive, setDrive] = useState<{ definition: VolumeSetupDefinition; config: unknown } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const { data: skillsets, isError: skillsetsUnread, refetch: rereadSkillsets } = useSkillsets()
  const [isAdding, setIsAdding] = useState(false)
  // Shown inside the notice, so it goes with the notice once the list has the skillset (another admin's add included).
  const [addError, setAddError] = useState<string | null>(null)

  const addPublic = async () => {
    setAddError(null)
    setIsAdding(true)
    try {
      await setup.addPublicSkillset()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Could not add the Gamut Public Skillset')
    } finally { setIsAdding(false) }
  }

  const choose = async (id: TeamBrainLocationId) => {
    const definition = Object.values(volumeSetupRegistry).find((d) => d.type === id)
    if (!definition) return
    setError(null)
    try {
      const config = definition.begin ? await definition.begin() : undefined
      if (config !== null) setDrive({ definition, config })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not select this source')
    }
  }

  const save = async (config: unknown, values: VolumeDetails) => {
    if (!drive || isSaving) return
    setError(null)
    const details = volumeDetailsSchema.safeParse(values)
    if (!details.success) { setError(details.error.issues[0].message); return }
    setIsSaving(true)
    try {
      // False when the window now shows another admin's set-up instead.
      if (!(await setup.prepare(parseVolumeSource(drive.definition, config), details.data))) return
      setDrive(null)
      nav.next()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set up this drive')
    } finally { setIsSaving(false) }
  }

  if (drive) {
    const Setup = drive.definition.Setup
    return (
      // The set-up's form fills the panel, so its buttons can sit in the ruled bar at the foot (`DriveSetupFooter`);
      // its header sits as far above the form as the other steps' subtitles sit above theirs, and goes without its
      // supporting line: the drive's name and title say enough here.
      <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-6 pt-11 sm:px-[52px] [&>form]:flex [&>form]:flex-1 [&>form]:flex-col [&_[data-volume-setup-description]]:hidden" data-testid="team-brain-drive-setup">
        <VolumeSetupFooterContext.Provider value={DriveSetupFooter}>
          {/* Every member gets Team Brain, so every member must be able to read its drive. */}
          <VolumeEveryoneOnlyContext.Provider value>
          <Setup
            initialConfig={drive.config}
            initialDetails={{ name: 'Team Brain', visibility: 'public' }}
            onSubmit={save}
            onBack={() => { setDrive(null); setError(null) }}
            onCancel={() => { setDrive(null); setError(null) }}
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

  // Step 1 is done only while the set-up's agent holds its drive: one deleted since is set up again.
  const ready = !!setup.prepared && picked === setup.prepared.location
  // A prepared drive already has its agent, so the skillset check is for a set-up still to install it.
  const unread = !ready && skillsetsUnread
  const missingPublic = !ready && !unread && !!skillsets && !skillsets.some((s) => s.id === DEFAULT_PUBLIC_SKILLSET.id)
  return (
    <StepPanel
      title="Choose where Team Brain knowledge is stored"
      subtitle="Every agent you connect to Team Brain will read and add to the knowledge in this storage. It is possible to migrate later if needed."
      next={{
        label: ready || !picked ? nav.nextLabel : `Next: Set up ${teamBrainLocation(picked).name}`,
        disabled: !picked || (!ready && !skillsets) || unread || missingPublic,
        onClick: () => { if (ready) nav.next(); else if (picked) void choose(picked) },
      }}
    >
      <LocationChoices value={picked} onChoose={(id) => { setPicked(id); setError(null) }} />
      {unread && (
        <div className="mt-4"><p role="alert" className="text-[13px] text-destructive">Couldn’t read this workspace’s skillsets.</p><Button type="button" variant="ghost" size="sm" onClick={() => void rereadSkillsets()}>Try again</Button></div>
      )}
      {missingPublic && (
        <div className="mt-4 text-[13px]" data-testid="team-brain-public-skillset-missing">
          <div className="flex items-center justify-between gap-3">
            <span role="alert">Team Brain needs the Gamut Public Skillset.</span>
            <button type="button" className={SECONDARY} onClick={() => void addPublic()} disabled={isAdding}>
              {isAdding && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Add Gamut Public Skillset
            </button>
          </div>
          {addError && <p role="alert" className="mt-2 text-destructive">{addError}</p>}
        </div>
      )}
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

/** Set-up's last button goes on only once the drive is ready, so the agent never starts without it. */
function driveWait({ health, recheck }: ReturnType<typeof usePreparedDriveHealth>): DriveWait {
  return {
    ready: health === 'ok',
    label: health === 'preparing' ? 'Copying the drive…' : null,
    problem: health === 'missing' ? 'Couldn’t read the drive.' : health === 'unread' ? 'Couldn’t check the drive.' : null,
    recheck,
  }
}
type DriveWait = { ready: boolean; label: string | null; problem: string | null; recheck: () => void }

/** A drive that can't be read or checked says so, with Try again, as the drive's own set-up steps do. */
function DriveProblem({ waiting }: { waiting: DriveWait }) {
  if (!waiting.problem) return null
  return <div className="mt-4"><p role="alert" className="text-sm text-destructive">{waiting.problem}</p><Button type="button" variant="ghost" size="sm" onClick={waiting.recheck}>Try again</Button></div>
}

/** Every agent (a global drive, as in Settings → Drives), or the agents switched on below. */
function AgentsStep({ setup, nav }: { setup: TeamBrainSetupActions; nav: StepNav }) {
  const { data = [] } = useAgents()
  const { choices } = setup
  const agents = data.filter((agent) => agent.slug !== setup.setup?.agentSlug)
  return (
    <StepPanel
      title="Give your agents access to Team Brain"
      subtitle="Each agent reads your team’s context and can message Team Brain to add what it learns. You can change this later."
      back={nav.back}
      next={{ label: nav.nextLabel, onClick: nav.next }}
    >
      <EveryAgentRow checked={choices.everyAgent} canGoGlobal onCheckedChange={(everyAgent) => setup.choose({ everyAgent })} className="pb-3" />
      {agents.length > 0 ? (
        <AgentAccessList
          agents={agents}
          everyAgent={choices.everyAgent}
          isOn={(slug) => usesTeamBrain(choices, slug)}
          onToggle={(slug, on) => setup.choose({ agents: { [slug]: on } })}
          className="border-y"
        />
      ) : (
        <p className="text-[13px] text-muted-foreground">No agents yet. Agents you make later can add the Team Brain drive from their Drives.</p>
      )}
    </StepPanel>
  )
}

// ── 03 Sync ─────────────────────────────────────────────────────────────────

function SyncStep({ setup, nav }: { setup: TeamBrainSetupActions; nav: StepNav }) {
  return (
    <StepPanel
      title="Set how often it syncs"
      subtitle="Each sync reads what changed in your sources, which costs tokens. Syncing more often keeps your agents’ context fresher; less often costs less."
      back={nav.back}
      next={{ label: nav.nextLabel, onClick: nav.next }}
    >
      <ScheduleChoices value={setup.choices.schedule} onChoose={(schedule) => setup.choose({ schedule })} />
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

function IntakeStep({ nav, waiting, onStart }: { nav: StepNav; waiting: DriveWait; onStart: () => Promise<void> }) {
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
      next={{ label: waiting.label ?? 'Start chat', onClick: () => void start(), disabled: starting || !waiting.ready, testId: 'team-brain-start-chat' }}
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
      <DriveProblem waiting={waiting} />
    </StepPanel>
  )
}
