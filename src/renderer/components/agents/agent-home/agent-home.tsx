import { SidebarMemberIndicator } from '@renderer/components/agents/sidebar-member-indicator'
import { useState, useRef, useMemo, useCallback, useEffect, useLayoutEffect } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ArrowUp, ChevronDown, Loader2, Eye, Maximize2, Minimize2, MoreHorizontal, Search } from 'lucide-react'
import { useSessions } from '@renderer/hooks/use-sessions'
import { agentAvatarState } from '@shared/lib/types/agent-activity-status'
import { AgentIdentityEditor, type AgentIdentityEditorHandle } from '@renderer/components/agents/agent-avatar/agent-identity-editor'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { useScheduledTasks } from '@renderer/hooks/use-scheduled-tasks'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { VoiceModeButton } from '@renderer/components/ui/voice-mode-button'
import { readAloud } from '@renderer/lib/voice/services/read-aloud'
import { VOICE_MODE_ENTERED_MESSAGE } from '@shared/lib/voice/voice-mode-messages'
import { UploadError } from '@renderer/components/ui/upload-error'
import { AgentRuntimeErrorView } from '@shared/lib/agent-runtime-errors/agent-runtime-error-view'
import { RelatedSessions, toSessionItem, type SortOrder } from '@renderer/components/sessions/related-sessions'
import { SortPopover } from '@renderer/components/sessions/sort-popover'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { useNavTransient } from '@renderer/context/nav-transient-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { useNavigate } from '@tanstack/react-router'
import { useUser } from '@renderer/context/user-context'
import { AgentSharePopover, type AgentSharePopoverHandle } from '@renderer/components/agents/agent-share-popover'
import { AgentContextMenu } from '@renderer/components/agents/agent-context-menu'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'
import { MountChoiceDialog } from '@renderer/components/ui/mount-choice-dialog'
import { useNewSessionComposer } from '@renderer/hooks/use-new-session-composer'
import { ChatComposerBox } from '@renderer/components/messages/chat-composer-box'
import { useIsMobile } from '@renderer/hooks/use-mobile'
import { ComposerOptions } from '@renderer/components/messages/composer-options'
import { AgentDefaultFooter } from '@renderer/components/messages/agent-default-footer'
import { HOME_GLASS_COMPOSER_CLASS, HomeGlassPanel } from './home-glass-panel'
import { HomeHalftoneBackdrop } from './home-halftone-backdrop'
import { ContentBackdrop } from '@renderer/components/layout/content-shell'
import { HomeSidePanel, SIDE_PANEL_BESIDE_PAGE } from './home-side-panel'
import { useMediaQuery } from '@renderer/hooks/use-media-query'
import { HomeBookmarks } from './home-bookmarks'
import { AgentSettingsColumn } from './agent-settings-column'
import { useRefreshWidgetsOnVisit } from '@renderer/hooks/use-widgets'
import { useDeleteAgent, type ApiAgent } from '@renderer/hooks/use-agents'
import { AgentCreationAids, type ImportResult } from '@renderer/components/agents/agent-creation-aids'
import { useStartOnboardingSession } from '@renderer/hooks/use-start-onboarding-session'
import {
  useTypewriterPlaceholder,
  DEFAULT_AGENT_PROMPT_EXAMPLES,
  DISABLED as TYPEWRITER_DISABLED,
} from '@renderer/hooks/use-typewriter-placeholder'
import { UNTITLED_AGENT_NAME } from '@renderer/hooks/use-create-untitled-agent'
import { useRenameUntitledAgent } from '@renderer/hooks/use-rename-untitled-agent'
import { useWarmStartOnType } from '@renderer/hooks/use-warm-start-on-type'
import { useWarmStartOnTypeEnabled } from '@renderer/hooks/use-settings'
import { useRenderTracker } from '@renderer/lib/perf'
import { formatDistanceToNow } from 'date-fns'
import { useNewSessionCarryover } from '@renderer/lib/new-session-carryover'
import { useDraftsStore } from '@renderer/context/drafts-context'
import { completeAgentTemplateHandoff } from '@renderer/lib/agent-template-handoff'
import { ScrollAwarePageTitle } from '@renderer/components/layout/scroll-aware-title'

interface AgentHomeProps {
  agent: ApiAgent
  onSessionCreated: (sessionId: string, initialMessage: string, messageUuid: string, options?: { voiceMode?: boolean }) => void
}

/** Recent sessions shows the latest few, as Team Brain's home does; See all sessions opens the rest in place. */
const RECENT_SESSIONS = 3
/** How many of all its sessions show at once, opened in place. */
const ALL_SESSIONS_PAGE = 5

export function AgentHome({ agent, onSessionCreated }: AgentHomeProps) {
  useRenderTracker('AgentHome')
  // The new-agent morph tag lives in NavTransientContext — above the router, so
  // it survives in-app nav and dies on hard reload. justCreatedSlug producer =
  // use-create-untitled-agent.
  const { justCreatedSlug, setJustCreatedSlug, pendingAgentHomeAction, setPendingAgentHomeAction } = useNavTransient()
  const { openFolder } = useFilePreview()
  const navigate = useNavigate()
  const [introStagger] = useState(() => {
    if (justCreatedSlug !== agent.slug) return false
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  const [introPlaying, setIntroPlaying] = useState(!introStagger)
  useEffect(() => {
    if (!introStagger) return
    const t = setTimeout(() => setIntroPlaying(true), 1000)
    return () => clearTimeout(t)
  }, [introStagger])
  // One-shot: consume the morph tag immediately once introStagger has captured it
  // at mount, so it can't replay if AgentHome unmounts mid-animation — e.g. the
  // user sends the first message within ~2s, the index leaf unmounts, and a
  // deferred clear would be cancelled, stranding the tag and re-animating on
  // return. The animation runs off local introStagger/introPlaying state.
  useEffect(() => {
    if (introStagger) setJustCreatedSlug(null)
  }, [introStagger, setJustCreatedSlug])
  const startOnboardingSession = useStartOnboardingSession()
  const draftsStore = useDraftsStore()
  const { canUseAgent, canAdminAgent, isAuthMode, isAdmin, agentMemberCount } = useUser()
  const showSessionParticipants = isAuthMode && agentMemberCount(agent.slug) > 1
  const isViewOnly = !canUseAgent(agent.slug)
  const isOwner = canAdminAgent(agent.slug)
  useRefreshWidgetsOnVisit(isOwner ? agent.slug : null)
  const [isExpanded, setIsExpanded] = useState(false)
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false)
  const [allSessions, setAllSessions] = useState(false)
  const [sessionSearch, setSessionSearch] = useState('')
  const [sessionSort, setSessionSort] = useState<SortOrder>('newest')
  const { data: sessionsData } = useSessions(agent.slug)
  const carryover = useNewSessionCarryover(agent.slug)
  const sessionSearchRef = useRef<HTMLInputElement>(null)
  const composerTextareaRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()
  const { track } = useAnalyticsTracking()
  // Tracks an explicit user collapse so the auto-expand effect doesn't fight it.
  // Reset when the message clears (e.g. after submit).
  const userCollapsedRef = useRef(false)
  const deleteAgent = useDeleteAgent()
  const renameUntitledAgent = useRenameUntitledAgent()
  const identityRef = useRef<AgentIdentityEditorHandle>(null)
  // The three-dot button opens the title's context menu (see below).
  const menuTriggerRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const shareRef = useRef<AgentSharePopoverHandle>(null)
  const openExport = useCallback(() => shareRef.current?.openExport(), [])
  // Same panel the HomeExtras "Agent Directory" row opens.
  const openDirectory = useCallback(() => openFolder('/workspace', agent.slug), [openFolder, agent.slug])

  // "Export Agent" / "Agent Directory" chosen from a menu away from this page
  // (sidebar row, home card, breadcrumb) navigates here with the action
  // parked in NavTransient; run it now that its surface is mounted.
  //
  // Not synchronously, though: the composer below focuses itself on the
  // animation frame after it mounts (see MarkdownComposerEditor's autoFocus),
  // and the Share popover is non-modal, so if it opens before that frame the
  // composer's focus lands outside it and Radix dismisses it as an outside
  // interaction. Whether the popover or the focus came first depended on how
  // this page mounted, which made "Export Agent" from the sidebar flaky.
  // Frame callbacks run in the order they were requested, so deferring the
  // action by one frame always puts it after that autofocus. No cleanup on
  // purpose: clearing the parked action re-runs this effect, and cancelling
  // the frame there would drop the action.
  useEffect(() => {
    if (pendingAgentHomeAction?.slug !== agent.slug) return
    const { action } = pendingAgentHomeAction
    setPendingAgentHomeAction(null)
    requestAnimationFrame(() => {
      if (action === 'export') openExport()
      else openDirectory()
    })
  }, [pendingAgentHomeAction, agent.slug, setPendingAgentHomeAction, openExport, openDirectory])
  const sessions = useMemo(() => {
    if (!Array.isArray(sessionsData)) return []
    return sessionsData.map(toSessionItem)
  }, [sessionsData])

  const { data: scheduledTasksData } = useScheduledTasks(agent.slug, 'pending')
  const scheduledTasks = useMemo(() => Array.isArray(scheduledTasksData) ? scheduledTasksData : [], [scheduledTasksData])

  const { data: runtimeStatus, isPending: isRuntimePending } = useRuntimeStatus()
  const readiness = runtimeStatus?.runtimeReadiness
  const isRuntimeReady = isRuntimePending || readiness?.status === 'READY'
  const isPulling = readiness?.status === 'PULLING_IMAGE'
  const apiKeyConfigured = runtimeStatus?.apiKeyConfigured !== false

  const { composer, composerOptions, createSession, isDisabled } = useNewSessionComposer({
    agentSlug: agent.slug,
    draftKey: `agent:${agent.slug}`,
    initialAttachments: carryover?.attachments,
    initialOptions: {
      initialModel: carryover?.model,
      initialEffort: carryover?.effort,
      initialSpeed: carryover?.speed,
    },
    // The default-model card sits next to this composer; untouched selections track its edits.
    followDefaults: true,
    submitDisabled: !isRuntimeReady,
    agentRuntimeErrorsShownInline: true,
    onSessionCreated: ({ session, content }) => {
      // Preserve the server's message identity for the optimistic pending copy.
      onSessionCreated(session.id, content, session.initialMessageUuid)
      // This mutation survives navigation because its query client is app-scoped.
      if (agent.name === UNTITLED_AGENT_NAME && sessions.length === 0) {
        renameUntitledAgent.mutate({ slug: agent.slug, prompt: content })
      }
    },
  })

  const warmStartEnabled = useWarmStartOnTypeEnabled()
  const { noteProgrammaticChange } = useWarmStartOnType({
    agentSlug: agent.slug,
    message: composer.message,
    enabled: warmStartEnabled,
  })

  // Reset the manual-collapse flag once the message clears.
  useEffect(() => {
    if (composer.message.trim() === '') userCollapsedRef.current = false
  }, [composer.message])

  // Auto-flip to expanded when the textarea content overflows its max-height
  // (CSS-driven 6-line cap). field-sizing handles the actual sizing — this only
  // decides whether to switch into the full-view layout.
  useEffect(() => {
    const el = composerTextareaRef.current
    if (!el || isExpanded || userCollapsedRef.current) return
    if (el.scrollHeight > el.clientHeight) {
      setIsExpanded(true)
    }
  }, [composer.message, isExpanded])

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (!composer.canSubmit) return
      void composer.handleSubmit(e)
    }
  }

  // Voice mode from the home page: the session opens with the voice-mode
  // notice as its first message, and its composer comes up listening. The
  // composer button and the empty-state "Brainstorm with Voice" card both land here.
  const startVoiceSession = useCallback(async (origin: 'home' | 'home_card') => {
    if (isDisabled) return
    // Audio output is unlocked here, inside the click, for the reply to use.
    readAloud.unlockAudio()
    try {
      const session = await createSession.mutateAsync({
        agentSlug: agent.slug,
        message: VOICE_MODE_ENTERED_MESSAGE,
        inputMode: 'voice',
        ...composerOptions.toRuntimeOptions(),
      })
      onSessionCreated(session.id, VOICE_MODE_ENTERED_MESSAGE, session.initialMessageUuid, { voiceMode: true })
      track('voice_mode_entered', { origin })
    } catch (error) {
      console.error('Failed to start a voice session:', error)
      readAloud.releaseUnlockedAudio()
      track('voice_mode_start_failed', { origin })
    }
  }, [isDisabled, createSession, agent.slug, composerOptions, onSessionCreated, track])

  const isFreshUntitled = agent.name === UNTITLED_AGENT_NAME && sessions.length === 0
  const typewriterPlaceholder = useTypewriterPlaceholder(
    isFreshUntitled ? DEFAULT_AGENT_PROMPT_EXAMPLES : TYPEWRITER_DISABLED,
  )
  const composerPlaceholder = isFreshUntitled
    ? typewriterPlaceholder
    : 'How can I help? Press cmd+enter to send'

  const handleImportComplete = useCallback(
    async (imported: ImportResult) => {
      await completeAgentTemplateHandoff({
        draftsStore,
        agentSlug: imported.slug,
        hasOnboarding: imported.hasOnboarding,
        templatePrompt: imported.templatePrompt,
        onboardingFirstPrompt: imported.onboardingFirstPrompt,
        noteProgrammaticChange,
        openAgent: () => {
          void navigate({ to: '/agents/$slug', params: { slug: imported.slug } })
          if (agent.name === UNTITLED_AGENT_NAME && sessions.length === 0 && agent.slug !== imported.slug) {
            deleteAgent.mutate(agent.slug)
          }
        },
        startOnboardingSession,
      })
    },
    [draftsStore, noteProgrammaticChange, navigate, agent.slug, agent.name, sessions.length, deleteAgent, startOnboardingSession],
  )

  const formatDate = useCallback(
    (dateStr: string) => formatDistanceToNow(new Date(dateStr), { addSuffix: true }),
    [],
  )

  const showSidePanel = isOwner

  // The side panel (widgets, sections, the Show more settings) is always there: beside the page from xl, and narrower, below
  // the page's own content, where there is no room beside it.
  const wide = useMediaQuery(SIDE_PANEL_BESIDE_PAGE)
  const sidePanelBeside = showSidePanel && wide

  // Beside the page, the panel's top edge lines up with the top edge of the title row's buttons (they sit centred in
  // that row, so a little below its top): the agent menu button's offset in the page's column, measured.
  const columnRef = useRef<HTMLDivElement>(null)
  const agentMenuButtonRef = useRef<HTMLButtonElement>(null)
  const [panelTop, setPanelTop] = useState(0)
  useLayoutEffect(() => {
    const column = columnRef.current
    const button = agentMenuButtonRef.current
    if (!column || !button) return
    const measure = () => setPanelTop(Math.round(button.getBoundingClientRect().top - column.getBoundingClientRect().top))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(column)
    return () => observer.disconnect()
  }, [sidePanelBeside])

  const lastActiveAt = useMemo(
    // A session without activity yet counts from its creation, as the sessions list shows it.
    () => sessions.reduce<string | null>((latest, s) => {
      const at = s.lastActivityAt ?? s.createdAt
      return !latest || at > latest ? at : latest
    }, null),
    [sessions],
  )

  const sidePanelContent = (
    <AgentSettingsColumn agent={agent} scheduledTasks={scheduledTasks} onRunSkill={(skillPath) => {
      composer.setMessage(`/${skillPath} `)
      composerTextareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setTimeout(() => composerTextareaRef.current?.focus(), 0)
    }} />
  )
  const lastActive = lastActiveAt ? (
    <span data-testid="agent-home-last-active">Last active {formatDate(lastActiveAt)}</span>
  ) : undefined

  return (
    <>
    {/* The background sits behind the scrolling page, and the header's glass above it, and stays put while the page scrolls. Its white buttons are glass. */}
    <div className="home-glass-controls relative flex min-h-0 min-w-0 flex-1 flex-col">
    <ContentBackdrop><HomeHalftoneBackdrop agent={agent} /></ContentBackdrop>
    <div
      data-testid="agent-home"
      // Surfaces the one-shot new-agent intro state for tests/debugging without
      // coupling to CSS classes: absent when no morph, 'pending' while the
      // "Creating" beat holds, 'playing' once the staggered slide-in runs.
      data-intro={introStagger ? (introPlaying ? 'playing' : 'pending') : undefined}
      className={cn(
        'relative min-h-0 flex-1 flex flex-col overflow-y-auto overscroll-contain px-4 py-6 md:px-10 md:py-10',
        introStagger && 'agent-home-intro',
        introPlaying && 'intro-play'
      )}
    >
      {introStagger && !introPlaying && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Creating
          </div>
        </div>
      )}
      {/* Team Brain's home-page layout: one column the composer's width, centred in the page; the side panel opens
          beside it from xl, the column making room on the right while the page stays where it is. */}
      <div data-testid="agent-home-layout" className="mx-auto min-w-0 w-full max-w-[1040px]">
        <div ref={columnRef} className={cn(sidePanelBeside && 'flex items-start gap-8')}>
          <div className="mx-auto w-full min-w-0 max-w-[720px] space-y-6">
            <div>
            <ScrollAwarePageTitle className="home-title-row flex items-center justify-between gap-2 intro-step intro-step-1">
              <AgentContextMenu
                agent={agent}
                onRename={() => identityRef.current?.open()}
                onExport={openExport}
                onOpenDirectory={openDirectory}
                onOpenChange={setMenuOpen}
              >
                <div ref={menuTriggerRef} className="flex min-w-0 flex-1 items-center cursor-context-menu">
                  {isOwner ? (
                    <AgentIdentityEditor
                      ref={identityRef}
                      agent={agent}
                      state={agentAvatarState(agent, sessionsData)}
                      size={39}
                      nameClassName="text-lg/6 font-medium"
                      subtitle={lastActive}
                    />
                  ) : (
                    <div className="flex min-w-0 items-center gap-2">
                      <AgentAvatar agent={agent} state={agentAvatarState(agent, sessionsData)} size={39} />
                      <div className="min-w-0">
                        <h1 className="truncate text-lg/6 font-medium" data-testid="agent-name">{agent.name}</h1>
                        <div className="truncate text-xs text-muted-foreground">{lastActive}</div>
                      </div>
                    </div>
                  )}
                </div>
              </AgentContextMenu>
              {/* The sidebar row's member stack and roster, a size up. */}
              {isAuthMode && (
                <SidebarMemberIndicator
                  variant="page"
                  agentSlug={agent.slug}
                  agentName={agent.name}
                  memberCount={agentMemberCount(agent.slug)}
                  maxFaces={5}
                />
              )}
              {(isOwner || (isAuthMode && isAdmin)) && <AgentSharePopover ref={shareRef} agentSlug={agent.slug} agentName={agent.name} />}
              {/* The same agent menu a right-click on the title (or the sidebar row) opens, so the two never drift apart.
                  A click replays as a contextmenu event on the title's trigger, anchored under this button; Rename
                  opens the name and avatar editor. */}
              <Button
                ref={agentMenuButtonRef}
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label="Agent menu"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                data-testid="agent-settings-button"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  menuTriggerRef.current?.dispatchEvent(
                    new MouseEvent('contextmenu', {
                      bubbles: true,
                      cancelable: true,
                      clientX: rect.left,
                      clientY: rect.bottom + 4,
                    })
                  )
                }}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </ScrollAwarePageTitle>
            </div>
            {isViewOnly ? (
              <div className="flex items-center justify-center gap-2 text-sm font-medium text-muted-foreground border rounded-card p-6" data-testid="view-only-banner">
                <Eye className="h-5 w-5" />
                <span>Select a session from the sidebar to view its messages</span>
              </div>
            ) : (
              <>
                {!apiKeyConfigured && (
                  <div className="flex items-center justify-center gap-2 text-sm font-medium text-muted-foreground">
                    <span>No API key configured. An administrator needs to set up the LLM API key.</span>
                  </div>
                )}
                {!isRuntimeReady && readiness && (
                  <div className="flex items-center justify-center gap-2 text-sm font-medium text-muted-foreground">
                    {isPulling && <Loader2 className="h-4 w-4 animate-spin" />}
                    <span>{readiness.message}</span>
                    {readiness.pullProgress?.percent != null && (
                      <span>({readiness.pullProgress.status} - {readiness.pullProgress.percent}%)</span>
                    )}
                  </div>
                )}

                <MountChoiceDialog
                  open={composer.mountDialog.open}
                  onChoice={composer.mountDialog.onChoice}
                  folderName={composer.mountDialog.folderName}
                />
                {composer.chipDialog}
                  <form
                    onSubmit={composer.handleSubmit}
                    className={cn('intro-step intro-step-2', composer.isDragOver && 'rounded-dialog ring-2 ring-primary ring-inset')}
                    {...composer.dragHandlers}
                  >
                    <ChatComposerBox
                      // The session composer's glass with the panels' glass edge: the sessions pass under it once it docks.
                      className={HOME_GLASS_COMPOSER_CLASS}
                      textareaRef={composerTextareaRef}
                      attachments={composer.attachments}
                      onRemoveAttachment={composer.removeAttachment}
                      onRetryAttachment={composer.retryAttachment}
                      value={composer.message}
                      onChange={composer.setMessage}
                      onKeyDown={handleKeyDown}
                      onPaste={composer.handlePaste}
                      placeholder={composerPlaceholder}
                      disabled={isDisabled}
                      rows={2}
                      autoFocus={!isMobile}
                      dataTestId="home-message-input"
                      secureSecrets={{
                        agentSlug: agent.slug,
                        potentialSecrets: composer.potentialSecrets,
                        onDismiss: composer.dismissPotentialSecret,
                        onSecure: composer.securePotentialSecret,
                      }}
                      chipContext={composer.chipContext}
                      textareaClassName={`transition-[min-height] duration-300 ease-in-out ${isExpanded ? 'min-h-[50vh] max-h-[50vh]' : 'min-h-[40px] max-h-[120px]'}`}
                      leftActions={(
                        <>
                          <AttachmentPicker
                            buttonClassName="h-7 w-7 shrink-0 p-0"
                            onFileSelect={composer.handleFileSelect}
                            onFolderSelect={composer.handleFolderSelect}
                            onRecentFileAttach={(file) => composer.addFiles([{ file }])}
                            disabled={isDisabled}
                          />
                          <ComposerOptions
                            state={composerOptions}
                            disabled={isDisabled}
                            size="sm"
                            footer={
                              <AgentDefaultFooter
                                agentSlug={agent.slug}
                                state={composerOptions}
                                agentHomeLink={false}
                              />
                            }
                          />
                        </>
                      )}
                      topRightActions={(
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 text-muted-foreground/50 hover:text-foreground"
                          onClick={() => setIsExpanded((v) => {
                            // If user is collapsing, remember it so the auto-expand
                            // effect doesn't immediately re-flip a still-overflowing message.
                            userCollapsedRef.current = v
                            return !v
                          })}
                          aria-label={isExpanded ? 'Shrink input' : 'Expand input'}
                        >
                          {isExpanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                        </Button>
                      )}
                      rightActions={(
                        <>
                          <VoiceInputButton voiceInput={composer.voiceInput} message={composer.message} disabled={isDisabled} size="compact" />
                          {!isFreshUntitled && (
                            <VoiceModeButton onClick={() => void startVoiceSession('home')} disabled={isDisabled} className="h-7 w-7" />
                          )}
                          {isFreshUntitled ? (
                            <Button
                              type="submit"
                              size="sm"
                              className="ml-1.5 h-7"
                              disabled={!composer.canSubmit}
                              data-testid="home-send-button"
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
                          ) : (
                            <Button
                              type="submit"
                              size="icon"
                              // 6px before it: the plain buttons' own 6px padding is the rest of the gap (chat-composer-box.tsx).
                              className="ml-1.5 h-7 w-7"
                              disabled={!composer.canSubmit}
                              data-testid="home-send-button"
                              aria-label="Send message"
                            >
                              {isDisabled ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <ArrowUp className="h-4 w-4" />
                              )}
                            </Button>
                          )}
                        </>
                      )}
                      footer={(
                        <>
                          <VoiceInputError error={composer.voiceInput.error} onDismiss={composer.voiceInput.clearError} className="mt-2 justify-center" />
                          <UploadError error={composer.uploadError} onDismiss={composer.clearUploadError} className="mt-2 justify-center" />
                          <AgentRuntimeErrorView error={createSession.error} className="mt-2" />
                        </>
                      )}
                    />
                  </form>

                <div className="space-y-6 intro-step intro-step-3">
                  {sessions.length > 0 ? (
                    <HomeGlassPanel
                      title="Recent sessions"
                      testId="home-recent-sessions"
                      actions={(
                        <>
                          {sessionSearchOpen && (
                            <Input
                              ref={sessionSearchRef}
                              value={sessionSearch}
                              onChange={(e) => setSessionSearch(e.target.value)}
                              placeholder="Filter sessions..."
                              className="h-6 w-40 text-xs"
                            />
                          )}
                          <SortPopover value={sessionSort} onChange={setSessionSort} ariaLabel="Sort sessions" />
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 shrink-0"
                            onClick={() => {
                              const next = !sessionSearchOpen
                              setSessionSearchOpen(next)
                              if (!next) setSessionSearch('')
                              else setTimeout(() => sessionSearchRef.current?.focus(), 0)
                            }}
                            aria-label="Search sessions"
                          >
                            <Search className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        </>
                      )}
                    >
                      <RelatedSessions
                        sessions={sessions}
                        agentSlug={agent.slug}
                        formatDate={formatDate}
                        showIcon={false}
                        showHeader={false}
                        searchQuery={sessionSearch}
                        sortOrder={sessionSort}
                        showParticipants={showSessionParticipants}
                        // A search looks through every session, a page at a time.
                        pageSize={allSessions || sessionSearch ? ALL_SESSIONS_PAGE : RECENT_SESSIONS}
                        limit={allSessions || sessionSearch ? undefined : RECENT_SESSIONS}
                        className="mt-1"
                        // Right under the last row, its text lined up with the rows'.
                        afterRows={!sessionSearch && sessions.length > RECENT_SESSIONS && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="-ml-2 mt-1"
                            onClick={() => setAllSessions(!allSessions)}
                            aria-expanded={allSessions}
                            data-testid="home-see-all-sessions"
                          >
                            {allSessions ? 'Show fewer' : 'See all sessions'}
                            <ChevronDown className={cn('transition-transform', allSessions && 'rotate-180')} aria-hidden="true" />
                          </Button>
                        )}
                      />
                    </HomeGlassPanel>
                  ) : (
                    <AgentCreationAids
                      onStartVoiceMode={() => void startVoiceSession('home_card')}
                      onImportComplete={handleImportComplete}
                    />
                  )}
                  {/* Bookmarks get a panel of their own, when there are any. */}
                  <HomeBookmarks agentSlug={agent.slug} isOwner={isOwner} />
                  {/* Narrower than xl there is no room beside the page, so the side panel's cards follow its content. */}
                  {showSidePanel && !wide && <HomeSidePanel placement="below">{sidePanelContent}</HomeSidePanel>}
                </div>
              </>
            )}
          </div>

          {sidePanelBeside && (
            // Beside the page, top-aligned with the title row's buttons; it scrolls with the page rather than on its own.
            <div className="w-[336px] shrink-0" style={{ marginTop: panelTop }}>
              <HomeSidePanel placement="beside">{sidePanelContent}</HomeSidePanel>
            </div>
          )}
        </div>
      </div>
    </div>
    </div>

    </>
  )
}
