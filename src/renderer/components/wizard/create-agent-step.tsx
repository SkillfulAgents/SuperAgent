import { TemplateChoices } from '@renderer/components/agents/template-choices'
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
import { getPlatform, isElectron } from '@renderer/lib/env'

/**
 * The create-agent step is the one step wider than a form: it inlines the
 * template roster under the composer, which wants three card columns. It also
 * carries the only horizontal padding in the wizard — 480px of form has
 * gutters to spare in any window big enough to run the app, but the roster at
 * this width does not. `max-w` is border-box, so the cap is 760px of content
 * plus that padding.
 *
 * Unlike the other steps this one is a HEIGHT-FILLING column, not a centered
 * block, and the step container must not scroll: the composer stays pinned
 * while CreateAgentForm scrolls the template roster in the room below it, so
 * every layer between here and the form passes height down (h-full/flex-1
 * with min-h-0 at each level — any level missing min-h-0 lets flex content
 * push the column taller than the window and the pin silently breaks).
 */
export const AGENT_STEP_MAX_WIDTH = 'max-w-[808px] px-6'

/** Under the add-ons question: nothing picked here is final. */
const ADDONS_SUBTITLE = 'You can always modify later.'

/** The orb beside the job and add-ons steps' questions. */
const IDENTITY_AVATAR_SIZE = 56

type CreateAgentStepProps = CreationOptions & Pick<CreateAgentFormProps, 'onNavigateAway'> & {
  nameTitle?: string
  flow: CreateAgentFlow
  onChooseSource?: (openImport: boolean) => void
}

/**
 * The teammate asking: its orb beside the step's question, with its name
 * above. The orb is also the way back to change name and orb.
 */
function IdentityHeader({ identity, onEdit, question, subtitle }: { identity: ChosenAgentIdentity; onEdit: () => void; question: string; subtitle?: string }) {
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
          <AvatarView source={avatarSource(identity.avatar)} restingPhi={orbRestingPhi('new-agent')} size={IDENTITY_AVATAR_SIZE} state="idle" followPointer />
          <span className="absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full border bg-background opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <Pencil className="h-3 w-3 text-muted-foreground" aria-hidden />
          </span>
        </button>
        <div className="min-w-0">
          <p className="truncate text-sm text-muted-foreground" data-testid="agent-identity-name-label">{name}</p>
          <h2 className="text-2xl font-normal">
            {question}
            {/* A second sentence on the same line, at the same size, muted. */}
            {subtitle && <>{' '}<span className="text-muted-foreground/60">{subtitle}</span></>}
          </h2>
        </div>
      </div>
    </div>
  )
}

export function CreateAgentStep({
  flow,
  nameTitle = 'Name your first AI teammate',
  onChooseSource,
  onNavigateAway,
  surface,
}: CreateAgentStepProps) {
  const { stage, identity, named } = flow
  // The form mounts on the first visit to the job step and then stays, hidden
  // on the other steps: a typed prompt survives the trip back, and the
  // add-ons step's Create runs the form's own create.
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
          onChooseSource={flow.agent ? undefined : onChooseSource ?? flow.showChoices}
        />
      )}
      {stage === 'templates' && <TemplateChoices initiallyImporting={flow.importing} surface={surface} onInstalled={flow.complete} onNavigateAway={onNavigateAway} />}
      {describeVisited && (
        <div className="h-full" hidden={stage !== 'describe'}>
          {/* The title rides inside the form's centered hero block (see the
              form's `header` prop for why it cannot sit outside). */}
          <CreateAgentForm
            className="h-full"
            header={named
              ? <IdentityHeader identity={identity} onEdit={flow.backToName} question="What job do you want to give me?" />
              : (
                <div className="shrink-0 pb-8">
                  <h2 className="text-2xl font-normal max-w-sm">Describe your first AI teammate</h2>
                </div>
              )}
            namedFlow={named}
            existingAgent={flow.agent}
            initialPrompt={flow.prompt}
            onPromptChange={flow.setPrompt}
            onContinue={named ? flow.continueToAddons : undefined}
            continueRef={flow.continueRef}
            submitRef={flow.submitRef}
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
        />
      )}
    </>
  )
}

/**
 * The bottom row's forward button, opposite Back (both the create screen's
 * and the full wizard's): Continue on the name step, which submits its form
 * so it does what Enter does; Continue on the job step, which does what
 * Cmd+Enter in its composer does; Create Agent on the add-ons step.
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
        Continue
        <ArrowRight className="h-4 w-4 ml-1" />
      </Button>
    )
  }
  if (flow.stage === 'describe' && flow.named) {
    return (
      <>
        <Button variant="ghost" disabled={flow.saving} onClick={() => void flow.finish('home')} data-testid="create-agent-skip">Skip</Button>
        <Button disabled={flow.saving} onClick={() => void flow.continueRef.current?.()} data-testid="create-agent-continue">
          Continue
          <ArrowRight className="h-4 w-4 ml-1" />
        </Button>
      </>
    )
  }
  if (flow.stage === 'addons') {
    return (
      <Button onClick={() => void flow.finish('session')} disabled={flow.saving || flow.addonBusy} data-testid="create-agent-finish">
        {flow.saving ? (
          <>
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            Starting…
          </>
        ) : (
          'Start session'
        )}
      </Button>
    )
  }
  return null
}

type CreateAgentScreenProps = Omit<CreateAgentStepProps, 'flow'> & {
  /**
   * The bottom row's leading controls: the wizard's Skip, the create page's
   * Back. The forward button (Continue, Create Agent) always ends the row.
   */
  footer: (flow: CreateAgentFlow) => ReactNode
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
  'data-testid': string
}

/**
 * The full-window frame the create pages share: a title-bar drag strip, the
 * X, a content column as wide as the template roster wants, and a bottom row.
 */
export function CreateAgentChrome({ children, footer, onClose, 'data-testid': testId }: CreateAgentChromeProps) {
  return (
    <div className="flex h-svh bg-background overflow-hidden" data-testid={testId}>
      {isElectron() && <div className="absolute top-0 left-0 right-0 h-12 app-drag-region z-10" />}
      {onClose && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close"
          title="Close"
          data-testid="create-agent-close"
          // Above the drag region; on Windows, below the window controls
          // that own the top-right corner of the title bar.
          className={`app-no-drag absolute right-4 z-20 h-9 w-9 text-muted-foreground hover:text-foreground ${getPlatform() === 'win32' ? 'top-12' : 'top-4'}`}
        >
          <X className="h-5 w-5" />
        </Button>
      )}
      <div className="relative flex flex-col h-svh w-full">
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
          <div className={`flex h-full min-h-0 w-full mx-auto flex-col pt-10 ${AGENT_STEP_MAX_WIDTH}`}>
            {children}
          </div>
        </div>
        <div className={`flex items-center gap-2 pb-10 w-full mx-auto ${AGENT_STEP_MAX_WIDTH}`}>
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
export function CreateAgentScreen({ footer, onClose, 'data-testid': testId, ...step }: CreateAgentScreenProps) {
  const flow = useCreateAgentFlow(step)
  return <CreateAgentScreenLayout {...step} flow={flow} footer={footer} onClose={onClose} data-testid={testId} />
}

export function CreateAgentScreenLayout({ flow, footer, onClose, 'data-testid': testId, ...step }: CreateAgentScreenProps & { flow: CreateAgentFlow }) {
  return (
    <CreateAgentChrome
      data-testid={testId}
      onClose={onClose}
      footer={(
        <>
          {/* Leading controls fill the row up to the forward button, so a
              control pushed right (the wizard's Skip) lands beside it. */}
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
