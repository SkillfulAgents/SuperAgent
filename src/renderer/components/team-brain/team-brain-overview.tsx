import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react'
import { AlertCircle, AlertTriangle, ChevronDown, ChevronRight, Plus, Settings2 } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
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
import { useUser } from '@renderer/context/user-context'
import './team-brain.css'
import { useAgentMounts } from '@renderer/hooks/use-mounts'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { useMinuteClock } from '@renderer/hooks/use-minute-clock'
import type { TeamBrainNode } from '@renderer/lib/team-brain/team-brain-structure'
import { useTeamBrainDrive } from '@renderer/hooks/use-team-brain-drive'
import { splitFrontPages, TEAM_RECORD_FOLDER, teamRecordView } from '@renderer/lib/team-brain/team-brain-drive'
import type { FolderEntry } from '@renderer/hooks/use-folder-entries'
import { useTeamBrainSyncs } from '@renderer/hooks/use-team-brain-syncs'
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
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { AccountStatusBadge } from '@renderer/components/connections/account-status-badge'
import { useAgentConnectedAccounts } from '@renderer/hooks/use-connected-accounts'
import { useOAuthReconnect } from '@renderer/hooks/use-oauth-reconnect'
import { isForeignAgentConnectedAccount } from '@shared/lib/agent-connections/public'
import { toast } from 'sonner'
import { formatSince, formatUntil, SCHEDULE_LABELS } from '@renderer/lib/team-brain/team-brain-format'
import { scheduleOfCron } from '@renderer/lib/team-brain/team-brain-setup-block'
import { useHumanizedCron } from '@renderer/hooks/use-humanized-cron'
import { useScheduledTasks, useScheduledTasksSessions, type ApiScheduledTask } from '@renderer/hooks/use-scheduled-tasks'
import { TeamBrainRadial, TeamBrainRadialLoading } from './team-brain-radial'
import { DEV_STATES_ENABLED, devDrive, devSyncs, devTasks, TeamBrainDevStatesMenu, useTeamBrainDevStates } from './team-brain-dev-states'
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
 * Brain agent's own: its drive, its scheduled tasks, its connections and the
 * agents its drive is on.
 */
export function TeamBrainOverview({ agent }: { agent: ApiAgent }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The views of the team record the tree shows (`teamRecordView`), switched on in the settings' Views; none by default.
  // When the last one is switched off, the parts that were showing stay in the tree while they draw back in, then go.
  const [views, setViews] = useState<ReadonlySet<string>>(() => new Set())
  const [leaving, setLeaving] = useState<ReadonlySet<string> | null>(null)
  const switchView = (view: string, on: boolean) => {
    const next = new Set(views)
    if (on) next.add(view)
    else next.delete(view)
    setViews(next)
    setLeaving(next.size === 0 && views.size > 0 ? views : null)
  }
  return (
    <FilePreviewProvider sessionId="team-brain" commentsEnabled={false}>
      <WorkflowProvider sessionId="team-brain">
        <div className="file-preview-container relative flex min-h-0 min-w-0 flex-1" data-testid="file-preview-container">
          <OverviewBody
            agent={agent}
            settingsOpen={settingsOpen}
            onSettingsOpenChange={setSettingsOpen}
            views={views}
            record={views.size > 0 ? views : (leaving ?? views)}
            recordLeaving={views.size === 0 && leaving !== null}
            onViewChange={switchView}
            onRecordLeft={() => setLeaving(null)}
          />
          <TrayManager agentSlug={PREVIEW_SLUG} sessionId="team-brain" browserActive={false} filePreviewWideLayout="overlay" />
        </div>
      </WorkflowProvider>
    </FilePreviewProvider>
  )
}

/** The Team Brain agent's attachment of the drive its record names. */
function useBrainMount(agent: ApiAgent) {
  const { data: mounts } = useAgentMounts(agent.slug)
  return mounts?.find((mount) => mount.volumeId === agent.teamBrain?.volumeId)
}

/** Where the Team Brain agent's drive lives, from the drive itself; none while it has no drive. */
function useTeamBrainLocation(agent: ApiAgent) {
  const type = useBrainMount(agent)?.type
  return type ? teamBrainLocation(type) : null
}

/** Team Brain's scheduled tasks still to run or paused, whatever they are named: set-up makes one, the agent may add others. */
function useBrainTasks(agentSlug: string): ApiScheduledTask[] {
  const { data: tasks } = useScheduledTasks(agentSlug)
  const live = (tasks ?? []).filter((task) => task.status === 'pending' || task.status === 'paused')
  // Dev builds can stand a state in for them (team-brain-dev-states.tsx).
  return devTasks(useTeamBrainDevStates().upkeep, live)
}

const isoOf = (at: Date | string | null) => (at ? new Date(at).toISOString() : null)

/** Whether it keeps up on its own: a task runs on schedule, every one is paused, or it has none. */
function syncLine(active: boolean, tasks: ApiScheduledTask[]) {
  return tasks.length === 0 ? 'Not scheduled' : active ? 'Active' : 'Paused'
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
  views,
  record,
  recordLeaving,
  onViewChange,
  onRecordLeft,
}: {
  agent: ApiAgent
  settingsOpen: boolean
  onSettingsOpenChange: (open: boolean) => void
  /** The record's views switched on in Views. */
  views: ReadonlySet<string>
  /** The views the tree shows: those, or while the last is drawing back in, the ones that were. */
  record: ReadonlySet<string>
  recordLeaving: boolean
  onViewChange: (view: string, on: boolean) => void
  onRecordLeft: () => void
}) {
  const agentSlug = agent.slug
  useMinuteClock()

  // The Team Brain agent's drive, read as far as the tree shows and further as folders open.
  const volumeId = agent.teamBrain?.volumeId
  const { data: mounts } = useAgentMounts(agentSlug)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  // Dev builds can stand a state in for the drive and the summaries (team-brain-dev-states.tsx); live otherwise.
  const dev = useTeamBrainDevStates()
  const read = useTeamBrainDrive(agentSlug, volumeId, expanded, record, recordLeaving)
  const { drive, ready, error } = devDrive(dev.drive, read)
  // Opened on the loading middle: the tree then grows from it rather than popping its middle in again.
  const [openedLoading] = useState(() => !ready)
  // The loading middle stays until its line has gone back out, so the tree starts after it rather than over it.
  const [loadingDone, setLoadingDone] = useState(() => ready)
  const finishLoading = useCallback(() => setLoadingDone(true), [])
  const location = useTeamBrainLocation(agent)
  const recordParts = read.recordParts
  const noDrive = dev.drive === 'none' || (!!mounts && !mounts.some((mount) => mount.volumeId === volumeId))
  const { front, index, rest } = useMemo(() => splitFrontPages(drive), [drive])
  const tasks = useBrainTasks(agentSlug)
  const active = tasks.some((task) => task.status === 'pending')
  const liveSyncs = useTeamBrainSyncs(agentSlug, volumeId)
  const { syncs, unreadable: syncsUnreadable } = devSyncs(dev.syncs, { syncs: liveSyncs.data ?? [], unreadable: liveSyncs.isError })
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
  // Beside the page the panel sits out of the column's flow, so a short column (no syncs yet) would end above the
  // panel's foot and the page could not scroll the panel clear of the bottom. The column grows to at least its height.
  const [panelHeight, setPanelHeight] = useState(0)

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a pointer convenience; each drawer has its own close button
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background" onClick={closeDrawersOnClickOff}>
      {error && !noDrive && <DriveErrorBanner error={error} partial={ready} />}
      {DEV_STATES_ENABLED && <TeamBrainDevStatesMenu className="absolute bottom-3 left-3 z-40" />}
      <SettingsPageContainer className={cn(PAGE_WIDTH, 'space-y-8')} scrollContainerRef={scrollRef}>
        {/* The centrepiece: what Team Brain knows, as a tree floating on the page with no frame around it. It fills the
            view down to where the composer peeks in and stays where it is as the page scrolls, so what follows passes over it.
            Held back until its first view is listed, so the opening plays once over the whole of it. A drive it can't read
            says so where the tree would be. */}
        <div ref={treeRef} className="sticky z-0" style={{ top: treeTop }} data-testid="team-brain-tree-layer">
          {noDrive ? (
            <TreeNote height={treeHeight}>Team Brain has no drive yet.</TreeNote>
          ) : error && !ready ? (
            // What went wrong is in the banner at the top.
            <TreeNote height={treeHeight}>The tree shows once the drive can be read.</TreeNote>
          ) : ready && loadingDone && drive.length === 0 ? (
            <TreeNote height={treeHeight}>Nothing in the drive yet. Team Brain fills it as it builds the brain.</TreeNote>
          ) : ready && loadingDone ? (
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
              centreShown={openedLoading}
            />
          ) : (
            <TeamBrainRadialLoading height={treeHeight} from={location?.name ?? 'its drive'} leaving={ready} onLeft={finishLoading} />
          )}
        </div>

        {/* The page's own column. With settings open it makes room for them on the right from xl, as Agent Home's two
            columns do, while the tree behind stays exactly where it is. */}
        <div
          // Makes room on the panel's own curves (team-brain.css), so the two move as one.
          className={cn('team-brain-column relative space-y-8', settingsOpen && 'xl:pr-[392px]')}
          style={showSettings && wide && panelHeight ? { minHeight: panelHeight - 2 * PANEL_INSET } : undefined}
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
            {/* No heading of its own: the nav bar names the page, so this is just how Team Brain is doing, riding above
                the composer at its width. */}
            <header className="relative flex flex-wrap items-center justify-between gap-4" data-testid="team-brain-overview">
              {/* Once stuck, the page from the top of the view down to the composer, so summaries scrolling up go under
                  the composer instead of showing round the status row. Only then: on its way up it would blank out a
                  strip of the tree. */}
              <div aria-hidden="true" className="team-brain-dock-cover pointer-events-none absolute -inset-x-6 -bottom-7 -z-10 bg-background" style={{ top: -treeTop }} />
              {/* On the page's glass, with the composer's buttons' corners, so it reads over the tree as it passes behind. */}
              <p className={cn('flex items-center gap-1.5 rounded-md px-3 py-1 text-sm text-muted-foreground', GLASS_SURFACE)} data-testid="team-brain-status">
                <span className={cn('inline-block h-1.5 w-1.5 rounded-full', active ? 'bg-green-500' : 'bg-muted-foreground')} aria-hidden="true" />
                {syncLine(active, tasks)}
              </p>
              {/* Opens the settings panel: where it lives, the schedule, sources, agents, turning it off. */}
              <Button
                variant="ghost"
                size="icon"
                className={cn('h-8 w-8 hover:bg-background/80', GLASS_SURFACE)}
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
          <div className={cn('relative z-10 mx-auto w-full max-w-[720px] rounded-3xl px-6 pb-8 pt-8', GLASS_SURFACE)}>
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
                views={views}
                recordParts={recordParts}
                onViewChange={onViewChange}
                onHeightChange={setPanelHeight}
                // Its box reaches PANEL_INSET past its cards, so it sticks that much higher, and is twice that taller,
                // for the cards to stick level with the status row and stop 24px above the foot of the view.
                style={{ top: treeTop - PANEL_INSET, maxHeight: Math.max(viewHeight - treeTop - 24, 320) + 2 * PANEL_INSET }}
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
              views={views}
              recordParts={recordParts}
              onViewChange={onViewChange}
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
/**
 * A drive that can't be read, in the strip at the top of the page that agent pages use for their warnings and errors:
 * red when none of it could be read, yellow when the tree is up but a folder failed (that folder stays folded).
 */
function DriveErrorBanner({ error, partial }: { error: string; partial: boolean }) {
  // A listing that hangs is cut off by its own timeout, whose message ("signal timed out") says nothing to a person.
  const reason = /timed? ?out/i.test(error) ? 'It took too long to answer.' : error
  const Icon = partial ? AlertTriangle : AlertCircle
  return (
    <div role="alert" className={cn('shrink-0 border-b px-4 py-2', partial ? 'bg-yellow-500/10' : 'bg-destructive/10')} data-testid="team-brain-drive-error">
      <div className={cn('flex items-center gap-2 text-xs select-text', partial ? 'text-yellow-700 dark:text-yellow-400' : 'text-destructive')}>
        <Icon className="h-3 w-3 shrink-0" />
        <span>{`Couldn't read ${partial ? 'part of ' : ''}the Team Brain drive. ${reason}`}</span>
      </div>
    </div>
  )
}

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
function SettingsPanel({ agent, placement, open, onClose, onClosed, views, recordParts, onViewChange, onHeightChange, style }: {
  agent: ApiAgent
  /** Beside the page, in its column (sticky; `style` gives where it sticks and its tallest), or floating over it. */
  placement: 'beside' | 'over'
  open: boolean
  onClose: () => void
  /** The panel has slid out and can go. */
  onClosed: () => void
  views: ReadonlySet<string>
  /** The team record's parts there are. */
  recordParts: readonly FolderEntry[]
  onViewChange: (view: string, on: boolean) => void
  /** How tall it is, as it changes (sections opening and closing). */
  onHeightChange?: (height: number) => void
  style?: CSSProperties
}) {
  // Turning it off and changing who uses it are an admin's, as setting it up is.
  const { isAuthMode, isAdmin } = useUser()
  const canManage = !isAuthMode || isAdmin
  const panelRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel || !onHeightChange || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => onHeightChange(Math.ceil(panel.offsetHeight)))
    observer.observe(panel)
    return () => observer.disconnect()
  }, [onHeightChange])
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
      ref={panelRef}
      id="team-brain-settings"
      aria-label="Settings"
      style={style}
      data-placement={placement}
      className={cn(
        // Beside: its 360px slot plus the inset below. Over: 360px of cards plus the inset.
        placement === 'beside' ? 'sticky' : 'max-h-[calc(100%+64px)] w-[424px] max-w-[calc(100%+64px)] self-start',
        // No surface of its own, as Agent Home's side panel has none: its glass cards float on the page. Only a column
        // that scrolls when it is taller than the view.
        'pointer-events-auto -m-8 flex flex-col overflow-hidden',
        // The slide's curves are in team-brain.css, beside the page column's.
        open ? 'team-brain-settings-in' : 'team-brain-settings-out',
      )}
      data-testid="team-brain-settings"
    >
      {/* Laid out as Agent Home's side panel: the pickers in one card, the sections as rows of another, then Turn off.
          It scrolls when taller than the view, which clips it; the 32px inset (undone by the -m-8 above) puts that clip
          past the reach of the cards' soft shadows. */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-8" data-testid="team-brain-details">
        <SyncCard agentSlug={agent.slug} />
        <div className={SECTIONS_CARD_CLASS}>
          <StorageSection agent={agent} />
          <SourcesSection agentSlug={agent.slug} />
          <AgentsSection brainSlug={agent.slug} volumeId={agent.teamBrain?.volumeId} agents={agents} canManage={canManage} />
          <SessionsSection agentSlug={agent.slug} />
        </div>
        <ViewsCard parts={recordParts} views={views} onViewChange={onViewChange} />
        {/* Last, on a glass row of its own: red only in its words until hovered. */}
        {canManage && <Button
          variant="ghost"
          className={cn('h-12 w-full rounded-2xl text-destructive hover:bg-destructive/10 hover:text-destructive', GLASS_SURFACE)}
          onClick={() => setConfirmOff(true)}
          disabled={deleteAgent.isPending}
          data-testid="team-brain-turn-off"
        >
          Turn off Team Brain
        </Button>}
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

/** How far the panel's box reaches past its cards on every side (`-m-8 p-8`), so their shadows are never clipped. */
const PANEL_INSET = 32
/**
 * The page's glass, the sync summaries' sheet and the settings panel's cards alike: translucent enough that the tree
 * shows through, blurred, as the composer's does.
 */
const GLASS_SURFACE =
  'border border-border/60 bg-background/60 shadow-[0_0_24px_rgba(15,23,42,0.07),0_2px_10px_-4px_rgba(15,23,42,0.08)] backdrop-blur-xl supports-[backdrop-filter]:bg-background/40 dark:shadow-[0_0_26px_rgba(0,0,0,0.22),0_2px_12px_-4px_rgba(0,0,0,0.16)]'
/** The card the panel's sections share, as Agent Home's side panel has it: each section a row, divided from the next, clipped to the card's corners. */
const SECTIONS_CARD_CLASS = cn('overflow-hidden rounded-2xl divide-y divide-border/50', GLASS_SURFACE)
/** A section's header row, as tall as the pickers' rows. The focus ring is inset because the card clips its rows. */
const SECTION_HEADER_CLASS = 'flex min-h-12 w-full items-center justify-between gap-2 px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
/** Every label in the panel: a section's title, a picker row's name. */
const PANEL_LABEL_CLASS = 'text-[12px]/5 text-muted-foreground'
/** How many a folded section holds, in Agent Home's style for a section's count. */
const SECTION_COUNT_CLASS = 'text-[12px]/5 tabular-nums text-muted-foreground/50'

/**
 * How Team Brain keeps up, in a card of its own above the sections, as Agent Home's pickers sit above its sections:
 * every task it runs on its own is there to keep it in sync, so each is a row here.
 */
function SyncCard({ agentSlug }: { agentSlug: string }) {
  const tasks = useBrainTasks(agentSlug)
  return (
    <div className={cn('overflow-hidden rounded-2xl', GLASS_SURFACE)} data-testid="team-brain-sync">
      <p className={cn('px-4 pt-3', PANEL_LABEL_CLASS)}>Scheduled tasks</p>
      <div className="divide-y divide-border/50">
        {tasks.length > 0 ? tasks.map((task) => <SyncRow key={task.id} agentSlug={agentSlug} task={task} />) : (
          <p className="px-4 pb-3 text-[11px] text-muted-foreground" data-testid="team-brain-sync-note">No scheduled tasks</p>
        )}
      </div>
    </div>
  )
}

/** Where Team Brain lives, folded down to its home's mark and name, as the other sections are; open, a connector row that
 * opens the drive's settings, as Agent Home's Drives card does. */
function StorageSection({ agent }: { agent: ApiAgent }) {
  const location = useTeamBrainLocation(agent)
  const navigate = useNavigate()
  const mount = useBrainMount(agent)
  const hostPath = mount?.hostPath ?? null
  // Back from the drive's page returns to the agent's own page, which for Team Brain is this one.
  const openSettings = mount
    ? () => void navigate({ to: '/settings/$tab', params: { tab: 'volumes' }, search: { volume: mount.volumeId, source: 'home', from: `/agents/${encodeURIComponent(agent.slug)}` } })
    : undefined
  if (!location) return null
  const LocationIcon = location.Icon
  return (
    <PanelSection
      title="Storage location"
      summary={
        <>
          <LocationIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className={SECTION_COUNT_CLASS}>{location.name}</span>
        </>
      }
      testId="team-brain-storage-section"
    >
      {/* One row, so it sits right under the header rather than a list's gap below it. */}
      <div className="-mt-1">
        <IntegrationRow
          icon={<LocationIcon className="h-4 w-4" />}
          name={location.name}
          onActivate={openSettings}
          ariaLabel={mount ? `Open ${mount.volumeName} drive settings` : undefined}
          right={openSettings ? <RowHoverChevron /> : undefined}
          // Hovered, the row fills; the card clips it to its corners.
          className="py-2"
          data-testid="team-brain-storage"
          subtitle={
            <span className="min-w-0 truncate" data-testid="team-brain-location">
              {placeIn(mount?.sourceLabel ?? hostPath)}
            </span>
          }
        />
      </div>
    </PanelSection>
  )
}

/**
 * Where in its home a drive is, without the home's name the row already shows ("Google Drive · My Drive / Team" is
 * "My Drive / Team"), and a drive chosen whole named once ("My Drive / My Drive" is "My Drive").
 */
function placeIn(label: string | null): string | null {
  if (!label) return label
  const place = label.includes(' · ') ? label.slice(label.indexOf(' · ') + 3) : label
  const [drive, folder, ...rest] = place.split(' / ')
  return rest.length === 0 && folder !== undefined && drive === folder ? drive : place
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
 * How Team Brain keeps up, one row per scheduled task whatever it is named: when it next runs and when it last ran,
 * and on the right how often. A row opens the task's own page, where its schedule is changed and it is paused or
 * resumed. Without a task there is nothing to open.
 */
function SyncRow({ agentSlug, task }: { agentSlug: string; task: ApiScheduledTask }) {
  const navigate = useNavigate()
  const paused = task.status === 'paused'
  const schedule = scheduleOfCron(task.scheduleExpression)
  const lastRun = task.lastExecutedAt ? `last ran ${formatSince(isoOf(task.lastExecutedAt))}` : 'not run yet'
  const note = `${paused ? 'Paused' : `Syncs ${formatUntil(task.nextExecutionAt)}`} · ${lastRun}`
  // As the task's own page says it (scheduled-task-view.tsx).
  const runs = useHumanizedCron(task.scheduleExpression)
  const how = paused ? 'Paused' : schedule ? SCHEDULE_LABELS[schedule].title : 'Custom'
  return (
    <button
      type="button"
      onClick={() => void navigate({ to: '/agents/$slug/tasks/$taskId', params: { slug: agentSlug, taskId: task.id } })}
      // The focus ring is inset because the card clips its rows to its corners.
      className="flex min-h-12 w-full items-center justify-between gap-2 px-4 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      data-testid={`team-brain-sync-${task.id}`}
    >
      <span className="min-w-0">
        <span className="block truncate text-[13px]/5">{task.name ?? 'Scheduled task'}</span>
        <span className="block truncate text-[11px] text-muted-foreground" data-testid="team-brain-sync-note">{note}</span>
        {runs && (
          <span className="block truncate text-[11px] text-muted-foreground" data-testid="team-brain-schedule-runs">
            {`Runs ${runs.charAt(0).toLowerCase() + runs.slice(1)} · ${task.timezone?.replace(/_/g, ' ') || 'UTC'}`}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1" data-testid="team-brain-schedule">
        <span className={SECTION_COUNT_CLASS}>{how}</span>
        <ChevronRight className="h-4 w-4 text-muted-foreground/50" aria-hidden="true" />
      </span>
    </button>
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
function AgentsSection({ brainSlug, volumeId, agents, canManage }: { brainSlug: string; volumeId: string | undefined; agents: readonly ApiAgent[]; canManage: boolean }) {
  const access = useTeamBrainAccess(brainSlug, volumeId)
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
        <AgentAccessList agents={agents} everyAgent={access.everyAgent} isOn={access.isOn} isChanging={access.isChanging} disabled={!canManage} onToggle={access.toggle} className="border-y border-border/50" rowClassName="px-4" />
      ) : (
        <p className="px-4 text-xs text-muted-foreground">No agents yet. Agents you make later can add the Team Brain drive from their Drives.</p>
      )}
      <p className="mt-3 px-4 pb-1 text-xs text-muted-foreground">An agent that uses it reads the drive and can message Team Brain.</p>
    </PanelSection>
  )
}

/**
 * Team Brain's own sessions, its chats and each scheduled task's runs, in Agent Home's list. Its Agent Home stays out of
 * reach. The agent's list leaves scheduled runs out, as Agent Home shows them under their task, so they join it here.
 */
function SessionsSection({ agentSlug }: { agentSlug: string }) {
  const { data: chats } = useSessions(agentSlug)
  const runs = useScheduledTasksSessions(useBrainTasks(agentSlug).map((task) => task.id))
  const sessions = useMemo(() => [...(chats ?? []).map(toSessionItem), ...runs], [chats, runs])
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

/** The team record's usual parts, each a view of its own, in the order they're listed. */
const RECORD_VIEWS: readonly { id: string; name: string }[] = [
  { id: 'rules', name: 'Show rules' },
  { id: 'sources', name: 'Show sources' },
  { id: 'changelog', name: 'Show changelog' },
  { id: 'archive', name: 'Show archive' },
  { id: 'syncs', name: 'Show sync summaries' },
  { id: 'index', name: "Show agents' index" },
]
/** Any other part the agent keeps in `_brain`, named after its file. */
const partName = (part: FolderEntry) => `Show ${part.name.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').toLowerCase()}`

/**
 * Which parts of Team Brain's own record the tree shows, in a folded card of their own below the sections, as Sync has
 * one above: a switch for each of the record's usual parts, whether or not the agent has written it yet, and for anything
 * else it keeps in `_brain`. All off by default, so the tree is the team's knowledge until one is asked for.
 */
function ViewsCard({ parts, views, onViewChange }: { parts: readonly FolderEntry[]; views: ReadonlySet<string>; onViewChange: (view: string, on: boolean) => void }) {
  const written = new Set(parts.map(teamRecordView))
  const extras = parts.filter((part) => !RECORD_VIEWS.some((view) => view.id === teamRecordView(part))).map((part) => ({ id: teamRecordView(part), name: partName(part) }))
  const all = [...RECORD_VIEWS, ...extras]
  const on = all.filter((view) => views.has(view.id)).length
  return (
    // A card of its own, folded by default like the sections: the header says how many views are on.
    <div className={cn('overflow-hidden rounded-2xl', GLASS_SURFACE)}>
      <PanelSection title="Views" summary={<span className={SECTION_COUNT_CLASS} data-testid="team-brain-views-count">{on > 0 ? `${on} on` : 'Off'}</span>} testId="team-brain-views">
        <ul className="-mt-1 pb-1">
          {all.map((view) => {
            const id = `team-brain-view-${view.id}`
            return (
              <li key={view.id} className="flex items-center justify-between gap-2 px-4 py-1.5">
                <label htmlFor={id} className="min-w-0">
                  <span className="block truncate text-xs">{view.name}</span>
                  {!written.has(view.id) && <span className="block text-[11px] text-muted-foreground">Not written yet</span>}
                </label>
                <Switch id={id} checked={views.has(view.id)} onCheckedChange={(checked) => onViewChange(view.id, checked)} data-testid={id} />
              </li>
            )
          })}
        </ul>
      </PanelSection>
    </div>
  )
}

const formatSessionDate = (date: string) => formatDistanceToNow(new Date(date), { addSuffix: true })
