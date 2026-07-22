
import { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ArrowUp, Loader2, Eye, Settings2, Maximize2, Minimize2, Search } from 'lucide-react'
import { useCreateSession, useSessions } from '@renderer/hooks/use-sessions'
import { useScheduledTasks } from '@renderer/hooks/use-scheduled-tasks'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { UploadError } from '@renderer/components/ui/upload-error'
import { RelatedSessions, type SortOrder } from '@renderer/components/sessions/related-sessions'
import { SortPopover } from '@renderer/components/sessions/sort-popover'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { useNavTransient } from '@renderer/context/nav-transient-context'
import { useNavigate } from '@tanstack/react-router'
import { useUser } from '@renderer/context/user-context'
import { AgentSettingsDialog } from '@renderer/components/agents/agent-settings-dialog'
import { AgentContextMenu } from '@renderer/components/agents/agent-context-menu'
import { SystemPromptDialog } from '@renderer/components/agents/system-prompt-dialog'
import { toast } from 'sonner'
import { apiFetch } from '@renderer/lib/api'
import { uploadFileChunked } from '@renderer/lib/upload'
import { AttachmentPicker } from '@renderer/components/ui/attachment-picker'
import { MountChoiceDialog } from '@renderer/components/ui/mount-choice-dialog'
import { useMessageComposer } from '@renderer/hooks/use-message-composer'
import { ChatComposerBox } from '@renderer/components/messages/chat-composer-box'
import { useIsMobile } from '@renderer/hooks/use-mobile'
import { ComposerOptions, useComposerOptions } from '@renderer/components/messages/composer-options'
import { InlineEditableTitle } from '@renderer/components/ui/inline-editable-title'
import { HomeTriggers } from './home-triggers'
import { HomeSkills } from './home-skills'
import { HomeDefaultModel } from './home-default-model'
import { HomeExtras } from './home-extras'
import { HomeConnections } from './home-connections'
import { HomeChatIntegrations } from './home-chat-integrations'
import { HomeVolumes } from './home-volumes'
import { HomeHooks } from './home-hooks'
import { HomeBookmarks } from './home-bookmarks'
import { DashboardCard } from '@renderer/components/home/dashboard-card'
import { useUpdateAgent, useDeleteAgent, type ApiAgent } from '@renderer/hooks/use-agents'
import { useAgentPreferences } from '@renderer/hooks/use-agent-preferences'
import { AgentCreationAids, type ImportResult } from '@renderer/components/agents/agent-creation-aids'
import { useStartOnboardingSession } from '@renderer/hooks/use-start-onboarding-session'
import {
  useTypewriterPlaceholder,
  DEFAULT_AGENT_PROMPT_EXAMPLES,
  DISABLED as TYPEWRITER_DISABLED,
} from '@renderer/hooks/use-typewriter-placeholder'
import { UNTITLED_AGENT_NAME } from '@renderer/hooks/use-create-untitled-agent'
import { useRenameUntitledAgent } from '@renderer/hooks/use-rename-untitled-agent'
import { useRenderTracker } from '@renderer/lib/perf'
import { formatDistanceToNow } from 'date-fns'
import { useNewSessionCarryover } from '@renderer/lib/new-session-carryover'

interface AgentHomeProps {
  agent: ApiAgent
  onSessionCreated: (sessionId: string, initialMessage: string, messageUuid: string) => void
}

export function AgentHome({ agent, onSessionCreated }: AgentHomeProps) {
  useRenderTracker('AgentHome')
  // The new-agent morph tag lives in NavTransientContext — above the router, so
  // it survives in-app nav and dies on hard reload. justCreatedSlug producer =
  // use-create-untitled-agent.
  const { justCreatedSlug, setJustCreatedSlug, openAgentSettings, setOpenAgentSettings } = useNavTransient()
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
  const { canUseAgent, canAdminAgent } = useUser()
  const isViewOnly = !canUseAgent(agent.slug)
  const isOwner = canAdminAgent(agent.slug)
  const [isExpanded, setIsExpanded] = useState(false)
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false)
  const [sessionSearch, setSessionSearch] = useState('')
  const [sessionSort, setSessionSort] = useState<SortOrder>('newest')
  const { data: sessionsData } = useSessions(agent.slug)
  const { data: agentPrefs } = useAgentPreferences(agent.slug)
  const carryover = useNewSessionCarryover(agent.slug)
  const composerOptions = useComposerOptions({
    initialModel: carryover?.model,
    initialEffort: carryover?.effort,
    initialSpeed: carryover?.speed,
    agentDefaultModel: agentPrefs?.defaultModel,
    agentDefaultEffort: agentPrefs?.defaultEffort,
    agentDefaultSpeed: agentPrefs?.defaultSpeed,
    agentKey: agent.slug,
    // The default-model card sits next to this composer; an untouched selection
    // must visibly track it, including a reset back to the global default.
    followDefaults: true,
  })
  const sessionSearchRef = useRef<HTMLInputElement>(null)
  const composerTextareaRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()
  // Tracks an explicit user collapse so the auto-expand effect doesn't fight it.
  // Reset when the message clears (e.g. after submit).
  const userCollapsedRef = useRef(false)
  const createSession = useCreateSession()
  const updateAgent = useUpdateAgent()
  const deleteAgent = useDeleteAgent()
  const renameUntitledAgent = useRenameUntitledAgent()
  // Tracks whether a name has already been assigned (e.g. by the voice agent)
  // so the post-submit deriveAgentName fallback doesn't clobber it.
  const nameAssignedRef = useRef(false)
  // Agent-scoped settings dialogs — opened from the settings button and
  // HomeExtras (system-prompt/secrets). NOT the global /settings route; they
  // stay local dialog state here.
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined)
  const [systemPromptOpen, setSystemPromptOpen] = useState(false)
  const handleOpenSettings = useCallback((tab?: string) => {
    if (tab === 'system-prompt') {
      setSystemPromptOpen(true)
      return
    }
    setSettingsTab(tab)
    setSettingsOpen(true)
  }, [])
  // One-shot from NavTransientContext: another page (e.g. the home graph's
  // "edit permissions") navigated here asking for a settings tab. Consume
  // immediately so it can't replay on a later visit — and drop it unacted
  // when stale: an abandoned navigation would otherwise pop the dialog on a
  // much-later organic visit to this agent.
  useEffect(() => {
    if (openAgentSettings?.slug !== agent.slug) return
    if (Date.now() - openAgentSettings.requestedAt < 10_000) {
      handleOpenSettings(openAgentSettings.tab)
    }
    setOpenAgentSettings(null)
  }, [openAgentSettings, agent.slug, handleOpenSettings, setOpenAgentSettings])

  const sessions = useMemo(() => {
    if (!Array.isArray(sessionsData)) return []
    return sessionsData.map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : new Date(s.createdAt).toISOString(),
      isActive: s.isActive,
      isAwaitingInput: s.isAwaitingInput,
      hasUnreadNotifications: s.hasUnreadNotifications,
    }))
  }, [sessionsData])

  const { data: scheduledTasksData } = useScheduledTasks(agent.slug, 'pending')
  const scheduledTasks = useMemo(() => Array.isArray(scheduledTasksData) ? scheduledTasksData : [], [scheduledTasksData])

  const { data: runtimeStatus, isPending: isRuntimePending } = useRuntimeStatus()
  const readiness = runtimeStatus?.runtimeReadiness
  const isRuntimeReady = isRuntimePending || readiness?.status === 'READY'
  const isPulling = readiness?.status === 'PULLING_IMAGE'
  const apiKeyConfigured = runtimeStatus?.apiKeyConfigured !== false

  const composer = useMessageComposer({
    agentSlug: agent.slug,
    uploadFile: useCallback(({ file }: { file: File }) => {
      return uploadFileChunked<{ path: string }>({
        url: `/api/agents/${agent.slug}/upload-file`,
        file,
      })
    }, [agent.slug]),
    uploadFolder: useCallback(async ({ sourcePath }: { sourcePath: string }) => {
      const res = await apiFetch(
        `/api/agents/${agent.slug}/upload-folder`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourcePath }),
        }
      )
      if (!res.ok) throw new Error('Failed to upload folder')
      return res.json() as Promise<{ path: string }>
    }, [agent.slug]),
    onSubmit: useCallback(async (content: string) => {
      const shouldRename =
        agent.name === UNTITLED_AGENT_NAME && sessions.length === 0 && !nameAssignedRef.current
      const session = await createSession.mutateAsync({
        agentSlug: agent.slug,
        message: content,
        ...composerOptions.toRuntimeOptions(),
      })
      // The server assigns the initial message's uuid and returns it; the
      // optimistic pending copy is materialized by exact id match.
      onSessionCreated(session.id, content, session.initialMessageUuid)
      // Fire rename after the session is created + navigated — the mutation
      // survives AgentHome unmounting since the queryClient is app-scoped.
      if (shouldRename) {
        nameAssignedRef.current = true
        renameUntitledAgent.mutate({ slug: agent.slug, prompt: content })
      }
    }, [createSession, agent.slug, agent.name, onSessionCreated, composerOptions, sessions.length, renameUntitledAgent]),
    submitDisabled: createSession.isPending || !isRuntimeReady,
    keepMessageUntilComplete: true,
    draftKey: `agent:${agent.slug}`,
    initialAttachments: carryover?.attachments,
    initialSecuredSecrets: carryover?.securedSecrets,
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
      void composer.handleSubmit(e)
    }
  }

  const isDisabled = createSession.isPending || composer.isUploading || !isRuntimeReady

  const isFreshUntitled = agent.name === UNTITLED_AGENT_NAME && sessions.length === 0
  const typewriterPlaceholder = useTypewriterPlaceholder(
    isFreshUntitled ? DEFAULT_AGENT_PROMPT_EXAMPLES : TYPEWRITER_DISABLED,
  )
  const composerPlaceholder = isFreshUntitled
    ? typewriterPlaceholder
    : 'How can I help? Press cmd+enter to send'

  const handleVoiceResult = useCallback(
    ({ name, prompt }: { name: string; prompt: string }) => {
      if (prompt) composer.setMessage(prompt)
      if (name && agent.name === UNTITLED_AGENT_NAME) {
        nameAssignedRef.current = true
        updateAgent.mutate({ slug: agent.slug, name })
      }
    },
    [composer, agent.name, agent.slug, updateAgent],
  )

  const handleImportComplete = useCallback(
    async ({ agent: imported, hasOnboarding }: ImportResult) => {
      void navigate({ to: '/agents/$slug', params: { slug: imported.slug } })
      if (agent.name === UNTITLED_AGENT_NAME && sessions.length === 0 && agent.slug !== imported.slug) {
        deleteAgent.mutate(agent.slug)
      }
      if (hasOnboarding) {
        await startOnboardingSession(imported.slug)
      }
    },
    [navigate, agent.slug, agent.name, sessions.length, deleteAgent, startOnboardingSession],
  )

  const formatDate = useCallback(
    (dateStr: string) => formatDistanceToNow(new Date(dateStr), { addSuffix: true }),
    [],
  )

  const showRightColumn = isOwner

  return (
    <>
    <div
      data-testid="agent-home"
      // Surfaces the one-shot new-agent intro state for tests/debugging without
      // coupling to CSS classes: absent when no morph, 'pending' while the
      // "Creating" beat holds, 'playing' once the staggered slide-in runs.
      data-intro={introStagger ? (introPlaying ? 'playing' : 'pending') : undefined}
      className={cn(
        'flex-1 flex flex-col overflow-y-auto overscroll-contain px-4 py-6 md:px-10 md:py-10 bg-background',
        introStagger && 'agent-home-intro relative',
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
      <div
        data-testid="agent-home-layout"
        className={cn(
          'grid gap-10 items-start w-full mx-auto',
          showRightColumn
            ? 'grid-cols-1 max-w-6xl xl:grid-cols-[1fr_minmax(320px,400px)]'
            : 'xl:max-w-2xl',
        )}
      >
        {/* Left Column — Chat composer + Sessions */}
        <div className="space-y-6 w-full min-w-0 xl:min-w-[480px] xl:max-w-[720px]">
          <div className="flex items-center justify-between gap-2 intro-step intro-step-1">
            <AgentContextMenu agent={agent}>
              <div className="flex-1 min-w-0 cursor-context-menu">
                <InlineEditableTitle
                  value={agent.name}
                  canEdit={isOwner}
                  isSaving={updateAgent.isPending}
                  onSave={async (name) => {
                    await updateAgent.mutateAsync({ slug: agent.slug, name })
                  }}
                  onError={(error) => {
                    console.error('Failed to rename agent:', error)
                    toast.error('Failed to rename agent', {
                      description: error instanceof Error ? error.message : 'Please try again.',
                    })
                  }}
                  displayClassName="text-xl font-semibold"
                  inputClassName="h-9 text-xl font-semibold"
                  saveButtonClassName="h-8 w-8"
                  ariaLabel="Rename agent"
                  saveAriaLabel="Save name"
                  displayTestId="agent-name"
                  inputTestId="agent-name-input"
                  saveButtonTestId="agent-name-save"
                />
              </div>
            </AgentContextMenu>
            {/* AgentHome owns the settings dialog (no onOpenSettings prop), so the
                gear opens the local handler rather than a parent-supplied one. */}
            <Button type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={() => handleOpenSettings()} aria-label="Agent settings" data-testid="agent-settings-button">
              <Settings2 className="h-4 w-4" />
            </Button>
          </div>
          {isViewOnly ? (
            <div className="flex items-center justify-center gap-2 text-sm font-medium text-muted-foreground border rounded-lg p-6" data-testid="view-only-banner">
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
              <form
                onSubmit={composer.handleSubmit}
                className={cn('intro-step intro-step-2', composer.isDragOver && 'rounded-2xl ring-2 ring-primary ring-inset')}
                {...composer.dragHandlers}
              >
                <ChatComposerBox
                  textareaRef={composerTextareaRef}
                  attachments={composer.attachments}
                  onRemoveAttachment={composer.removeAttachment}
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
                    securedSecrets: composer.securedSecrets,
                    onDismiss: composer.dismissPotentialSecret,
                    onSecure: composer.securePotentialSecret,
                    onRemove: composer.removeSecuredSecrets,
                  }}
                  textareaClassName={`transition-[min-height] duration-300 ease-in-out ${isExpanded ? 'min-h-[50vh] max-h-[50vh]' : 'min-h-[60px] max-h-[120px]'}`}
                  leftActions={(
                    <>
                      <AttachmentPicker
                        onFileSelect={composer.handleFileSelect}
                        onFolderSelect={composer.handleFolderSelect}
                        onRecentFileAttach={(file) => composer.addFiles([{ file }])}
                        disabled={isDisabled}
                      />
                      <ComposerOptions state={composerOptions} disabled={isDisabled} />
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
                      <VoiceInputButton voiceInput={composer.voiceInput} message={composer.message} disabled={isDisabled} />
                      {isFreshUntitled ? (
                        <Button
                          type="submit"
                          size="sm"
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
                          className="h-[34px] w-[34px]"
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
                    </>
                  )}
                />
              </form>

              <div className="space-y-6 intro-step intro-step-3">
              {/* Bookmarks */}
              <HomeBookmarks agentSlug={agent.slug} isOwner={isOwner} />

              {/* Sessions list / creation aids */}
              <div className={sessions.length > 0 ? 'pt-2' : ''}>
                {sessions.length > 0 ? (
                  <>
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-medium text-muted-foreground flex-1">Sessions</h2>
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
                      {sessionSearchOpen && (
                        <Input
                          ref={sessionSearchRef}
                          value={sessionSearch}
                          onChange={(e) => setSessionSearch(e.target.value)}
                          placeholder="Filter sessions..."
                          className="h-6 text-xs flex-1"
                        />
                      )}
                    </div>
                    <div className="border-b mt-2" />
                    <RelatedSessions
                      sessions={sessions}
                      agentSlug={agent.slug}
                      formatDate={formatDate}
                      showIcon={false}
                      showHeader={false}
                      searchQuery={sessionSearch}
                      sortOrder={sessionSort}
                    />
                  </>
                ) : (
                  <AgentCreationAids
                    onVoiceResult={handleVoiceResult}
                    onImportComplete={handleImportComplete}
                  />
                )}
              </div>
              </div>
            </>
          )}
        </div>

        {/* Right Column — Triggers + Connections + Skills + Volumes */}
        {showRightColumn && (
          <div className="space-y-3">
            {(Array.isArray(agent.dashboards) ? agent.dashboards : []).map((d) => (
              <DashboardCard
                key={d.slug}
                dashboard={d}
                agentSlug={agent.slug}
              />
            ))}
            <HomeTriggers
              className="intro-step intro-step-4"
              agentSlug={agent.slug}
              scheduledTasks={scheduledTasks}
              onSelectTask={(taskId: string) => {
                void navigate({ to: '/agents/$slug/tasks/$taskId', params: { slug: agent.slug, taskId } })
              }}
              onSelectWebhook={(webhookId: string) => {
                void navigate({ to: '/agents/$slug/webhooks/$webhookId', params: { slug: agent.slug, webhookId } })
              }}
            />
            <HomeConnections className="intro-step intro-step-5" agentSlug={agent.slug} />
            <HomeSkills className="intro-step intro-step-6" agentSlug={agent.slug} onRunSkill={(skillPath) => {
              const text = `/${skillPath} `
              composer.setMessage(text)
              composerTextareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              setTimeout(() => {
                const el = composerTextareaRef.current
                if (el) {
                  el.focus()
                }
              }, 0)
            }} />
            <HomeChatIntegrations className="intro-step intro-step-7" agentSlug={agent.slug} />
            <HomeVolumes className="intro-step intro-step-8" agentSlug={agent.slug} />
            <HomeDefaultModel className="intro-step intro-step-9" agentSlug={agent.slug} />
            <HomeExtras className="intro-step intro-step-9" agentSlug={agent.slug} onOpenSettings={handleOpenSettings} />
            <HomeHooks className="intro-step intro-step-9" agentSlug={agent.slug} isOwner={isOwner} />
          </div>
        )}
      </div>
    </div>

      <AgentSettingsDialog
        agent={agent}
        open={settingsOpen}
        onOpenChange={(open) => { setSettingsOpen(open); if (!open) setSettingsTab(undefined) }}
        initialTab={settingsTab}
      />
      <SystemPromptDialog
        agent={agent}
        open={systemPromptOpen}
        onOpenChange={setSystemPromptOpen}
      />
    </>
  )
}
