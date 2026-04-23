import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { ChatComposerBox } from '@renderer/components/messages/chat-composer-box'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { AgentCreationAids, type ImportResult } from '@renderer/components/agents/agent-creation-aids'
import { TemplateInstallDialog } from '@renderer/components/agents/template-install-dialog'
import { TemplateCard } from '@renderer/components/agents/template-card'
import { useCreateAgent } from '@renderer/hooks/use-agents'
import { useCreateSession } from '@renderer/hooks/use-sessions'
import { useDiscoverableAgents } from '@renderer/hooks/use-agent-templates'
import { useSelection } from '@renderer/context/selection-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useMessageComposer } from '@renderer/hooks/use-message-composer'
import {
  useTypewriterPlaceholder,
  DEFAULT_AGENT_PROMPT_EXAMPLES,
} from '@renderer/hooks/use-typewriter-placeholder'
import { deriveAgentName } from '@renderer/lib/derive-agent-name'
import type { ApiAgent, ApiDiscoverableAgent } from '@shared/lib/types/api'

const ONBOARDING_MESSAGE = 'This agent was just set up from a template. Please run the agent-onboarding skill to help me configure it.'

export interface CreateAgentFormProps {
  /** Fires after an agent is successfully created (via any path). Parent uses this to close the overlay/wizard. */
  onAgentCreated?: () => Promise<void> | void
  /** Pre-selects a template and jumps straight to the "name the agent" step. */
  initialTemplate?: ApiDiscoverableAgent | null
  /** Form max width in the layout. Defaults to no cap (wrapper decides). */
  className?: string
  /** When true, play the reverse (exit) animation on the same items. */
  exiting?: boolean
}

export function CreateAgentForm({ onAgentCreated, initialTemplate, className, exiting = false }: CreateAgentFormProps) {
  // Staggered reveal: items start hidden on first render, flip to visible on the next frame,
  // then flip back to hidden when `exiting` becomes true. Reverse the stagger on exit.
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setRevealed(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const itemHidden = exiting || !revealed
  const itemProps = (inDelayMs: number, outDelayMs: number) => ({
    className: 'create-agent-item',
    'data-hidden': itemHidden ? 'true' : 'false',
    style: { transitionDelay: `${exiting ? outDelayMs : inDelayMs}ms` },
  })
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const displayedPlaceholder = useTypewriterPlaceholder(DEFAULT_AGENT_PROMPT_EXAMPLES)

  const createAgent = useCreateAgent()
  const createSession = useCreateSession()
  const { selectAgent, selectSession } = useSelection()
  const { track } = useAnalyticsTracking()

  const finishCreatedAgent = useCallback(
    async (agent: ApiAgent, source: 'new' | 'import' | 'skillset', hasOnboarding?: boolean) => {
      track('agent_created', { source, num_skills_added_at_creation: 0 })
      selectAgent(agent.slug)
      if (hasOnboarding) {
        try {
          const session = await createSession.mutateAsync({
            agentSlug: agent.slug,
            message: ONBOARDING_MESSAGE,
          })
          selectSession(session.id)
        } catch {
          // Onboarding session creation failed — user can still use agent normally
        }
      }
      await onAgentCreated?.()
    },
    [track, selectAgent, selectSession, createSession, onAgentCreated],
  )

  const composer = useMessageComposer({
    agentSlug: '',
    // Attachments/uploads aren't available in the create-agent flow — the agent
    // doesn't exist yet. These throw if invoked, but AttachmentPicker doesn't
    // expose them in this layout so they're unreachable in practice.
    uploadFile: useCallback(async () => { throw new Error('Cannot upload before agent is created') }, []),
    uploadFolder: useCallback(async () => { throw new Error('Cannot upload before agent is created') }, []),
    onSubmit: useCallback(async (content: string) => {
      try {
        const agentName = await deriveAgentName(content)
        const newAgent = await createAgent.mutateAsync({ name: agentName })
        const session = await createSession.mutateAsync({
          agentSlug: newAgent.slug,
          message: content,
        })
        track('agent_created', { source: 'new', num_skills_added_at_creation: 0 })
        selectAgent(newAgent.slug)
        selectSession(session.id)
        await onAgentCreated?.()
      } catch (error) {
        console.error('Failed to create agent:', error)
      }
    }, [createAgent, createSession, selectAgent, selectSession, track, onAgentCreated]),
  })

  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`
    }
  }, [composer.message])

  // --- Template install flow (inline name step + required env vars) ---
  const { data: discoverableAgents } = useDiscoverableAgents()
  const hasTemplates = !!(discoverableAgents && discoverableAgents.length > 0)
  const [templateToInstall, setTemplateToInstall] = useState<ApiDiscoverableAgent | null>(initialTemplate ?? null)

  useEffect(() => {
    if (initialTemplate) setTemplateToInstall(initialTemplate)
  }, [initialTemplate])

  const handleVoiceResult = useCallback(
    ({ prompt }: { name: string; prompt: string }) => {
      if (prompt) {
        composer.setMessage(prompt)
        setTimeout(() => textareaRef.current?.focus(), 0)
      }
    },
    [composer],
  )

  const handleImportComplete = useCallback(
    ({ agent, hasOnboarding }: ImportResult) => finishCreatedAgent(agent, 'import', hasOnboarding),
    [finishCreatedAgent],
  )

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      e.currentTarget.closest('form')?.requestSubmit()
    }
  }

  const isDisabled = createAgent.isPending || createSession.isPending

  return (
    <div className={className}>
      <div className="space-y-8">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void composer.handleSubmit(e)
          }}
          {...itemProps(80, 130)}
        >
          <ChatComposerBox
            textareaRef={textareaRef}
            attachments={composer.attachments}
            onRemoveAttachment={composer.removeAttachment}
            value={composer.message}
            onChange={(e) => composer.setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={composer.handlePaste}
            placeholder={displayedPlaceholder}
            disabled={isDisabled}
            rows={3}
            autoFocus
            dataTestId="create-agent-prompt"
            leftActions={(
              <AttachmentPicker
                onFileSelect={composer.handleFileSelect}
                onFolderSelect={composer.handleFolderSelect}
                disabled={isDisabled}
              />
            )}
            rightActions={(
              <>
                <VoiceInputButton voiceInput={composer.voiceInput} message={composer.message} disabled={isDisabled} />
                <Button
                  type="submit"
                  size="sm"
                  data-testid="create-agent-submit"
                >
                  {isDisabled ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    'Create Agent'
                  )}
                </Button>
              </>
            )}
            footer={(
              <VoiceInputError error={composer.voiceInput.error} onDismiss={composer.voiceInput.clearError} className="mt-2 justify-center" />
            )}
          />
        </form>

        <div {...itemProps(160, 70)}>
          <AgentCreationAids
            onVoiceResult={handleVoiceResult}
            onImportComplete={handleImportComplete}
          />
        </div>

        {hasTemplates && (
          <>
            <div
              {...itemProps(300, 30)}
              className={`flex items-center gap-4 pt-2 px-6 ${itemProps(300, 30).className}`}
            >
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">OR START FROM A TEMPLATE</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <div
              {...itemProps(360, 0)}
              className={`space-y-4 ${itemProps(360, 0).className}`}
            >
              {groupBySkillset(discoverableAgents!).map(([skillsetName, agents]) => (
                <div key={skillsetName} className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground px-1">{skillsetName}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {agents.map((agent) => (
                      <TemplateCard
                        key={`${agent.skillsetId}::${agent.path}`}
                        template={agent}
                        variant="compact"
                        onClick={() => setTemplateToInstall(agent)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <TemplateInstallDialog
        template={templateToInstall}
        onClose={() => setTemplateToInstall(null)}
        onInstalled={(agent, { hasOnboarding }) => finishCreatedAgent(agent, 'skillset', hasOnboarding)}
      />
    </div>
  )
}

function groupBySkillset(agents: ApiDiscoverableAgent[]): Array<[string, ApiDiscoverableAgent[]]> {
  const grouped = new Map<string, ApiDiscoverableAgent[]>()
  for (const agent of agents) {
    const existing = grouped.get(agent.skillsetName) || []
    existing.push(agent)
    grouped.set(agent.skillsetName, existing)
  }
  return Array.from(grouped.entries())
}
