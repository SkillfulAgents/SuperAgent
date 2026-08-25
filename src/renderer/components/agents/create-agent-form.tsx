import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { ChatComposerBox, FLOATING_COMPOSER_CLASS } from '@renderer/components/messages/chat-composer-box'
import { cn } from '@shared/lib/utils'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { CreateAgentTemplates } from '@renderer/components/agents/create-agent-templates'
import { ImportAgentDialog } from '@renderer/components/agents/import-agent-dialog'
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
import type { ApiAgentTemplateInstallResult, ApiDiscoverableAgent } from '@shared/lib/types/api'

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

/**
 * Soft edges for the template roster's scroll viewport, same recipe as the
 * voice-agent transcript: cards dissolve over 32px instead of clipping at the
 * top of the composer above and the footer below. Top padding (the measured
 * composer overlap plus this gap) keeps at-rest content clear of the bands,
 * so nothing looks faded until it is actually leaving.
 */
const ROSTER_FADE_MASK =
  'linear-gradient(to bottom, transparent 0, black 32px, black calc(100% - 32px), transparent 100%)'

/** At-rest gap between the composer's bottom edge and the roster heading. */
const ROSTER_TOP_GAP_PX = 64

export interface CreateAgentFormProps {
  /**
   * Rendered directly above the composer, inside the block the form keeps
   * vertically centered (the step's title). It has to live inside the form:
   * the centering is a pair of equal flex spacers around the header+composer
   * block, and a title rendered outside the form would sit above the top
   * spacer instead of moving with the block it labels.
   */
  header?: React.ReactNode
  /**
   * Awaited before the form navigates away (a see-more tile → the Explore
   * category page). The wizard uses it to finish itself first, since it
   * renders above the router and would otherwise cover the page we just went
   * to.
   */
  onNavigateAway?: () => Promise<void> | void
  /** Fires after an agent is successfully created (via any path). Parent uses this to close the overlay/wizard. */
  onAgentCreated?: () => Promise<void> | void
  /** Form max width in the layout. Defaults to no cap (wrapper decides). */
  className?: string
  /** When true, play the reverse (exit) animation on the same items. */
  exiting?: boolean
}

export function CreateAgentForm({ header, onAgentCreated, onNavigateAway, className, exiting = false }: CreateAgentFormProps) {
  // Staggered reveal: items start hidden on first render, flip to visible on the next frame,
  // then flip back to hidden when `exiting` becomes true. Reverse the stagger on exit.
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setRevealed(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const itemHidden = exiting || !revealed
  const itemProps = (
    inDelayMs: number,
    outDelayMs: number,
    extraClassName = '',
    base = 'create-agent-item',
  ) => ({
    className: `${base} ${extraClassName}`.trim(),
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
      agent: ApiAgentTemplateInstallResult,
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
    // No agent workspace exists yet, so this host does not offer attachments.
    // These throw if a caller still reaches them.
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

  const handleImportComplete = useCallback(
    (agent: ApiAgentTemplateInstallResult) => finishCreatedAgent(agent, 'import'),
    [finishCreatedAgent],
  )

  // The strip's end-cap card. Forfeits like the old aid chips did: an armed
  // signup handoff resolving underneath the import dialog would stack the
  // template-install dialog on top of it.
  const [showImportDialog, setShowImportDialog] = useState(false)
  const handleImportClick = useCallback(() => {
    forfeitHandoffTemplate()
    setShowImportDialog(true)
  }, [forfeitHandoffTemplate])

  // Picking a card is the user choosing a template outright, so it also
  // forfeits any armed signup handoff — otherwise the handoff's own offer
  // could still resolve and replace the one they just clicked.
  const handleTemplateSelected = useCallback(
    (template: ApiDiscoverableAgent) => {
      forfeitHandoffTemplate()
      setTemplateToInstall(template)
    },
    [forfeitHandoffTemplate],
  )

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void composer.handleSubmit(e)
    }
  }

  const isDisabled = isSubmitting

  // How far the roster's scroll viewport reaches UP behind the composer. The
  // composer's translucent chrome only reads as glass when something actually
  // scrolls behind it (sessions overlay it on the message list for the same
  // reason), so the viewport's top edge sits at the composer's top edge —
  // measured, because attachments and errors change the composer's height —
  // and matching top padding keeps every at-rest position unchanged.
  const composerBlockRef = useRef<HTMLFormElement>(null)
  const [composerOverlap, setComposerOverlap] = useState(0)
  // At rest the composer sits flush on the page; its floating shadow appears
  // only once the roster is scrolled, reading as the box lifting so the cards
  // can pass underneath.
  const [rosterScrolled, setRosterScrolled] = useState(false)
  useLayoutEffect(() => {
    const el = composerBlockRef.current
    if (!el) return
    const measure = () => {
      const next = Math.ceil(el.getBoundingClientRect().height)
      setComposerOverlap((current) => (current === next ? current : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    // The header+composer block floats in the upper third of the screen —
    // one part of the leftover height above it, five parts below — and stays
    // pinned there; only the template roster below it scrolls. The flex
    // spacers ARE the positioning: the empty spacer above and the roster's
    // scroll viewport below split the leftover 1:5, which sits the block
    // about a fifth of the screen above true center and gives the roster the
    // difference. Height comes from the wizard (the step chain is h-full flex
    // columns).
    <div className={`flex h-full min-h-0 flex-col ${className ?? ''}`}>
      <div className="min-h-0 flex-1 shrink" aria-hidden />

      {header}

      <form
        ref={composerBlockRef}
        onSubmit={(e) => {
          e.preventDefault()
          void composer.handleSubmit(e)
        }}
        // The -glass reveal variant: the plain item's filter/will-change
        // would make this a backdrop root and blind the composer's
        // backdrop-blur to the roster behind it (see globals.css). z-10: the
        // roster viewport reaches up behind this block and both siblings are
        // stacking contexts, so the later sibling (the roster) would paint
        // over the composer without explicit z-order.
        {...itemProps(80, 130, 'relative z-10 shrink-0', 'create-agent-item-glass')}
      >
        <ChatComposerBox
          className={cn(
            FLOATING_COMPOSER_CLASS,
            'transition-shadow duration-500',
            // twMerge keeps the last shadow per variant, so these override
            // the floating shadows until the roster starts moving.
            !rosterScrolled && 'shadow-none dark:shadow-none',
          )}
          textareaRef={textareaRef}
          attachments={composer.attachments}
          onRemoveAttachment={composer.removeAttachment}
          value={composer.message}
          onChange={(value) => {
            forfeitHandoffTemplate()
            composer.setMessage(value)
          }}
          onKeyDown={handleKeyDown}
          placeholder={displayedPlaceholder}
          disabled={isDisabled}
          rows={3}
          autoFocus={!templateToInstall && !handoffTemplateSlug}
          dataTestId="create-agent-prompt"
          // One line taller on phones: the typewriter placeholder wraps to
          // three lines in a narrow composer, which reads as already full.
          textareaClassName="min-h-[80px] sm:min-h-[60px]"
          leftActions={(
            <ComposerOptions state={composerOptions} disabled={isDisabled} />
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

      {/* No aid chips here: browsing lives in the roster below, the
          composer's mic covers voice, and importing is the roster's own
          final tile. The outer div is the flex layout box (and reveal-
          animation item); the scroll viewport inside it is absolute so it can
          extend `composerOverlap` px above the box — behind the glass —
          without shifting the flex layout. The 2px side padding gives hovered
          cards' lift shadow room inside the scroller instead of clipping at
          its edge. */}
      <div {...itemProps(160, 70, 'relative z-0 min-h-0 flex-[5_1_0%]')}>
        <div
          // Scrollbar hidden: it would run up behind the glass composer and
          // fade oddly through the edge masks. Trackpad/wheel and the cards'
          // own tab-into-view scrolling still work; the fade bands are the
          // "there's more" signal.
          onScroll={(e) => {
            const scrolled = e.currentTarget.scrollTop > 4
            setRosterScrolled((current) => (current === scrolled ? current : scrolled))
          }}
          className="absolute -left-2 -right-2 bottom-0 overflow-y-auto px-2 pb-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{
            top: -composerOverlap,
            paddingTop: composerOverlap + ROSTER_TOP_GAP_PX,
            maskImage: ROSTER_FADE_MASK,
            WebkitMaskImage: ROSTER_FADE_MASK,
          }}
        >
          <CreateAgentTemplates
            onSelect={handleTemplateSelected}
            onNavigateAway={onNavigateAway}
            onImportClick={handleImportClick}
          />
        </div>
      </div>

      <TemplateInstallDialog
        template={templateToInstall}
        onClose={() => setTemplateToInstall(null)}
        onInstalled={(agent) => finishCreatedAgent(agent, 'skillset')}
      />

      <ImportAgentDialog
        open={showImportDialog}
        onClose={() => setShowImportDialog(false)}
        onComplete={handleImportComplete}
      />
    </div>
  )
}
