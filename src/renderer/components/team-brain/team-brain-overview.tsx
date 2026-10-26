import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react'
import { ArrowUpRight, Check, ChevronDown, Plus, Settings2 } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { SettingsPageContainer } from '@renderer/components/layout/settings-page'
import { useDeleteAgent, useListedAgents, type ApiAgent } from '@renderer/hooks/use-agents'
import { useAgentMounts } from '@renderer/hooks/use-mounts'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { useMinuteClock } from '@renderer/hooks/use-minute-clock'
import { TEAM_BRAIN_LOCATION_IDS, TEAM_BRAIN_SCHEDULES, type TeamBrainLocationId } from '@renderer/lib/team-brain/team-brain-schema'
import type { TeamBrainNode } from '@renderer/lib/team-brain/team-brain-structure'
import { useTeamBrainDrive } from '@renderer/hooks/use-team-brain-drive'
import { splitFrontPages, TEAM_RECORD_FOLDER } from '@renderer/lib/team-brain/team-brain-drive'
import { useTeamBrainSyncs } from '@renderer/hooks/use-team-brain-syncs'
import type { TeamBrainSync } from '@renderer/lib/team-brain/team-brain-syncs'
import { getApiBaseUrl } from '@renderer/lib/env'
import { FilePreviewProvider, useFilePreview } from '@renderer/context/file-preview-context'
import { WorkflowProvider } from '@renderer/context/workflow-context'
import { TrayManager } from '@renderer/components/tray/tray-manager'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/components/ui/collapsible'
import { IntegrationRow, RowHoverChevron } from '@renderer/components/connections/integration-row'
import { useNavigate } from '@tanstack/react-router'
import { formatDistanceToNow } from 'date-fns'
import { useSessions } from '@renderer/hooks/use-sessions'
import { RelatedSessions, toSessionItem } from '@renderer/components/sessions/related-sessions'
import { canUseHostFeatures } from '@renderer/lib/host-features'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { AccountStatusBadge } from '@renderer/components/connections/account-status-badge'
import { useAgentConnectedAccounts } from '@renderer/hooks/use-connected-accounts'
import { useOAuthReconnect } from '@renderer/hooks/use-oauth-reconnect'
import { isForeignAgentConnectedAccount } from '@shared/lib/agent-connections/public'
import { toast } from 'sonner'
import { formatSince, formatUntil, SCHEDULE_LABELS } from '@renderer/lib/team-brain/team-brain-format'
import { isBrainUpkeep, scheduleOfCron, TEAM_BRAIN_CRON } from '@renderer/lib/team-brain/team-brain-setup-block'
import { usePauseScheduledTask, useResumeScheduledTask, useScheduledTaskSessions, useScheduledTasks, useUpdateSchedule, type ApiScheduledTask } from '@renderer/hooks/use-scheduled-tasks'
import { StatusToggle } from '@renderer/components/triggers/status-toggle'
import { TeamBrainRadial } from './team-brain-radial'
import { TeamBrainSyncSummaries } from './team-brain-sync-summaries'
import { TeamBrainHomeComposer } from './team-brain-home-composer'
import { AgentAccessList, EveryAgentRow } from './team-brain-agent-access'
import { useTeamBrainAccess } from '@renderer/hooks/use-team-brain-access'
import { teamBrainLocation } from './team-brain-locations'

/** The drawer's tabs are keyed by agent; Team Brain's pages are no agent's, so they get their own key. */
const PREVIEW_SLUG = 'team-brain'

/**
 * Team Brain once it is set up: its home page, for its agent. The app's file
 * drawer sits beside it (set up as on Agent Home) so a page in the drive opens
 * like any other file, and its settings open as a second column; the file
 * drawer and the settings never show together. Everything on it is the Team
 * Brain agent's own: its drive, its upkeep task, its connections and the
 * agents its drive is on.
 */
export function TeamBrainOverview({ agent }: { agent: ApiAgent }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Shown from the settings drawer. Switched off, the record stays in the tree while it draws back in, then goes.
  const [showRecord, setShowRecord] = useState(false)
  const [recordLeaving, setRecordLeaving] = useState(false)
  const switchRecord = (on: boolean) => {
    setShowRecord(on)
    setRecordLeaving(!on)
  }
  return (
    <FilePreviewProvider sessionId="team-brain" commentsEnabled={false}>
      <WorkflowProvider sessionId="team-brain">
        <div className="file-preview-container relative flex min-h-0 min-w-0 flex-1" data-testid="file-preview-container">
          <OverviewBody
            agent={agent}
            settingsOpen={settingsOpen}
            onSettingsOpenChange={setSettingsOpen}
            showRecord={showRecord}
            recordLeaving={recordLeaving}
            onShowRecordChange={switchRecord}
            onRecordLeft={() => setRecordLeaving(false)}
          />
          <TrayManager agentSlug={PREVIEW_SLUG} sessionId="team-brain" browserActive={false} filePreviewWideLayout="overlay" />
        </div>
      </WorkflowProvider>
    </FilePreviewProvider>
  )
}

/** Where the Team Brain agent's drive lives, from the drive itself; Gamut-hosted when it has none yet. */
function useTeamBrainLocation(agentSlug: string) {
  const { data: mounts } = useAgentMounts(agentSlug)
  const type = mounts?.[0]?.type
  const id: TeamBrainLocationId = type && (TEAM_BRAIN_LOCATION_IDS as readonly string[]).includes(type) ? type : 'gamut'
  return teamBrainLocation(id)
}

/** The task Team Brain syncs on: the one recurring task its onboarding names "Brain upkeep". None until its first chat. */
function useBrainUpkeep(agentSlug: string): ApiScheduledTask | undefined {
  const { data: tasks } = useScheduledTasks(agentSlug)
  return tasks?.find((task) => isBrainUpkeep(task.name) && (task.status === 'pending' || task.status === 'paused'))
}

const isoOf = (at: Date | string | null) => (at ? new Date(at).toISOString() : null)

/** How the sync is doing, in a line. Synced is from the latest summary, which a run writes once it is done, not from a run starting. */
function syncLine(upkeep: ApiScheduledTask | undefined, lastSync: TeamBrainSync | undefined) {
  if (!upkeep) return 'Not scheduled yet'
  return `${upkeep.status === 'paused' ? 'Paused' : 'Active'} · ${lastSync ? `Synced ${formatSince(lastSync.at)}` : 'Not synced yet'}`
}

/**
 * How it is doing, the drive it keeps and what each sync filed into it. The levers
 * (sources, schedule, which agents share it) are a button away, in the
 * settings panel, which makes the page two columns.
 */
function OverviewBody({
  agent,
  settingsOpen,
  onSettingsOpenChange,
  showRecord,
  recordLeaving,
  onShowRecordChange,
  onRecordLeft,
}: {
  agent: ApiAgent
  settingsOpen: boolean
  onSettingsOpenChange: (open: boolean) => void
  showRecord: boolean
  recordLeaving: boolean
  onShowRecordChange: (on: boolean) => void
  onRecordLeft: () => void
}) {
  const agentSlug = agent.slug
  useMinuteClock()

  // The Team Brain agent's drive, read as far as the tree shows and further as folders open.
  const { data: mounts } = useAgentMounts(agentSlug)
  const volumeId = mounts?.[0]?.volumeId
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const { drive, ready, error } = useTeamBrainDrive(agentSlug, volumeId, expanded, showRecord || recordLeaving, recordLeaving)
  const { front, index, rest } = useMemo(() => splitFrontPages(drive), [drive])
  const upkeep = useBrainUpkeep(agentSlug)
  const { data: syncs = [], isError: syncsUnreadable } = useTeamBrainSyncs(agentSlug, volumeId)
  const navigate = useNavigate()
  // A page opens in the file drawer from the drive, as the drive's own file browser opens it. A "+N more" past what
  // even an opened folder shows opens as a list of the pages it stands for.
  const { openFile, close: closeFiles, isOpen: filesOpen } = useFilePreview()
  const openPage = (file: TeamBrainNode, { path, folder }: { path: string; folder?: TeamBrainNode }) => {
    if (!volumeId) return
    onSettingsOpenChange(false)
    if (file.more) {
      const list = `data:text/markdown;charset=utf-8,${encodeURIComponent(`# ${folder?.name ?? 'More pages'}\n\n${file.more.map((name) => `- ${name.replace(/\.md$/, '')}`).join('\n')}`)}`
      return openFile(`/Team Brain${path}.md`, PREVIEW_SLUG, undefined, { inlineUrl: list, downloadUrl: list })
    }
    const url = `${getApiBaseUrl()}/api/volume-definitions/${encodeURIComponent(volumeId)}/file?${new URLSearchParams({ path: file.id })}`
    openFile(`/Team Brain${path}`, PREVIEW_SLUG, undefined, { inlineUrl: `${url}&inline=true`, downloadUrl: url })
  }
  const toggleSettings = () => {
    if (!settingsOpen) closeFiles()
    onSettingsOpenChange(!settingsOpen)
  }
  // A click on the page behind the file drawer puts it away, unless it is what opened one: a [data-drawer-opener], or
  // a page on the tree, whose click the tree keeps to itself. A page clicked while another is showing swaps the file
  // rather than closing the drawer and opening it again. Settings beside the page stay open; floating over it, they
  // close as the drawer does.
  const closeDrawersOnClickOff = (event: ReactMouseEvent) => {
    const target = event.target
    // Only the page itself: a popover's click (the composer's model picker, a picker in the panel) bubbles here
    // through React from outside this element.
    if (!(target instanceof Element) || !event.currentTarget.contains(target)) return
    if (target.closest('[data-drawer-opener]')) return
    closeFiles()
    // Narrower than xl the panel floats over the page and covers its settings button, so a click off it closes it.
    if (settingsOpen && !wide && !target.closest('#team-brain-settings')) onSettingsOpenChange(false)
  }

  const { scrollRef, treeRef, treeTop, treeHeight, viewHeight } = useStickyTree()
  const { ref: dockRef, stuck: docked } = useStuck(scrollRef, treeTop)
  const wide = useMediaQuery(SETTINGS_BESIDE_PAGE)
  // The panel stays out while it fades away after closing.
  const [settingsClosing, setSettingsClosing] = useState(false)
  useEffect(() => {
    if (settingsOpen) setSettingsClosing(true)
  }, [settingsOpen])
  const showSettings = settingsOpen || settingsClosing
  const settingsClosed = useCallback(() => setSettingsClosing(false), [])

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a pointer convenience; each drawer has its own close button
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background" onClick={closeDrawersOnClickOff}>
      <SettingsPageContainer className={cn(PAGE_WIDTH, 'space-y-8')} scrollContainerRef={scrollRef}>
        {/* The centrepiece: what Team Brain knows, as a tree floating on the page with no frame around it. It fills the
            view down to where the composer peeks in and stays where it is as the page scrolls, so what follows passes over it.
            Held back until its first view is listed, so the opening plays once over the whole of it. A drive it can't read
            says so where the tree would be. */}
        <div ref={treeRef} className="sticky z-0" style={{ top: treeTop }} data-testid="team-brain-tree-layer">
          {mounts && !volumeId ? (
            <TreeNote height={treeHeight}>Team Brain has no drive yet.</TreeNote>
          ) : error && !ready ? (
            <TreeNote height={treeHeight} alert testId="team-brain-drive-error">{`Couldn't read the Team Brain drive. ${error}`}</TreeNote>
          ) : ready && drive.length === 0 ? (
            <TreeNote height={treeHeight}>Nothing in the drive yet. Team Brain fills it as it builds the brain.</TreeNote>
          ) : ready ? (
            <TeamBrainRadial
              drive={rest}
              expanded={expanded}
              onExpandedChange={setExpanded}
              onOpenFile={openPage}
              onOpenCentre={front && (() => openPage(front, { path: `/${front.name}` }))}
              onOpenIndex={index && (() => openPage(index, { path: `/${index.name}` }))}
              retracting={recordLeaving ? RECORD_SECTIONS : undefined}
              onRetracted={onRecordLeft}
              height={treeHeight}
            />
          ) : (
            <div style={{ height: treeHeight }} aria-busy="true" data-testid="team-brain-radial-loading" />
          )}
        </div>

        {/* The page's own column. With settings open it makes room for them on the right from xl, as Agent Home's two
            columns do, while the tree behind stays exactly where it is. */}
        <div
          // Makes room on the panel's own curves (globals.css), so the two move as one.
          className={cn('team-brain-column relative space-y-8', settingsOpen && 'xl:pr-[392px]')}
          data-settings={settingsOpen ? 'open' : 'closed'}
          data-testid="team-brain-column"
        >
          {/* The status row and composer peek in at the foot of the view, pass over the tree as the page scrolls and then
              stick at the top, level with the settings panel, while sync summaries go on scrolling under them. */}
          <div
            ref={dockRef}
            className="sticky z-20 mx-auto w-full max-w-[720px] space-y-3"
            style={{ top: treeTop }}
            data-stuck={docked || undefined}
            data-testid="team-brain-dock"
          >
            {/* A folder that fails after the tree is up leaves the tree and says so here, above how Team Brain is doing. */}
            {error && ready && (
              <p className="text-center text-sm text-muted-foreground" role="alert" data-testid="team-brain-drive-error">
                {`Couldn't read part of the Team Brain drive. ${error}`}
              </p>
            )}
            {/* No heading of its own: the nav bar names the page, so this is just how Team Brain is doing, riding above
                the composer at its width. */}
            <header className="relative flex flex-wrap items-center justify-between gap-4" data-testid="team-brain-overview">
              {/* Once stuck, the page from the top of the view down to the composer, so summaries scrolling up go under
                  the composer instead of showing round the status row. Only then: on its way up it would blank out a
                  strip of the tree. */}
              <div aria-hidden="true" className="team-brain-dock-cover pointer-events-none absolute -inset-x-6 -bottom-7 -z-10 bg-background" style={{ top: -treeTop }} />
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="team-brain-status">
                <span className={cn('inline-block h-1.5 w-1.5 rounded-full', upkeep?.status === 'pending' ? 'bg-green-500' : 'bg-muted-foreground')} aria-hidden="true" />
                {syncLine(upkeep, syncs[0])}
              </p>
              {/* Opens the settings panel: where it lives, the schedule, sources, agents, turning it off. */}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={toggleSettings}
                aria-label="Team Brain settings"
                aria-expanded={settingsOpen}
                aria-controls="team-brain-settings"
                data-testid="team-brain-menu"
                data-drawer-opener
              >
                <Settings2 />
              </Button>
            </header>
            {/* Talk to it, as on Agent Home: a message starts a session with the Team Brain agent. Glass, as the session's
                composer is, so the tree shows through it as it passes over. */}
            <TeamBrainHomeComposer agent={agent} />
          </div>

          {/* What each sync filed, read like a changelog, on a glass sheet like the composer's and as wide as it: the tree
              shows through it, blurred, as it passes over. */}
          <div className="relative z-10 mx-auto w-full max-w-[720px] rounded-3xl border border-border/60 bg-background/60 px-6 pb-8 pt-8 shadow-[0_0_24px_rgba(15,23,42,0.07),0_2px_10px_-4px_rgba(15,23,42,0.08)] backdrop-blur-xl supports-[backdrop-filter]:bg-background/40 dark:shadow-[0_0_26px_rgba(0,0,0,0.22),0_2px_12px_-4px_rgba(0,0,0,0.16)]">
            <TeamBrainSyncSummaries
              syncs={syncs}
              unreadable={syncsUnreadable}
              onOpenFile={openPage}
              onOpenSession={(sessionId) => void navigate({ to: '/agents/$slug/sessions/$sessionId', params: { slug: agentSlug, sessionId } })}
            />
          </div>

          {showSettings && wide && (
            // Beside the page, in the room the column makes: level with the status row, it scrolls with the column and
            // then sticks at the top, and slides out from behind the column's glass (it sits beneath it).
            <div className="pointer-events-none absolute inset-y-0 right-0 z-0 !mt-0 w-[360px]">
              <SettingsPanel
                agent={agent}
                placement="beside"
                open={settingsOpen}
                onClose={() => onSettingsOpenChange(false)}
                onClosed={settingsClosed}
                showRecord={showRecord}
                onShowRecordChange={onShowRecordChange}
                style={{ top: treeTop, maxHeight: Math.max(viewHeight - treeTop - 24, 320) }}
              />
            </div>
          )}
        </div>
      </SettingsPageContainer>
      {showSettings && !wide && (
        // Narrower there is no room beside the page, so it floats over it, lined up with the page's own width; it stays
        // put as the page scrolls and the tree shows through its glass.
        <div className="pointer-events-none absolute inset-0 z-30">
          <div className={cn('mx-auto flex h-full w-full justify-end px-6 pb-6 pt-10', PAGE_WIDTH)}>
            <SettingsPanel
              agent={agent}
              placement="over"
              open={settingsOpen}
              onClose={() => onSettingsOpenChange(false)}
              onClosed={settingsClosed}
              showRecord={showRecord}
              onShowRecordChange={onShowRecordChange}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/** Where settings fit beside the page, as Agent Home's two columns do (Tailwind's xl). */
const SETTINGS_BESIDE_PAGE = '(min-width: 1280px)'

/** Whether `query` matches, following the window as it resizes (as `useIsMobile` does for its one width). */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false)
  useEffect(() => {
    const list = window.matchMedia?.(query)
    if (!list) return
    const onChange = () => setMatches(list.matches)
    onChange()
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** The page's width, the same with settings open or not, so the tree never moves. */
const PAGE_WIDTH = 'max-w-[1040px]'

/** What the tree's place says when there is no tree to draw. */
function TreeNote({ height, alert = false, testId, children }: { height: number; alert?: boolean; testId?: string; children: ReactNode }) {
  return (
    <p style={{ height }} className="flex items-center justify-center text-sm text-muted-foreground" role={alert ? 'alert' : undefined} data-testid={testId}>
      {children}
    </p>
  )
}

/** What draws back in when the team record is switched off. */
const RECORD_SECTIONS = [TEAM_RECORD_FOLDER]

/** How much shows at the foot of the view before scrolling (the status row and the composer's top), and the shortest the tree gets. */
const COMPOSER_PEEK = 124
const MIN_TREE_HEIGHT = 520

/**
 * The tree fills the view from the top down to where the status row and composer peek in, and sticks there, so
 * everything after it passes over the tree.
 */
function useStickyTree() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const [treeTop, setTreeTop] = useState(0)
  const [treeHeight, setTreeHeight] = useState(680)
  const [viewHeight, setViewHeight] = useState(0)

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    const tree = treeRef.current
    if (!scroller || !tree) return
    const measure = () => {
      // Where the tree starts in the page: it comes first, so at the page's top padding. Read off the page's own
      // container, since a stuck tree's own offset is where it is stuck, not where it starts.
      const page = scroller.firstElementChild
      const top = page ? Math.round(parseFloat(getComputedStyle(page).paddingTop) || 0) : 0
      setTreeTop(top)
      setViewHeight(scroller.clientHeight)
      // The page's 32px gap sits between the tree and the composer.
      setTreeHeight(Math.max(MIN_TREE_HEIGHT, Math.round(scroller.clientHeight - top - 32 - COMPOSER_PEEK)))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [])

  return { scrollRef, treeRef, treeTop, treeHeight, viewHeight }
}

/** Whether an element sticky at `top` in the scroller is stuck there, rather than in its place on the page. */
function useStuck(scrollRef: RefObject<HTMLDivElement | null>, top: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const root = scrollRef.current
    const element = ref.current
    if (!root || !element || typeof IntersectionObserver === 'undefined') return
    // Watch a view 1px shorter at the top than where it sticks: stuck, it pokes 1px above it. Still on its way up, it
    // can be cut off too, by the foot of the view, so it counts as stuck only when it is the top that is cut.
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.rootBounds) return
      setStuck(entry.intersectionRatio < 1 && entry.boundingClientRect.top <= entry.rootBounds.top)
    }, { root, rootMargin: `-${top + 1}px 0px 0px 0px`, threshold: 1 })
    observer.observe(element)
    return () => observer.disconnect()
  }, [scrollRef, top])
  return { ref, stuck }
}

/** How long the panel takes to slide out (see its classes), after which it is taken away. */
const PANEL_FADE_MS = 300

/**
 * Where Team Brain lives, how it syncs, what it reads and which agents share
 * it: a floating glass panel at the page's right, as tall as its cards (its
 * cards scroll inside it when the view is shorter). Beside the page it slides
 * out from behind the page's column and back in under it; floating over the
 * page it slides in from the right edge and back out. Either way it eases to a
 * stop, and is then taken away (`onClosed`). It has no close button of its own: the settings button beside
 * the status line toggles it, Escape closes it, and where it floats over the
 * page (narrower than xl) so does a click off it.
 */
function SettingsPanel({ agent, placement, open, onClose, onClosed, showRecord, onShowRecordChange, style }: {
  agent: ApiAgent
  /** Beside the page, in its column (sticky; `style` gives where it sticks and its tallest), or floating over it. */
  placement: 'beside' | 'over'
  open: boolean
  onClose: () => void
  /** The panel has slid out and can go. */
  onClosed: () => void
  showRecord: boolean
  onShowRecordChange: (on: boolean) => void
  style?: CSSProperties
}) {
  const { data: agents = [] } = useListedAgents()
  const deleteAgent = useDeleteAgent()
  const [confirmOff, setConfirmOff] = useState(false)
  // Turning it off deletes the Team Brain agent; the server drops the workspace record with it, and the page
  // goes back to the pitch once the agent list no longer has it. Its drive and files stay.
  const turnOff = () =>
    deleteAgent.mutate(agent.slug, {
      onError: (error) => toast.error('Could not turn off Team Brain', { description: error instanceof Error ? error.message : undefined }),
    })
  // Gone once it has faded: on a timer rather than transitionend, which never comes under reduced motion.
  useEffect(() => {
    if (open) return
    const done = setTimeout(onClosed, PANEL_FADE_MS + 50)
    return () => clearTimeout(done)
  }, [open, onClosed])
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      // The turn-off confirmation takes its own Escape.
      if (event.key === 'Escape' && !event.defaultPrevented && !confirmOff) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose, confirmOff])
  return (
    <aside
      id="team-brain-settings"
      aria-label="Settings"
      style={style}
      data-placement={placement}
      className={cn(
        placement === 'beside' ? 'sticky w-full' : 'max-h-full w-[360px] max-w-full self-start',
        // Concentric with the cards inside it: their 16px radius plus the panel's 12px inset.
        'pointer-events-auto flex flex-col overflow-hidden rounded-[28px] border border-border/60 bg-background/70 shadow-[0_8px_40px_rgba(15,23,42,0.12),0_2px_10px_-4px_rgba(15,23,42,0.1)] backdrop-blur-xl supports-[backdrop-filter]:bg-background/55 dark:shadow-[0_8px_40px_rgba(0,0,0,0.4),0_2px_12px_-4px_rgba(0,0,0,0.3)]',
        // The slide's curves are in globals.css, beside the page column's.
        open ? 'team-brain-settings-in' : 'team-brain-settings-out',
      )}
      data-testid="team-brain-settings"
    >
      {/* Laid out as Agent Home's side panel: the pickers in one card, the sections as rows of another. */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" data-testid="team-brain-details">
        <SyncCard agentSlug={agent.slug} showRecord={showRecord} onShowRecordChange={onShowRecordChange} />
        <div className={SECTIONS_CARD_CLASS}>
          <StorageSection agentSlug={agent.slug} />
          <SourcesSection agentSlug={agent.slug} />
          <AgentsSection brainSlug={agent.slug} agents={agents} />
          <SessionsSection agentSlug={agent.slug} />
        </div>
      </div>
      {/* Pinned to the foot of the panel, below everything that scrolls; as wide as the cards, red only in its words until hovered. */}
      <div className="shrink-0 border-t border-border/40 p-3">
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setConfirmOff(true)}
          disabled={deleteAgent.isPending}
          data-testid="team-brain-turn-off"
        >
          Turn off Team Brain
        </Button>
      </div>
      <AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off Team Brain?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the Team Brain agent, so nothing syncs and agents can no longer message it. Its drive and files stay where they
              are, but other agents lose it from their next start. You can set Team Brain up again any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it on</AlertDialogCancel>
            <AlertDialogAction onClick={turnOff} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="team-brain-turn-off-confirm">
              Turn off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  )
}

/** The card the panel's sections share, as Agent Home's side panel has it: each section a row, divided from the next, clipped to the card's corners. */
const SECTIONS_CARD_CLASS = 'overflow-hidden rounded-2xl border border-border/60 bg-background shadow-sm divide-y divide-border/50'
/** A section's header row, as tall as the pickers' rows. The focus ring is inset because the card clips its rows. */
const SECTION_HEADER_CLASS = 'flex min-h-12 w-full items-center justify-between gap-2 px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
/** Every label in the panel: a section's title, a picker row's name. */
const PANEL_LABEL_CLASS = 'text-[12px]/5 text-muted-foreground'
/** How many a folded section holds, in Agent Home's style for a section's count. */
const SECTION_COUNT_CLASS = 'text-[12px]/5 tabular-nums text-muted-foreground/50'

/**
 * How Team Brain keeps up and what the tree shows, in a card of picker rows
 * like Agent Home's default model and auto-delete: whether it is syncing (its
 * toggle pauses that; agents still read what is already there), when it last
 * ran and next will, how often, and whether the tree shows the team record.
 */
function SyncCard({ agentSlug, showRecord, onShowRecordChange }: { agentSlug: string; showRecord: boolean; onShowRecordChange: (on: boolean) => void }) {
  const upkeep = useBrainUpkeep(agentSlug)
  const pause = usePauseScheduledTask()
  const resume = useResumeScheduledTask()
  const paused = upkeep?.status === 'paused'
  return (
    <div className="divide-y divide-border/50 rounded-2xl border bg-background">
      <div className="flex items-center justify-between gap-2 px-4 py-2" data-testid="team-brain-sync">
        <div className="min-w-0">
          <span className={cn('block', PANEL_LABEL_CLASS)}>Sync</span>
          <dl className="flex flex-wrap gap-x-3 text-[11px]">
            <div className="flex gap-1">
              <dt className="text-muted-foreground">Next:</dt>
              <dd>{!upkeep ? 'After the first chat' : paused ? 'Paused' : formatUntil(upkeep.nextExecutionAt)}</dd>
            </div>
            <div className="flex gap-1">
              <dt className="text-muted-foreground">Last run:</dt>
              <dd>{upkeep?.lastExecutedAt ? formatSince(isoOf(upkeep.lastExecutedAt)) : 'Not yet'}</dd>
            </div>
          </dl>
        </div>
        <StatusToggle
          status={paused ? 'paused' : 'active'}
          isActive={!!upkeep}
          isPaused={paused}
          canToggle={!!upkeep}
          onToggle={(on) => upkeep && (on ? resume : pause).mutate({ taskId: upkeep.id, agentSlug })}
          ariaLabelResume="Resume syncing"
          ariaLabelPause="Pause syncing"
        />
      </div>
      <ScheduleRow agentSlug={agentSlug} />
      {/* What the tree shows: the agent's own record, off by default. */}
      <div className="flex items-center gap-3 px-4 py-2">
        <label htmlFor="team-brain-show-record" className="min-w-0 flex-1">
          <span className={cn('block', PANEL_LABEL_CLASS)}>Show team record</span>
          <span className="block text-[11px] text-muted-foreground/70">{"Rules, sources, changelog, archive, sync summaries and the agents' index."}</span>
        </label>
        <Switch id="team-brain-show-record" checked={showRecord} onCheckedChange={onShowRecordChange} data-testid="team-brain-show-record" />
      </div>
    </div>
  )
}

/** Where Team Brain lives, as a connector row under its section label; it opens the folder on this computer when it can. */
function StorageSection({ agentSlug }: { agentSlug: string }) {
  const location = useTeamBrainLocation(agentSlug)
  const LocationIcon = location.Icon
  // Where the drive is, and opening a folder on this computer, as Agent Home's drive rows show it.
  const { data: mounts } = useAgentMounts(agentSlug)
  const mount = mounts?.[0]
  const hostPath = mount?.hostPath ?? null
  const showInFolder = canUseHostFeatures() && hostPath !== null ? () => void window.electronAPI?.showInFolder(hostPath) : undefined
  return (
    <section className="pb-3">
      <h3 className={cn('flex min-h-12 items-center px-4', PANEL_LABEL_CLASS)}>Storage location</h3>
      <IntegrationRow
        icon={<LocationIcon className="h-4 w-4" />}
        name={location.name}
        onActivate={showInFolder}
        ariaLabel={showInFolder ? `Open Team Brain in ${location.name}` : undefined}
        right={showInFolder ? <RowHoverChevron icon={<ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />} /> : undefined}
        // No fill on hover, as rows in Agent Home's side panel have none: the ↗ says it opens.
        className="hover:bg-transparent"
        data-testid="team-brain-storage"
        subtitle={
          <span className="min-w-0 truncate" data-testid="team-brain-location">
            {mount?.sourceLabel ?? hostPath}
          </span>
        }
      />
    </section>
  )
}

/**
 * A folded section row in the sections card, as Agent Home's side panel has
 * them: the title, what is in it while folded (`summary`), and a chevron; it
 * opens to its rows below. The card is `testId`, its header `${testId}-toggle`.
 */
function PanelSection({ title, summary, testId, children }: { title: string; summary: ReactNode; testId: string; children: ReactNode }) {
  return (
    <Collapsible data-testid={testId}>
      <CollapsibleTrigger className={SECTION_HEADER_CLASS} data-testid={`${testId}-toggle`}>
        <span className={PANEL_LABEL_CLASS}>{title}</span>
        <span className="flex items-center gap-2">
          <span className="flex items-center gap-2 [[data-state=open]>*>&]:hidden">{summary}</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground/50 transition-transform [[data-state=closed]>*>&]:rotate-[-90deg]" aria-hidden="true" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-3">{children}</CollapsibleContent>
    </Collapsible>
  )
}

/**
 * How often Team Brain syncs, as one of Agent Home's preference rows: the
 * label, and an outlined trigger whose popover lists the choices with what
 * each trades away. A pick doesn't close it, as the model picker's don't.
 */
function ScheduleRow({ agentSlug }: { agentSlug: string }) {
  const upkeep = useBrainUpkeep(agentSlug)
  const update = useUpdateSchedule()
  const schedule = upkeep ? scheduleOfCron(upkeep.scheduleExpression) : null
  const title = !upkeep ? 'After the first chat' : schedule ? SCHEDULE_LABELS[schedule].title : 'Custom'
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-2" data-testid="team-brain-schedule">
      <span className={PANEL_LABEL_CLASS}>Schedule</span>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-[34px] justify-between gap-1.5 px-2 text-xs font-medium"
            disabled={!upkeep}
            aria-label={`Schedule: ${title}. Click to change.`}
            data-testid="team-brain-schedule-trigger"
          >
            <span className="truncate">{title}</span>
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="flex w-64 flex-col px-1 py-2" align="end" collisionPadding={8} onOpenAutoFocus={(e) => e.preventDefault()}>
          <div className="flex flex-col" role="listbox" aria-label="Schedule">
            {TEAM_BRAIN_SCHEDULES.map((option) => {
              const isSelected = option === schedule
              return (
                <button
                  key={option}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => upkeep && update.mutate({ taskId: upkeep.id, scheduleExpression: TEAM_BRAIN_CRON[option] })}
                  data-testid={`team-brain-schedule-option-${option}`}
                  className={cn(
                    'flex items-start justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground',
                    isSelected ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block">{SCHEDULE_LABELS[option].title}</span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">{SCHEDULE_LABELS[option].detail}</span>
                  </span>
                  {isSelected && <Check className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                </button>
              )
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

/** A few overlapping marks and how many there are in all, for a folded section's header. */
function StackSummary({ marks, count }: { marks: ReactNode[]; count: number }) {
  return (
    <>
      <span className="flex -space-x-1.5" aria-hidden="true">
        {marks.slice(0, 4)}
      </span>
      <span className={SECTION_COUNT_CLASS}>{count}</span>
    </>
  )
}

/**
 * The apps Team Brain reads: its agent's own connections, folded down to their logos, in Agent Home's card and rows.
 * Each row, its reconnect and the footer open the agent's Connections page, as Agent Home's Connections card does.
 */
function SourcesSection({ agentSlug }: { agentSlug: string }) {
  const navigate = useNavigate()
  const { data } = useAgentConnectedAccounts(agentSlug)
  const { reconnect, pendingAccountId, canCancelPendingReconnect, cancelReconnect } = useOAuthReconnect()
  const accounts = (data?.accounts ?? []).flatMap((account) => (isForeignAgentConnectedAccount(account) ? [] : [account]))
  const openConnections = (detail?: string) =>
    void navigate({ to: '/agents/$slug/connections', params: { slug: agentSlug }, search: detail ? { detail, source: 'home' } : undefined })
  const marks = accounts.map((account) => (
    <span key={account.id} className="grid size-[18px] place-items-center rounded-full bg-background ring-2 ring-background">
      <ServiceIcon slug={account.toolkitSlug} className="size-3" />
    </span>
  ))
  return (
    <PanelSection title="Sources" summary={<StackSummary marks={marks} count={accounts.length} />} testId="team-brain-sources">
      {/* Agent Home's side-panel rows: no dividers, and no fill or chevron on hover. */}
      <div className="mt-2">
        {accounts.map((account) => (
          <IntegrationRow
            key={account.id}
            className="hover:bg-transparent"
            iconSlug={account.toolkitSlug}
            iconFallback="oauth"
            name={account.provider?.displayName ?? account.toolkitSlug}
            nameBadge={
              <AccountStatusBadge
                status={account.status}
                onReconnect={account.status !== 'active' ? () => void reconnect(account.id, account.toolkitSlug) : undefined}
                onCancelReconnect={pendingAccountId === account.id && canCancelPendingReconnect ? cancelReconnect : undefined}
                loading={pendingAccountId === account.id}
              />
            }
            subtitle={<span className="truncate">{account.displayName}</span>}
            onActivate={() => openConnections(`account-${account.id}`)}
            ariaLabel={`Open ${account.provider?.displayName ?? account.toolkitSlug} connection details`}
          />
        ))}
      </div>
      <div className="mt-3 flex items-center justify-end px-4 pb-1">
        <Button type="button" variant="ghost" size="sm" onClick={() => openConnections()} data-testid="team-brain-manage-sources">
          {accounts.length > 0 ? <Settings2 /> : <Plus />}
          {accounts.length > 0 ? 'Manage Sources' : 'Add Source'}
        </Button>
      </div>
    </PanelSection>
  )
}

/**
 * Which agents use Team Brain, folded down to their avatars, in Agent Home's card. Open, it is set-up's own list:
 * every agent at once, or each on its own, read from and written to the drive's attachments.
 */
function AgentsSection({ brainSlug, agents }: { brainSlug: string; agents: readonly ApiAgent[] }) {
  const { data: mounts } = useAgentMounts(brainSlug)
  const access = useTeamBrainAccess(brainSlug, mounts?.[0]?.volumeId)
  const using = agents.filter((agent) => access.everyAgent || access.isOn(agent.slug))
  const marks = using.map((agent) => (
    <span key={agent.slug} className="rounded-full ring-2 ring-background">
      <AgentAvatar agent={agent} size={18} />
    </span>
  ))
  return (
    <PanelSection title="Agents" summary={<StackSummary marks={marks} count={using.length} />} testId="team-brain-agents">
      <EveryAgentRow
        checked={access.everyAgent}
        canGoGlobal={access.canGoGlobal}
        onCheckedChange={(on) => access.setEveryAgent(on, agents.map((agent) => agent.slug))}
        className="px-4 pb-3 pt-2"
      />
      {agents.length > 0 ? (
        <AgentAccessList agents={agents} everyAgent={access.everyAgent} isOn={access.isOn} isChanging={access.isChanging} onToggle={access.toggle} className="border-y border-border/50" rowClassName="px-4" />
      ) : (
        <p className="px-4 text-xs text-muted-foreground">No agents yet. Agents you make later can add the Team Brain drive from their Drives.</p>
      )}
      <p className="mt-3 px-4 pb-1 text-xs text-muted-foreground">An agent that uses it reads the drive and can message Team Brain.</p>
    </PanelSection>
  )
}

/**
 * Team Brain's own sessions, its chats and each upkeep run, in Agent Home's list. Its Agent Home stays out of reach.
 * The agent's list leaves scheduled runs out, as Agent Home shows them under their task, so the upkeep's runs join it here.
 */
function SessionsSection({ agentSlug }: { agentSlug: string }) {
  const { data: chats } = useSessions(agentSlug)
  const { data: runs } = useScheduledTaskSessions(useBrainUpkeep(agentSlug)?.id ?? null)
  const sessions = useMemo(() => [...(chats ?? []).map(toSessionItem), ...(runs ?? [])], [chats, runs])
  return (
    <PanelSection title="Sessions" summary={<span className={SECTION_COUNT_CLASS}>{sessions.length}</span>} testId="team-brain-sessions">
      {sessions.length > 0 ? (
        <RelatedSessions
          sessions={sessions}
          agentSlug={agentSlug}
          formatDate={formatSessionDate}
          showIcon={false}
          showHeader={false}
          pageSize={10}
          className="px-3 pt-2"
        />
      ) : (
        <p className="px-4 pt-2 text-xs text-muted-foreground">No sessions yet.</p>
      )}
    </PanelSection>
  )
}

const formatSessionDate = (date: string) => formatDistanceToNow(new Date(date), { addSuffix: true })
