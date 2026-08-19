import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { seedPendingSessionMessage } from '@renderer/context/pending-session-seed'
import { useNavTransient } from '@renderer/context/nav-transient-context'
import { useMessageComposer } from '@renderer/hooks/use-message-composer'
import {
  useTypewriterPlaceholder,
  DEFAULT_AGENT_PROMPT_EXAMPLES,
} from '@renderer/hooks/use-typewriter-placeholder'
import { deriveAgentName } from '@renderer/lib/derive-agent-name'
import { UNTITLED_AGENT_NAME } from '@renderer/hooks/use-create-untitled-agent'
import { useWarmStartOnType } from '@renderer/hooks/use-warm-start-on-type'
import { useDraftsStore } from '@renderer/context/drafts-context'
import { useModelSettings, useWarmStartOnTypeEnabled } from '@renderer/hooks/use-settings'
import { completeAgentTemplateHandoff } from '@renderer/lib/agent-template-handoff'
import {
  ComposerOptions,
  findCatalogModel,
  useComposerOptions,
} from '@renderer/components/messages/composer-options'
import { captureRendererException } from '@renderer/lib/error-reporting'
import { useDiscoverableAgents, slugFromAgentPath } from '@renderer/hooks/use-agent-templates'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'
import type { ApiDiscoverableAgent } from '@shared/lib/types/api'

/**
 * Ceiling, not a delay: the offer resolves the instant the discoverable list
 * lands, and this only fires when nothing ever arrives. A cold skillset sync
 * measured ~1.4s on a fast connection, so the margin here is for slow links.
 *
 * Erring long is close to free — a larger value never delays the happy path,
 * it only extends how long the composer stays unfocused in the already-broken
 * case. Erring short is not: the offer would settle before a slow list arrives
 * and no dialog would ever appear, silently, for exactly the cold first-run
 * installs this handoff targets.
 */
const HANDOFF_TEMPLATE_WAIT_MS = 10000

export interface CreateAgentFormProps {
  /** Fires after an agent is successfully created (via any path). Parent uses this to close the overlay/wizard. */
  onAgentCreated?: () => Promise<void> | void
  /** Form max width in the layout. Defaults to no cap (wrapper decides). */
  className?: string
  /** When true, play the reverse (exit) animation on the same items. */
  exiting?: boolean
}

export function CreateAgentForm({ onAgentCreated, className, exiting = false }: CreateAgentFormProps) {
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
  const startOnboardingSession = useStartOnboardingSession()
  const draftsStore = useDraftsStore()
  const warmStartEnabled = useWarmStartOnTypeEnabled()
  const { signupHandoff, setSignupHandoff } = useNavTransient()
  const { data: modelSettings } = useModelSettings()
  const [handoffModel, setHandoffModel] = useState<string | null>(null)
  // Arm synchronously so mount-time composer autoFocus sees an armed slug
  // (MarkdownComposerEditor focuses once on create; a later autoFocus=false is a no-op).
  // Prompt-wins matches the take effect: a prompt in the one-shot never arms the offer.
  const [handoffTemplateSlug, setHandoffTemplateSlug] = useState<string | null>(() =>
    signupHandoff && !signupHandoff.prompt ? (signupHandoff.template_slug ?? null) : null,
  )
  const composerTouchedRef = useRef(false)
  // Sync forfeit: ref closes the paint→effect gap so an aid click cannot lose to a
  // resolve effect still holding the armed slug from the prior commit.
  const forfeitHandoffTemplate = useCallback(() => {
    composerTouchedRef.current = true
    setHandoffTemplateSlug(null)
  }, [])
  // The editor reads autoFocus ONCE at create, so a slug armed on mount suppresses
  // focus for good — flipping the prop back to true later does nothing. Every path
  // that disarms without opening the dialog has to hand focus back by hand.
  // Not called from forfeitHandoffTemplate: typing already holds focus, and an
  // aid/mic forfeit is the user moving focus somewhere else on purpose.
  const focusComposer = useCallback(() => {
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [])
  const [templateToInstall, setTemplateToInstall] = useState<ApiDiscoverableAgent | null>(null)
  const { data: discoverableAgents, isError: discoverableAgentsFailed } = useDiscoverableAgents()

  const activeProvider = modelSettings?.llmProvider
  const catalog = useMemo(
    () => modelSettings?.llmProviderStatus?.find((p) => p.id === activeProvider)?.catalog ?? [],
    [modelSettings, activeProvider],
  )
  // Seed from the carried marketing-handoff model only when the effective
  // catalog knows it — an unknown versioned id would be passed to the SDK as a
  // pin and fail at the API. Resolved as the catalog lands: it's a separate
  // query from settings and may not have answered at mount, so the picker seeds
  // once it does.
  const handoffSeedModel = useMemo(
    () => (handoffModel ? findCatalogModel(handoffModel, catalog)?.id : undefined),
    [handoffModel, catalog],
  )
  // No agent exists yet to supply a per-agent override. The hook falls back
  // to the app-wide selection, then the active provider's catalog default.
  const composerOptions = useComposerOptions({ initialModel: handoffSeedModel })

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
    async (
      agent: ImportResult,
      source: 'import' | 'skillset',
    ) => {
      await discardWarmAgent()
      track('agent_created', {
        source,
        num_skills_added_at_creation: 0,
        has_template_prompt: Boolean(agent.templatePrompt),
      })
      await completeAgentTemplateHandoff({
        draftsStore,
        agentSlug: agent.slug,
        hasOnboarding: agent.hasOnboarding,
        templatePrompt: agent.templatePrompt,
        openAgent: () => { void navigate({ to: '/agents/$slug', params: { slug: agent.displaySlug } }) },
        startOnboardingSession,
      })
      await onAgentCreated?.()
    },
    [discardWarmAgent, track, draftsStore, navigate, startOnboardingSession, onAgentCreated],
  )

  const composer = useMessageComposer({
    agentSlug: '',
    onVoiceTranscript: forfeitHandoffTemplate,
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
        // Only failures before the session exists are retryable creation
        // failures. Once the API has accepted the initial message, the composer
        // must clear even if the wizard's follow-up persistence fails; otherwise
        // retrying creates a duplicate agent and session.
        const { newAgent, session } = await (async () => {
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
              ...composerOptions.toRuntimeOptions(),
              // An untouched model is omitted from the runtime options, but a brand
              // new agent has no stored default for the server to resolve against —
              // always send what the picker is showing.
              model: composerOptions.model ?? composerOptions.defaultModel,
            })
            return { newAgent, session }
          } catch (error) {
            console.error('Failed to create agent:', error)
            toast.error('Failed to create agent', {
              description: error instanceof Error ? error.message : 'Please try again.',
            })
            // Rethrow so useMessageComposer keeps the typed prompt for a genuine
            // create failure and the user can safely retry it.
            throw error
          }
        })()

        seedPendingSessionMessage(
          session.id,
          content,
          session.initialMessageUuid,
        )
        track('agent_created', { source: 'new', num_skills_added_at_creation: 0 })
        void navigate({ to: '/agents/$slug/sessions/$sessionId', params: { slug: newAgent.displaySlug, sessionId: session.id } })
        try {
          await onAgentCreated?.()
        } catch (error) {
          console.error('Agent created, but failed to finish setup:', error)
          toast.error('Agent created, but setup could not be completed', {
            description: error instanceof Error ? error.message : 'Please try finishing setup again.',
          })
        }
      } finally {
        setIsSubmitting(false)
      }
    }, [createAgent, updateAgent, createSession, navigate, track, onAgentCreated, composerOptions]),
  })

  const { awaitWarmStart, noteProgrammaticChange } = useWarmStartOnType({
    agentSlug: null,
    message: composer.message,
    enabled: warmStartEnabled,
    ensureAgent: ensureWarmAgent,
  })
  useEffect(() => {
    awaitWarmStartRef.current = awaitWarmStart
  }, [awaitWarmStart])

  useEffect(() => {
    if (!signupHandoff) return
    if (signupHandoff.prompt) {
      // Seed warm-start baseline first so the prefill is not treated as typing
      // (success criterion: prefill only — nothing auto-creates).
      noteProgrammaticChange(signupHandoff.prompt)
      composer.setMessage(signupHandoff.prompt)
      setTimeout(() => textareaRef.current?.focus(), 0)
    }
    if (signupHandoff.model) setHandoffModel(signupHandoff.model)
    // PROMPT WINS AT ARM TIME:
    setHandoffTemplateSlug(signupHandoff.prompt ? null : signupHandoff.template_slug ?? null)
    setSignupHandoff(null) // one-shot
  }, [signupHandoff, setSignupHandoff, composer, noteProgrammaticChange])

  useEffect(() => {
    if (!handoffTemplateSlug || composerTouchedRef.current) return
    // Fail-open: a broken list must not leave the offer armed forever.
    if (discoverableAgentsFailed) {
      setHandoffTemplateSlug(null)
      focusComposer()
      return
    }
    if (!discoverableAgents || discoverableAgents.length === 0) {
      // Bounded wait. useDiscoverableAgents is `enabled: hasSkillsets`, so with no
      // skillsets the query never runs: data stays undefined and isError stays false
      // forever, and an unbounded wait would strand the composer unfocused. The timer
      // also caps how late an offer may appear on a slow list — a dialog opening
      // minutes after landing reads as a glitch, not an offer.
      const timer = setTimeout(() => {
        setHandoffTemplateSlug(null)
        focusComposer()
      }, HANDOFF_TEMPLATE_WAIT_MS)
      return () => clearTimeout(timer)
    }
    const match = discoverableAgents.find(
      (a) => a.skillsetId === DEFAULT_PUBLIC_SKILLSET.id && slugFromAgentPath(a.path) === handoffTemplateSlug,
    )
    if (match) {
      setTemplateToInstall(match)
      setHandoffTemplateSlug(null)
    } else {
      setHandoffTemplateSlug(null) // settle: populated + no match
      focusComposer()
    }
  }, [discoverableAgents, discoverableAgentsFailed, handoffTemplateSlug, focusComposer])

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
    (agent: ImportResult) => finishCreatedAgent(agent, 'import'),
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
            onChange={(value) => {
              forfeitHandoffTemplate()
              composer.setMessage(value)
            }}
            onKeyDown={handleKeyDown}
            onPaste={composer.handlePaste}
            placeholder={displayedPlaceholder}
            disabled={isDisabled}
            rows={3}
            autoFocus={!templateToInstall && !handoffTemplateSlug}
            dataTestId="create-agent-prompt"
            textareaClassName="min-h-[60px]"
            leftActions={(
              <>
                <AttachmentPicker
                  onFileSelect={composer.handleFileSelect}
                  onFolderSelect={composer.handleFolderSelect}
                  disabled={isDisabled}
                />
                <ComposerOptions state={composerOptions} disabled={isDisabled} />
              </>
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
            onAidOpened={forfeitHandoffTemplate}
            onTemplateInstalled={onAgentCreated}
          />
        </div>
      </div>

      <TemplateInstallDialog
        template={templateToInstall}
        handoffOrigin
        onClose={() => setTemplateToInstall(null)}
        onInstalled={(agent) => finishCreatedAgent(agent, 'skillset')}
      />
    </div>
  )
}
