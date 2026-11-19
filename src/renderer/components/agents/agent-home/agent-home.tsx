import { SidebarMemberIndicator } from '@renderer/components/agents/sidebar-member-indicator'
import { useState, useRef, useMemo, useCallback, useEffect, useLayoutEffect } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ChevronDown, Loader2, Eye, MoreHorizontal, Search } from 'lucide-react'
import { useSessions } from '@renderer/hooks/use-sessions'
import { agentAvatarState } from '@shared/lib/types/agent-activity-status'
import { AgentIdentityEditor, type AgentIdentityEditorHandle } from '@renderer/components/agents/agent-avatar/agent-identity-editor'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { useScheduledTasks } from '@renderer/hooks/use-scheduled-tasks'
import { RelatedSessions, toSessionItem, type SortOrder } from '@renderer/components/sessions/related-sessions'
import { SortPopover } from '@renderer/components/sessions/sort-popover'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { useNavTransient } from '@renderer/context/nav-transient-context'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { useNavigate } from '@tanstack/react-router'
import { useUser } from '@renderer/context/user-context'
import { AgentSharePopover, type AgentSharePopoverHandle } from '@renderer/components/agents/agent-share-popover'
import { AgentContextMenu } from '@renderer/components/agents/agent-context-menu'
import { HomeGlassPanel } from './home-glass-panel'
import { AgentHomeComposer, type AgentHomeComposerHandle } from './agent-home-composer'
import { HomeHalftoneBackdrop } from './home-halftone-backdrop'
import { ContentBackdrop } from '@renderer/components/layout/content-shell'
import { HomeSidePanel, SIDE_PANEL_BESIDE_PAGE } from './home-side-panel'
import { useMediaQuery } from '@renderer/hooks/use-media-query'
import { HomeBookmarks } from './home-bookmarks'
import { HomePanel } from './home-collapsible'
import { HomeVolumes } from './home-volumes'
import { AgentSettingsColumn } from './agent-settings-column'
import { useRefreshWidgetsOnVisit } from '@renderer/hooks/use-widgets'
import { useDeleteAgent, type ApiAgent } from '@renderer/hooks/use-agents'
import { AgentCreationAids, type ImportResult } from '@renderer/components/agents/agent-creation-aids'
import { useStartOnboardingSession } from '@renderer/hooks/use-start-onboarding-session'
import { UNTITLED_AGENT_NAME } from '@renderer/hooks/use-create-untitled-agent'
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
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false)
  const [allSessions, setAllSessions] = useState(false)
  const [sessionSearch, setSessionSearch] = useState('')
  const [sessionSort, setSessionSort] = useState<SortOrder>('newest')
  const { data: sessionsData } = useSessions(agent.slug)
  const carryover = useNewSessionCarryover(agent.slug)
  const sessionSearchRef = useRef<HTMLInputElement>(null)
  const deleteAgent = useDeleteAgent()
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

  // The composer keeps its own state (see AgentHomeComposer); the cards around it reach it through this handle.
  const composerRef = useRef<AgentHomeComposerHandle>(null)
  const isFreshUntitled = agent.name === UNTITLED_AGENT_NAME && sessions.length === 0

  const handleImportComplete = useCallback(
    async (imported: ImportResult) => {
      await completeAgentTemplateHandoff({
        draftsStore,
        agentSlug: imported.slug,
        hasOnboarding: imported.hasOnboarding,
        templatePrompt: imported.templatePrompt,
        onboardingFirstPrompt: imported.onboardingFirstPrompt,
        noteProgrammaticChange: (prompt) => composerRef.current?.noteProgrammaticChange(prompt),
        openAgent: () => {
          void navigate({ to: '/agents/$slug', params: { slug: imported.slug } })
          if (agent.name === UNTITLED_AGENT_NAME && sessions.length === 0 && agent.slug !== imported.slug) {
            deleteAgent.mutate(agent.slug)
          }
        },
        startOnboardingSession,
      })
    },
    [draftsStore, navigate, agent.slug, agent.name, sessions.length, deleteAgent, startOnboardingSession],
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
    <AgentSettingsColumn agent={agent} scheduledTasks={scheduledTasks} onRunSkill={(skillPath) => composerRef.current?.runSkill(skillPath)} />
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
      {/* Team Brain's home-page layout: one column the composer's width, centred in the page, with the side panel
          beside it from xl. The page is the only scroller; the panel scrolls with it. */}
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
              <SidebarMemberIndicator
                variant="page"
                agentSlug={agent.slug}
                agentName={agent.name}
                memberCount={isAuthMode ? agentMemberCount(agent.slug) : 0}
                maxFaces={5}
              />
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

                <AgentHomeComposer
                  ref={composerRef}
                  agent={agent}
                  isFreshUntitled={isFreshUntitled}
                  isRuntimeReady={isRuntimeReady}
                  carryover={carryover}
                  onSessionCreated={onSessionCreated}
                />

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
                      onStartVoiceMode={() => void composerRef.current?.startVoiceSession('home_card')}
                      onImportComplete={handleImportComplete}
                    />
                  )}
                  {/* Bookmarks get a panel of their own, when there are any. */}
                  <HomeBookmarks agentSlug={agent.slug} isOwner={isOwner} />
                  {/* Narrower than xl there is no room beside the page, so the side panel's cards follow its content. */}
                  {showSidePanel && !wide && <HomeSidePanel>{sidePanelContent}</HomeSidePanel>}
                </div>
              </>
            )}
            {!isOwner && <HomePanel><HomeVolumes agentSlug={agent.slug} /></HomePanel>}
          </div>

          {sidePanelBeside && (
            // Top-aligned with the title row's buttons.
            <div className="w-[336px] shrink-0" style={{ marginTop: panelTop }}>
              <HomeSidePanel>{sidePanelContent}</HomeSidePanel>
            </div>
          )}
        </div>
      </div>
    </div>
    </div>

    </>
  )
}
