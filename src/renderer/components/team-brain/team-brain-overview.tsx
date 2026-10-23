import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { ArrowUpRight, Check, ChevronDown, PanelRightClose, Plus, Settings2 } from 'lucide-react'
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
import { DrawerShell } from '@renderer/components/tray/drawer-shell'
import { formatNextSync, formatSince, SCHEDULE_LABELS } from '@renderer/lib/team-brain/team-brain-format'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { StatusToggle } from '@renderer/components/triggers/status-toggle'
import { TeamBrainRadial } from './team-brain-radial'
import { TeamBrainSyncSummaries } from './team-brain-sync-summaries'
import { TeamBrainSourceIcon } from './team-brain-source-icon'
import { teamBrainLocation } from './team-brain-locations'

/** The drawer's tabs are keyed by agent; Team Brain's pages are no agent's, so they get their own key. */
const PREVIEW_SLUG = 'team-brain'

/**
 * Team Brain once it is set up: its home page, for its agent. The app's file
 * drawer sits beside it (set up as on Agent Home) so a page in the drive opens
 * like any other file, with its settings in a drawer of the same kind; one
 * drawer shows at a time. The agent and where its drive lives are real; the
 * drive's pages, the sync summaries and the sync status are mock for now (see
 * `team-brain-live.ts`).
 */
export function TeamBrainOverview({ agent }: { agent: ApiAgent }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  return (
    <FilePreviewProvider sessionId="team-brain" commentsEnabled={false}>
      <WorkflowProvider sessionId="team-brain">
        <div className="file-preview-container relative flex min-h-0 min-w-0 flex-1" data-testid="file-preview-container">
          <OverviewBody settingsOpen={settingsOpen} onSettingsOpenChange={setSettingsOpen} />
          <TrayManager agentSlug={PREVIEW_SLUG} sessionId="team-brain" browserActive={false} filePreviewWideLayout="overlay" />
          <SettingsDrawer agent={agent} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
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
 * settings drawer.
 */
function OverviewBody({ settingsOpen, onSettingsOpenChange }: { settingsOpen: boolean; onSettingsOpenChange: (open: boolean) => void }) {
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
  // A click on the page behind an open drawer puts it away, unless it is what opened one: a [data-drawer-opener],
  // or a page on the tree, whose click the tree keeps to itself. A page clicked while another is showing swaps the
  // file rather than closing the drawer and opening it again.
  const closeDrawersOnClickOff = (event: ReactMouseEvent) => {
    if (!filesOpen && !settingsOpen) return
    if (event.target instanceof Element && event.target.closest('[data-drawer-opener]')) return
    closeFiles()
    onSettingsOpenChange(false)
  }

  // What an agent told Team Brain between syncs is credited to a real agent that uses it.
  const writer = agents.find((a) => usesTeamBrain(state, a.slug))

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a pointer convenience; each drawer has its own close button
    <div className="flex min-h-0 flex-1 flex-col bg-background" onClick={closeDrawersOnClickOff}>
      <SettingsPageContainer className="max-w-[1040px] space-y-8">
        {/* No heading of its own: the nav bar names the page, so the header is just how Team Brain is doing. */}
        <header className="flex flex-wrap items-center justify-between gap-4" data-testid="team-brain-overview">
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="team-brain-status">
            <span className={cn('inline-block h-1.5 w-1.5 rounded-full', live.syncPaused ? 'bg-muted-foreground' : 'bg-green-500')} aria-hidden="true" />
            {live.syncPaused ? 'Paused' : 'Active'} · Synced {formatSince(live.lastSyncAt)}
          </p>
          {/* Opens the settings drawer: where it lives, the schedule, sources, agents, turning it off. */}
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

        {/* The centrepiece: what Team Brain knows, as a tree floating on the page with no frame around it. */}
        <TeamBrainRadial drive={drive} onOpenFile={openPage} height={DRIVE_HEIGHT} />

        {/* What each sync filed, read like a changelog. */}
        <TeamBrainSyncSummaries drive={drive} schedule={state.schedule} lastSyncAt={live.lastSyncAt} writer={writer ?? null} onOpenFile={openPage} />
      </SettingsPageContainer>
    </div>
  )
}

/** The tree's height: tall enough to lead the page. */
const DRIVE_HEIGHT = 680

/**
 * Where Team Brain lives, how it syncs, what it reads and which agents share
 * it, in the app's side drawer over the page (as files open here). It stays
 * mounted while it slides shut, then empties; Escape closes it.
 */
function SettingsDrawer({ agent, open, onClose }: { agent: ApiAgent; open: boolean; onClose: () => void }) {
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
  const [mounted, setMounted] = useState(open)
  useEffect(() => {
    if (open) setMounted(true)
  }, [open])
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
    <DrawerShell
      isOpen={open}
      storageKey="team_brain_settings_drawer_width"
      wideOverlay
      defaultWidth={380}
      onTransitionEnd={(event) => {
        if (!open && event.target === event.currentTarget) setMounted(false)
      }}
    >
      {mounted && (
        // One off-white for the whole panel, header and all, so its white cards stand out.
        <div id="team-brain-settings" className="flex min-h-0 flex-1 flex-col bg-[#fbfbfb] dark:bg-background" data-testid="team-brain-settings">
          <div className="flex shrink-0 select-none items-center gap-2 border-b border-border/40 px-4 py-2 text-sm text-muted-foreground">
            <Settings2 className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate text-xs font-medium">Settings</span>
            <button
              type="button"
              className="rounded p-0.5 transition-colors hover:bg-muted"
              onClick={onClose}
              title="Hide settings"
              aria-label="Hide settings"
              data-testid="team-brain-settings-close"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <TeamBrainDetails agentSlug={agent.slug} />
            <SourcesSection sources={live.sources} lastSyncAt={live.lastSyncAt} />
            <AgentsSection agents={agents} />
          </div>
          {/* Pinned to the foot of the drawer, below everything that scrolls; as wide as the cards, red only in its words until hovered. */}
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
        </div>
      )}
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
    </DrawerShell>
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
