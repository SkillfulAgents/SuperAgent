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
import { usesTeamBrain, useTeamBrain } from '@renderer/lib/team-brain/team-brain-store'
import { useTeamBrainLive } from '@renderer/lib/team-brain/team-brain-live'
import { TEAM_BRAIN_LOCATION_IDS, TEAM_BRAIN_SCHEDULES, TEAM_BRAIN_SOURCE_IDS, type TeamBrainLocationId, type TeamBrainSourceId } from '@renderer/lib/team-brain/team-brain-schema'
import { TEAM_BRAIN_SOURCES, teamBrainSource } from '@renderer/lib/team-brain/team-brain-sources'
import { teamBrainDrive, type TeamBrainNode } from '@renderer/lib/team-brain/team-brain-structure'
import { teamBrainFileMarkdown } from '@renderer/lib/team-brain/team-brain-files'
import { FilePreviewProvider, useFilePreview } from '@renderer/context/file-preview-context'
import { WorkflowProvider } from '@renderer/context/workflow-context'
import { TrayManager } from '@renderer/components/tray/tray-manager'
import { HomeCollapsible } from '@renderer/components/agents/agent-home/home-collapsible'
import { IntegrationRow, RowHoverChevron } from '@renderer/components/connections/integration-row'
import { openExternalUrl } from '@renderer/lib/open-external'
import { toast } from 'sonner'
import { formatNextSync, formatSince, SCHEDULE_LABELS } from '@renderer/lib/team-brain/team-brain-format'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { StatusToggle } from '@renderer/components/triggers/status-toggle'
import { TeamBrainRadial } from './team-brain-radial'
import { TeamBrainSyncSummaries } from './team-brain-sync-summaries'
import { TeamBrainHomeComposer } from './team-brain-home-composer'
import { TeamBrainSourceIcon } from './team-brain-source-icon'
import { teamBrainLocation } from './team-brain-locations'

/** The drawer's tabs are keyed by agent; Team Brain's pages are no agent's, so they get their own key. */
const PREVIEW_SLUG = 'team-brain'

/**
 * Team Brain once it is set up: its home page, for its agent. The app's file
 * drawer sits beside it (set up as on Agent Home) so a page in the drive opens
 * like any other file, and its settings open as a second column; the file
 * drawer and the settings never show together. The agent and where its drive lives are real; the
 * drive's pages, the sync summaries and the sync status are mock for now (see
 * `team-brain-live.ts`).
 */
export function TeamBrainOverview({ agent }: { agent: ApiAgent }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  return (
    <FilePreviewProvider sessionId="team-brain" commentsEnabled={false}>
      <WorkflowProvider sessionId="team-brain">
        <div className="file-preview-container relative flex min-h-0 min-w-0 flex-1" data-testid="file-preview-container">
          <OverviewBody agent={agent} settingsOpen={settingsOpen} onSettingsOpenChange={setSettingsOpen} />
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

/**
 * How it is doing, the drive it keeps and what each sync filed into it. The levers
 * (sources, schedule, which agents share it) are a button away, in the
 * settings panel, which makes the page two columns.
 */
function OverviewBody({ agent, settingsOpen, onSettingsOpenChange }: { agent: ApiAgent; settingsOpen: boolean; onSettingsOpenChange: (open: boolean) => void }) {
  const { state } = useTeamBrain()
  const { state: live } = useTeamBrainLive()
  const { data: agents = [] } = useListedAgents()
  useMinuteClock()

  // A running Team Brain has built up a whole team's wiki, so the mock drive is all of it.
  const drive = useMemo(() => teamBrainDrive(TEAM_BRAIN_SOURCE_IDS), [])
  // A page opens in the file drawer, read from its own text rather than an agent's workspace.
  const { openFile, close: closeFiles, isOpen: filesOpen } = useFilePreview()
  const openPage = (file: TeamBrainNode, { path, folder }: { path: string; folder?: TeamBrainNode }) => {
    const url = `data:text/markdown;charset=utf-8,${encodeURIComponent(teamBrainFileMarkdown(file, folder))}`
    onSettingsOpenChange(false)
    openFile(`/Team Brain${path}`, PREVIEW_SLUG, undefined, { inlineUrl: url, downloadUrl: url })
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

  // What an agent told Team Brain between syncs is credited to a real agent that uses it.
  const writer = agents.find((a) => usesTeamBrain(state, a.slug))

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a pointer convenience; each drawer has its own close button
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background" onClick={closeDrawersOnClickOff}>
      <SettingsPageContainer className={cn(PAGE_WIDTH, 'space-y-8')} scrollContainerRef={scrollRef}>
        {/* The centrepiece: what Team Brain knows, as a tree floating on the page with no frame around it. It fills the
            view down to where the composer peeks in and stays where it is as the page scrolls, so what follows passes over it. */}
        <div ref={treeRef} className="sticky z-0" style={{ top: treeTop }} data-testid="team-brain-tree-layer">
          <TeamBrainRadial drive={drive} onOpenFile={openPage} height={treeHeight} />
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
            {/* No heading of its own: the nav bar names the page, so this is just how Team Brain is doing, riding above
                the composer at its width. */}
            <header className="relative flex flex-wrap items-center justify-between gap-4" data-testid="team-brain-overview">
              {/* Once stuck, the page from the top of the view down to the composer, so summaries scrolling up go under
                  the composer instead of showing round the status row. Only then: on its way up it would blank out a
                  strip of the tree. */}
              <div aria-hidden="true" className="team-brain-dock-cover pointer-events-none absolute -inset-x-6 -bottom-7 -z-10 bg-background" style={{ top: -treeTop }} />
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="team-brain-status">
                <span className={cn('inline-block h-1.5 w-1.5 rounded-full', live.syncPaused ? 'bg-muted-foreground' : 'bg-green-500')} aria-hidden="true" />
                {live.syncPaused ? 'Paused' : 'Active'} · Synced {formatSince(live.lastSyncAt)}
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
            <TeamBrainSyncSummaries drive={drive} schedule={state.schedule} lastSyncAt={live.lastSyncAt} writer={writer ?? null} onOpenFile={openPage} />
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
            <SettingsPanel agent={agent} placement="over" open={settingsOpen} onClose={() => onSettingsOpenChange(false)} onClosed={settingsClosed} />
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
function SettingsPanel({ agent, placement, open, onClose, onClosed, style }: {
  agent: ApiAgent
  /** Beside the page, in its column (sticky; `style` gives where it sticks and its tallest), or floating over it. */
  placement: 'beside' | 'over'
  open: boolean
  onClose: () => void
  /** The panel has slid out and can go. */
  onClosed: () => void
  style?: CSSProperties
}) {
  const { state: live } = useTeamBrainLive()
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
        'pointer-events-auto flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-background/70 shadow-[0_8px_40px_rgba(15,23,42,0.12),0_2px_10px_-4px_rgba(15,23,42,0.1)] backdrop-blur-xl supports-[backdrop-filter]:bg-background/55 dark:shadow-[0_8px_40px_rgba(0,0,0,0.4),0_2px_12px_-4px_rgba(0,0,0,0.3)]',
        // The slide's curves are in globals.css, beside the page column's.
        open ? 'team-brain-settings-in' : 'team-brain-settings-out',
      )}
      data-testid="team-brain-settings"
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <TeamBrainDetails agentSlug={agent.slug} />
        <SourcesSection sources={live.sources} lastSyncAt={live.lastSyncAt} />
        <AgentsSection agents={agents} />
      </div>
      {/* Pinned to the foot of the panel, below everything that scrolls; as wide as the cards, red only in its words until hovered. */}
      <div className="shrink-0 border-t border-border/40 p-4">
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
              are, and agents that have the drive keep it. You can set Team Brain up again any time.
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

/**
 * Where Team Brain lives and how it keeps up, a card each in the cron page's
 * style: whether it is syncing (its toggle pauses that; agents still read what
 * is already there), how often, and where it lives.
 */
function TeamBrainDetails({ agentSlug }: { agentSlug: string }) {
  const { state } = useTeamBrain()
  const live = useTeamBrainLive()
  const location = useTeamBrainLocation(agentSlug)
  const LocationIcon = location.Icon
  return (
    <div className="space-y-4" data-testid="team-brain-details">
      <DetailCard
        label="Sync"
        headerActions={
          <StatusToggle
            status={live.state.syncPaused ? 'paused' : 'active'}
            isActive
            isPaused={live.state.syncPaused}
            canToggle
            onToggle={(on) => live.setSyncPaused(!on)}
            ariaLabelResume="Resume syncing"
            ariaLabelPause="Pause syncing"
          />
        }
      >
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Next:</dt>
            <dd>{live.state.syncPaused ? 'Paused' : formatNextSync(state.schedule, live.state.lastSyncAt)}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Last:</dt>
            <dd>{formatSince(live.state.lastSyncAt)}</dd>
          </div>
        </dl>
      </DetailCard>

      {/* How often it syncs, in the row and picker Agent Home uses for its default model and auto-delete. */}
      <div className="rounded-xl border bg-background">
        <ScheduleRow />
      </div>

      {/* Where it lives, laid out as one of the Sources card's connector rows; it opens there when the place has a link. */}
      <section className="rounded-xl border bg-background py-4">
        <h3 className="px-4 text-sm font-medium text-muted-foreground">Storage location</h3>
        <div className="mt-2">
          <IntegrationRow
            icon={<LocationIcon className="h-4 w-4" />}
            name={location.name}
            onActivate={location.url ? () => void openExternalUrl(location.url!) : undefined}
            ariaLabel={location.url ? `Open Team Brain in ${location.name}` : undefined}
            right={location.url ? <RowHoverChevron icon={<ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />} /> : undefined}
            data-testid="team-brain-storage"
            subtitle={
              <span className="min-w-0 truncate" data-testid="team-brain-location">
                {location.target}
              </span>
            }
          />
        </div>
      </section>
    </div>
  )
}

/**
 * How often Team Brain syncs, as one of Agent Home's preference rows: the
 * label, and an outlined trigger whose popover lists the choices with what
 * each trades away. A pick doesn't close it, as the model picker's don't.
 */
function ScheduleRow() {
  const tb = useTeamBrain()
  const { schedule } = tb.state
  const title = SCHEDULE_LABELS[schedule].title
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-2" data-testid="team-brain-schedule">
      <span className="text-sm font-medium text-muted-foreground">Schedule</span>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-[34px] justify-between gap-1.5 px-2 text-xs font-medium"
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
                  onClick={() => tb.setSchedule(option)}
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

/** A few overlapping marks and how many there are in all, for a folded card's header. */
function StackSummary({ marks, count }: { marks: ReactNode[]; count: number }) {
  return (
    <>
      <span className="flex -space-x-1.5" aria-hidden="true">
        {marks.slice(0, 4)}
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
    </>
  )
}

/** The apps Team Brain reads, folded down to their logos, in Agent Home's own card and rows. Open it to see when each was read, or change them. */
function SourcesSection({ sources, lastSyncAt }: { sources: readonly TeamBrainSourceId[]; lastSyncAt: string | null }) {
  const marks = sources.map((id) => (
    <span key={id} className="grid size-[18px] place-items-center rounded-full bg-background ring-2 ring-background">
      <TeamBrainSourceIcon id={id} className="size-3" />
    </span>
  ))
  return (
    <HomeCollapsible title="Sources" defaultOpen={false} summary={<StackSummary marks={marks} count={sources.length} />} testId="team-brain-sources">
      <div className="mt-2 divide-y divide-border/50">
        {sources.map((id) => (
          <IntegrationRow
            key={id}
            icon={<TeamBrainSourceIcon id={id} className="h-4 w-4" />}
            name={teamBrainSource(id).name}
            subtitle={<>Read {formatSince(lastSyncAt)}</>}
          />
        ))}
      </div>
      <div className="mt-3 flex items-center justify-end px-4 pb-1">
        <ManageSources hasSources={sources.length > 0} />
      </div>
    </HomeCollapsible>
  )
}

/** Which agents share Team Brain, folded down to their avatars, in Agent Home's own card and rows. Open it to switch any of them off or on. */
function AgentsSection({ agents }: { agents: readonly ApiAgent[] }) {
  const tb = useTeamBrain()
  const marks = agents.map((agent) => (
    <span key={agent.slug} className="rounded-full ring-2 ring-background">
      <AgentAvatar agent={agent} size={18} />
    </span>
  ))
  return (
    <HomeCollapsible title="Agents" defaultOpen={false} summary={<StackSummary marks={marks} count={agents.length} />} testId="team-brain-agents">
      {agents.length === 0 ? (
        <div className="mx-4 mt-3 rounded-lg border border-dashed p-4 text-muted-foreground">
          <p className="text-xs font-medium text-foreground">No agents yet</p>
          <p className="mt-1 text-xs">New agents get Team Brain automatically.</p>
        </div>
      ) : (
        <>
          <div className="mt-2 divide-y divide-border/50">
            {agents.map((agent) => {
              const connected = usesTeamBrain(tb.state, agent.slug)
              return (
                <IntegrationRow
                  key={agent.slug}
                  icon={<AgentAvatar agent={agent} size={20} />}
                  name={agent.name}
                  subtitle={connected ? 'Uses Team Brain' : 'Off'}
                  muted={!connected}
                  right={
                    <Switch
                      checked={connected}
                      onCheckedChange={(checked) => tb.setUsesTeamBrain(agent.slug, checked)}
                      aria-label={`${connected ? 'Disconnect' : 'Connect'} ${agent.name}`}
                      data-testid={`team-brain-agent-${agent.slug}`}
                    />
                  }
                />
              )
            })}
          </div>
          <p className="mt-3 px-4 pb-1 text-xs text-muted-foreground">An agent that uses it reads the drive and can message Team Brain.</p>
        </>
      )}
    </HomeCollapsible>
  )
}

/** Add or remove sources in place, from a footer button like Agent Home's Connections; the mock connects on the spot. */
function ManageSources({ hasSources }: { hasSources: boolean }) {
  const live = useTeamBrainLive()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" data-testid="team-brain-manage-sources">
          {hasSources ? <Settings2 /> : <Plus />}
          {hasSources ? 'Manage Sources' : 'Add Source'}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1">
        {TEAM_BRAIN_SOURCES.map((source) => {
          const connected = live.state.sources.includes(source.id)
          return (
            <button
              key={source.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={connected}
              onClick={() => live.setSourceConnected(source.id, !connected)}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
            >
              <TeamBrainSourceIcon id={source.id} className="h-3.5 w-3.5" />
              <span className="flex-1">{source.name}</span>
              {connected && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
