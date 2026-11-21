import { useState, type ReactNode } from 'react'
import { ArrowRight, Loader2, Pencil, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { CreateAgentForm, type CreateAgentFormProps } from '@renderer/components/agents/create-agent-form'
import { AGENT_IDENTITY_FORM_ID, AgentIdentityStep } from '@renderer/components/agents/agent-identity-step'
import { AvatarView, orbRestingPhi } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { avatarSource } from '@renderer/components/agents/agent-avatar/avatar-source'
import { AgentAddonsStep } from '@renderer/components/agents/agent-addons-step'
import { useCreateAgentFlow, type CreateAgentFlow, type CreationOptions } from '@renderer/hooks/use-create-agent-flow'
import type { ChosenAgentIdentity } from '@renderer/components/agents/creation-draft'
import { CREATE_AGENT_ORB_TRANSITION } from '@renderer/components/agents/create-agent-layout'
import { getPlatform, isElectron } from '@renderer/lib/env'
import { cn } from '@shared/lib/utils/cn'

/**
 * One column for the three steps of naming an agent (name and orb, its job,
 * its add-ons) and for the row of buttons under them, so nothing shifts
 * sideways from one step to the next and Back and Next sit on the
 * content's own edges. 576px: the orb picker's eight tiles across, and a
 * comfortable line for the composer and the add-on rows. `max-w` is
 * border-box, so the cap is the content plus the padding, which is the only
 * horizontal padding in the wizard (the 480px steps beside it have gutters to
 * spare in any window big enough to run the app).
 */
export const AGENT_STEP_MAX_WIDTH = 'max-w-[624px] px-6'

/**
 * The job step when it opens unnamed (a template handoff) inlines the
 * template roster under the composer, which wants three card columns: 760px.
 */
const AGENT_ROSTER_MAX_WIDTH = 'max-w-[808px] px-6'

/** The column a create flow is in now: the steps' one width, or the roster's. */
export function agentStepWidth(flow: Pick<CreateAgentFlow, 'stage' | 'named'>): string {
  return flow.stage === 'describe' && !flow.named ? AGENT_ROSTER_MAX_WIDTH : AGENT_STEP_MAX_WIDTH
}

/*
 * The step is a HEIGHT-FILLING column, not a centered block, and the step
 * container must not scroll: the composer stays pinned while CreateAgentForm
 * scrolls the template roster in the room below it, so every layer between
 * here and the form passes height down (h-full/flex-1 with min-h-0 at each
 * level — any level missing min-h-0 lets flex content push the column taller
 * than the window and the pin silently breaks).
 */

/** Under the add-ons question: nothing picked here is final. */
const ADDONS_SUBTITLE = 'You can always modify later.'

/** The orb beside the job and add-ons steps' questions. */
const IDENTITY_AVATAR_SIZE = 56

type CreateAgentStepProps = CreationOptions & Pick<CreateAgentFormProps, 'onNavigateAway'> & {
  nameTitle?: string
  flow: CreateAgentFlow
}

/**
 * The teammate asking: its orb beside the step's question. On the job step,
 * where it is met for the first time, it says who it is first (`introduce`);
 * that is the one place its name is written. The orb is also the way back to
 * change name and orb.
 */
function IdentityHeader({ identity, onEdit, question, subtitle, introduce = false }: { identity: ChosenAgentIdentity; onEdit: () => void; question: string; subtitle?: string; introduce?: boolean }) {
  const name = identity.name.trim()
  return (
    <div className="shrink-0 pb-8">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Change ${name}'s name and avatar`}
          title="Change name and avatar"
          data-testid="agent-identity-edit"
          className="group relative shrink-0 rounded-item outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* Just the orb travels between steps, not the pencil over it. */}
          <span className="block" style={CREATE_AGENT_ORB_TRANSITION}>
            <AvatarView source={avatarSource(identity.avatar)} restingPhi={orbRestingPhi('new-agent')} size={IDENTITY_AVATAR_SIZE} state="idle" followPointer />
          </span>
          <span className="absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full border bg-background opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <Pencil className="h-3 w-3 text-muted-foreground" aria-hidden />
          </span>
        </button>
        <div className="min-w-0">
          <h2 className="text-2xl font-normal">
            {/* Two sentences, a line each: the hello muted, as the add-ons
                step's second sentence is, so the question is what stands out.
                The space keeps them apart where they are read as one string.
                A long name wraps, not truncates. */}
            {introduce && <><span className="block break-words text-muted-foreground/60">Hey there! I’m <span data-testid="agent-identity-name-label">{name}</span>.</span>{' '}</>}
            {question}
            {/* A second sentence on its own line, at the same size, muted.
                The space keeps the two apart where they are read as one string. */}
            {subtitle && <>{' '}<span className="block text-muted-foreground/60">{subtitle}</span></>}
          </h2>
        </div>
      </div>
    </div>
  )
}

export function CreateAgentStep({
  flow,
  nameTitle = 'Name your first AI teammate',
  onNavigateAway,
  surface,
}: CreateAgentStepProps) {
  const { stage, identity, named } = flow
  // Keep the composer mounted so its draft and model selection survive step
  // changes. The add-ons footer submits this same composer.
  const [describeVisited, setDescribeVisited] = useState(stage === 'describe' || stage === 'addons')
  if (stage === 'describe' && !describeVisited) setDescribeVisited(true)

  return (
    <>
      {stage === 'name' && (
        <AgentIdentityStep
          title={nameTitle}
          value={identity}
          onChange={flow.setIdentity}
          onContinue={() => void flow.confirmIdentity()}
          returning={named}
        />
      )}
      {describeVisited && (
        <div className="h-full" hidden={stage !== 'describe'}>
          {/* The title rides inside the form's centered hero block (see the
              form's `header` prop for why it cannot sit outside). */}
          <CreateAgentForm
            className="h-full"
            header={named
              ? <IdentityHeader identity={identity} onEdit={flow.backToName} introduce question="What job will you give me?" />
              : (
                <div className="shrink-0 pb-8">
                  <h2 className="text-2xl font-normal max-w-sm">Describe your first AI teammate</h2>
                </div>
              )}
            namedFlow={named}
            dreamSelected={flow.dreamSelected}
            existingAgent={flow.agent}
            sessionRequestId={flow.sessionRequestId}
            initialPrompt={flow.prompt}
            onPromptChange={flow.setPrompt}
            initialRuntimeOptions={flow.initialRuntimeOptions}
            onRuntimeOptionsChange={flow.setRuntimeOptions}
            onContinue={named ? flow.continueToAddons : undefined}
            continueRef={flow.continueRef}
            submitRef={flow.submitRef}
            importAs={named ? { name: identity.name.trim(), onImported: flow.replaceWithImported } : undefined}
            onAgentCreated={flow.complete}
            onNavigateAway={onNavigateAway}
            surface={surface}
            showTemplates={!named}
          />
        </div>
      )}
      {stage === 'addons' && flow.agent && (
        <AgentAddonsStep
          header={<IdentityHeader identity={identity} onEdit={flow.backToName} question="Want to give me any add-ons?" subtitle={ADDONS_SUBTITLE} />}
          agentSlug={flow.agent.slug}
          onBusyChange={flow.setAddonBusy}
          onDreamChange={flow.setDreamSelected}
        />
      )}
    </>
  )
}

/**
 * The bottom row's forward button, opposite Back (both the create screen's
 * and the full wizard's): Next on the name step, which submits its form
 * so it does what Enter does; Next on the job step, which does what
 * Cmd+Enter in its composer does; Create on the add-ons step.
 * Skipping a step is not here: it is a quiet word in the top corner
 * (`CreateAgentSkipButton`), so this row holds only the ways forward and back.
 */
export function CreateAgentContinueButton({ flow }: { flow: CreateAgentFlow }) {
  if (flow.stage === 'name') {
    return (
      <Button
        type="submit"
        form={AGENT_IDENTITY_FORM_ID}
        disabled={!flow.identity.name.trim()}
        data-testid="agent-identity-continue"
      >
        Next
        <ArrowRight className="h-4 w-4 ml-1" />
      </Button>
    )
  }
  if (flow.stage === 'describe' && flow.named) {
    return (
      <Button disabled={flow.saving} onClick={() => void flow.continueRef.current?.()} data-testid="create-agent-continue">
        Next
        <ArrowRight className="h-4 w-4 ml-1" />
      </Button>
    )
  }
  if (flow.stage === 'addons') {
    return (
      <Button onClick={() => void flow.finish('session')} disabled={flow.saving || flow.addonBusy} data-testid="create-agent-finish">
        {flow.saving ? (
          <>
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            Creating…
          </>
        ) : (
          'Create'
        )}
      </Button>
    )
  }
  return null
}

/**
 * A step's Skip, for the top corner beside the X and drawn like it: muted
 * until hovered, no border, the X's height. Leaving a step out is always
 * available and never the thing the screen asks for.
 */
export function CornerSkipButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      {...props}
      className={cn('h-9 px-3 text-sm font-normal text-muted-foreground hover:text-foreground', className)}
    >
      Skip
    </Button>
  )
}

/** The job step's Skip: straight to the named agent's empty home. */
export function CreateAgentSkipButton({ flow }: { flow: CreateAgentFlow }) {
  if (flow.stage !== 'describe' || !flow.named) return null
  return <CornerSkipButton disabled={flow.saving} onClick={() => void flow.finish('home')} data-testid="create-agent-skip" />
}

type CreateAgentScreenProps = Omit<CreateAgentStepProps, 'flow'> & {
  /**
   * The bottom row's leading control: Back. The forward button (Next,
   * Create) always ends the row.
   */
  footer: (flow: CreateAgentFlow) => ReactNode
  /** A host's own quiet action for the top corner (the wizard's Skip), left of the step's. */
  cornerActions?: (flow: CreateAgentFlow) => ReactNode
  /** Leave the whole flow, from either step: an X in the top-right corner. */
  onClose?: () => void
  'data-testid': string
}

interface CreateAgentChromeProps {
  children: ReactNode
  /** The row under the content, full content width. */
  footer: ReactNode
  /** Leave the whole flow: an X in the top-right corner. */
  onClose?: () => void
  /** Quiet actions in the top-right corner, left of the X (a step's Skip). */
  cornerActions?: ReactNode
  /** The content column's and the bottom row's width classes. */
  width?: string
  'data-testid': string
}

/**
 * The full-window frame the create pages share: a title-bar drag strip, the
 * X, a content column, and a bottom row as wide as it.
 */
export function CreateAgentChrome({ children, footer, onClose, cornerActions, width = AGENT_STEP_MAX_WIDTH, 'data-testid': testId }: CreateAgentChromeProps) {
  return (
    <div className="flex h-svh bg-background overflow-hidden" data-testid={testId}>
      {isElectron() && <div className="absolute top-0 left-0 right-0 h-12 app-drag-region z-10" />}
      {/* The top corner: a step's Skip, then the X. Above the drag region;
          on Windows, below the window controls that own the top-right corner
          of the title bar. */}
      <div className={`app-no-drag absolute right-4 z-20 flex items-center gap-1 ${getPlatform() === 'win32' ? 'top-12' : 'top-4'}`}>
        {cornerActions}
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            data-testid="create-agent-close"
            className="h-9 w-9 text-muted-foreground hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </Button>
        )}
      </div>
      <div className="relative flex flex-col h-svh w-full">
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
          <div className={`flex h-full min-h-0 w-full mx-auto flex-col pt-10 ${width}`}>
            {children}
          </div>
        </div>
        <div className={`flex items-center gap-2 pb-10 max-sm:py-6 w-full mx-auto ${width}`}>
          {footer}
        </div>
      </div>
    </div>
  )
}

/**
 * The create step on its own, filling the window: the agent-only onboarding
 * wizard and the from-scratch create page (`/new-agent`) are the same screen
 * with a different way out.
 */
export function CreateAgentScreen({ footer, cornerActions, onClose, 'data-testid': testId, ...step }: CreateAgentScreenProps) {
  const flow = useCreateAgentFlow(step)
  return <CreateAgentScreenLayout {...step} flow={flow} footer={footer} cornerActions={cornerActions} onClose={onClose} data-testid={testId} />
}

export function CreateAgentScreenLayout({ flow, footer, cornerActions, onClose, 'data-testid': testId, ...step }: CreateAgentScreenProps & { flow: CreateAgentFlow }) {
  return (
    <CreateAgentChrome
      data-testid={testId}
      onClose={onClose}
      cornerActions={<>{cornerActions?.(flow)}<CreateAgentSkipButton flow={flow} /></>}
      width={agentStepWidth(flow)}
      footer={(
        <>
          {/* Leading controls fill the row up to the forward button. */}
          <div className="flex min-w-0 flex-1 items-center gap-2">{footer(flow)}</div>
          <CreateAgentContinueButton flow={flow} />
        </>
      )}
    >
      <div className="min-h-0 flex-1" data-testid="wizard-step-content" data-create-stage={flow.stage}>
        <CreateAgentStep flow={flow} {...step} />
      </div>
    </CreateAgentChrome>
  )
}
