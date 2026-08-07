import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { ChatComposerBox } from '@renderer/components/messages/chat-composer-box'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { AgentCreationAids, type ImportResult } from '@renderer/components/agents/agent-creation-aids'
import { useStartOnboardingSession } from '@renderer/hooks/use-start-onboarding-session'
import { TemplateInstallDialog } from '@renderer/components/agents/template-install-dialog'
import { useCreateAgent, useDeleteAgent, useUpdateAgent } from '@renderer/hooks/use-agents'
import { useCreateSession } from '@renderer/hooks/use-sessions'
import { useNavigate } from '@tanstack/react-router'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useUser } from '@renderer/context/user-context'
import { seedPendingSessionMessage } from '@renderer/context/pending-session-seed'
import { useMessageComposer } from '@renderer/hooks/use-message-composer'
import {
  useTypewriterPlaceholder,
  DEFAULT_AGENT_PROMPT_EXAMPLES,
} from '@renderer/hooks/use-typewriter-placeholder'
import { deriveAgentName } from '@renderer/lib/derive-agent-name'
import { UNTITLED_AGENT_NAME } from '@renderer/hooks/use-create-untitled-agent'
import { useWarmStartOnType } from '@renderer/hooks/use-warm-start-on-type'
import { useWarmStartOnTypeEnabled } from '@renderer/hooks/use-settings'
import { captureRendererException } from '@renderer/lib/error-reporting'
import type { ApiAgent, ApiDiscoverableAgent } from '@shared/lib/types/api'

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
  const textareaRef = useRef<HTMLDivElement>(null)
  const displayedPlaceholder = useTypewriterPlaceholder(DEFAULT_AGENT_PROMPT_EXAMPLES)

  const createAgent = useCreateAgent()
  const updateAgent = useUpdateAgent()
  const deleteAgent = useDeleteAgent()
  const createSession = useCreateSession()
  const navigate = useNavigate()
  const { track } = useAnalyticsTracking()
  const { user, isAuthMode } = useUser()
  const startOnboardingSession = useStartOnboardingSession()
  const warmStartEnabled = useWarmStartOnTypeEnabled()

  // Warm-precreated Untitled agent; deleted on abandon unless submit consumes it.
  const warmSlugOwnedRef = useRef<string | null>(null)
  const warmConsumedRef = useRef(false)
  const mountedRef = useRef(true)

  const discardWarmAgent = useCallback(async () => {
    const slug = warmSlugOwnedRef.current
    if (!slug || warmConsumedRef.current) return
    warmSlugOwnedRef.current = null
    try {
      await deleteAgent.mutateAsync(slug)
    } catch (error) {
      console.warn('[warm-start] discard pre-created agent failed:', error)
      captureRendererException(error, {
        tags: { area: 'warm-start', op: 'discard-agent' },
      })
    }
  }, [deleteAgent])

  const ensureWarmAgent = useCallback(async () => {
    const agent = await createAgent.mutateAsync({ name: UNTITLED_AGENT_NAME })
    // Create finished after the form unmounted — delete immediately.
    if (!mountedRef.current) {
      try {
        await deleteAgent.mutateAsync(agent.slug)
      } catch (error) {
        console.warn('[warm-start] discard in-flight pre-create failed:', error)
        captureRendererException(error, {
          tags: { area: 'warm-start', op: 'discard-agent' },
        })
      }
      return null
    }
    warmSlugOwnedRef.current = agent.slug
    warmConsumedRef.current = false
    return agent.slug
  }, [createAgent, deleteAgent])

  const awaitWarmStartRef = useRef<() => Promise<string | null>>(async () => null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const finishCreatedAgent = useCallback(
    async (agent: ApiAgent, source: 'new' | 'import' | 'skillset', hasOnboarding?: boolean) => {
      await discardWarmAgent()
      track('agent_created', { source, num_skills_added_at_creation: 0 })
      void navigate({ to: '/agents/$slug', params: { slug: agent.displaySlug } })
      if (hasOnboarding) {
        await startOnboardingSession(agent.slug)
      }
      await onAgentCreated?.()
    },
    [discardWarmAgent, track, navigate, startOnboardingSession, onAgentCreated],
  )

  const composer = useMessageComposer({
    agentSlug: '',
    // Attachments/uploads aren't available in the create-agent flow — the agent
    // doesn't exist yet. These throw if invoked, but AttachmentPicker doesn't
    // expose them in this layout so they're unreachable in practice.
    uploadFile: useCallback(async () => { throw new Error('Cannot upload before agent is created') }, []),
    uploadFolder: useCallback(async () => { throw new Error('Cannot upload before agent is created') }, []),
    // Keep typed text visible while create runs; seed the session ghost before
    // navigate so AgentShell (which mounts after the wizard closes) can show it.
    keepMessageUntilComplete: true,
    submitDisabled: isSubmitting,
    onSubmit: useCallback(async (content: string) => {
      // Local flag — do not key off createAgent.isPending; warm-start reuse of
      // that mutation would freeze the textarea while the user is still typing.
      setIsSubmitting(true)
      try {
        const agentName = await deriveAgentName(content)
        const warmSlug = await awaitWarmStartRef.current()
        const newAgent = warmSlug
          ? await updateAgent.mutateAsync({ slug: warmSlug, name: agentName })
          : await createAgent.mutateAsync({ name: agentName })
        if (warmSlug) warmConsumedRef.current = true
        const session = await createSession.mutateAsync({
          agentSlug: newAgent.slug,
          message: content,
          // Brand-new agents start their first session on Opus, mirroring
          // AgentHome's first-session default. The container normalizes the
          // family alias to the active provider's specific model.
          model: 'opus',
        })
        seedPendingSessionMessage(
          session.id,
          content,
          session.initialMessageUuid,
          isAuthMode && user ? { id: user.id, name: user.name, email: user.email } : undefined,
        )
        track('agent_created', { source: 'new', num_skills_added_at_creation: 0 })
        void navigate({ to: '/agents/$slug/sessions/$sessionId', params: { slug: newAgent.displaySlug, sessionId: session.id } })
        await onAgentCreated?.()
      } catch (error) {
        console.error('Failed to create agent:', error)
        toast.error('Failed to create agent', {
          description: error instanceof Error ? error.message : 'Please try again.',
        })
        // Rethrow so useMessageComposer's keepMessageUntilComplete path keeps
        // the typed prompt instead of clearing it after the failure toast.
        throw error
      } finally {
        setIsSubmitting(false)
      }
    }, [createAgent, updateAgent, createSession, navigate, track, onAgentCreated, isAuthMode, user]),
  })

  const { awaitWarmStart } = useWarmStartOnType({
    agentSlug: null,
    message: composer.message,
    enabled: warmStartEnabled,
    ensureAgent: ensureWarmAgent,
  })
  useEffect(() => {
    awaitWarmStartRef.current = awaitWarmStart
  }, [awaitWarmStart])

  // Abandon path: leave the create form without consuming the warm agent.
  // Ref + empty deps so mutation identity churn doesn't re-bind cleanup mid-edit.
  const discardWarmAgentRef = useRef(discardWarmAgent)
  useEffect(() => {
    discardWarmAgentRef.current = discardWarmAgent
  }, [discardWarmAgent])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      void discardWarmAgentRef.current()
    }
  }, [])

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

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void composer.handleSubmit(e)
    }
  }

  const isDisabled = isSubmitting

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
            onChange={composer.setMessage}
            onKeyDown={handleKeyDown}
            onPaste={composer.handlePaste}
            placeholder={displayedPlaceholder}
            disabled={isDisabled}
            rows={3}
            autoFocus
            dataTestId="create-agent-prompt"
            textareaClassName="min-h-[60px]"
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
      </div>

      <TemplateInstallDialog
        template={templateToInstall}
        onClose={() => setTemplateToInstall(null)}
        onInstalled={(agent, { hasOnboarding }) => finishCreatedAgent(agent, 'skillset', hasOnboarding)}
      />
    </div>
  )
}
