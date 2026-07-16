/**
 * Custom React Flow nodes for the home connections graph.
 *
 * Agent nodes are rounded cards; resource nodes (accounts, MCPs,
 * triggers, chat integrations) are bare icon chips — their health shows
 * through the edge styling (red dashes) and the hover label, not on the
 * node itself. Handles are invisible and centered so straight edges radiate from
 * node centers, mind-map style.
 */

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Handle, NodeToolbar, Position, useStore, type Node, type NodeProps } from '@xyflow/react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowUpRight, Webhook, Timer } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { getAgentActivityStatus, type AgentActivityStatus } from '@shared/lib/types/agent-activity-status'
import { AgentStatus } from '@renderer/components/agents/agent-status'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { useAgentActivityStats } from '@renderer/hooks/use-activity-stats'
import {
  ActivitySparkChart,
  ActivitySparkChartSkeleton,
  CronSparkChart,
} from '@renderer/components/activity/activity-spark-chart'
import type { AgentNodeData, GraphNodeData, ResourceKind, ResourceNodeData, ResourceTone } from './use-graph-data'

const centerHandleStyle: CSSProperties = {
  left: '50%',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  opacity: 0,
  pointerEvents: 'none',
}

// Nodes select on click (React Flow selection); re-dispatching a click from
// Enter/Space gives keyboard users the same path without duplicating logic.
function activateOnKey(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  event.currentTarget.click()
}

type NavigateFn = ReturnType<typeof useNavigate>

/**
 * Navigate to the page behind a graph node. Click is selection now, so this
 * runs from the selected node's "Open" toolbar and from double-click.
 */
export function openGraphNode(navigate: NavigateFn, data: GraphNodeData): void {
  switch (data.kind) {
    case 'agent':
      void navigate({ to: '/agents/$slug', params: { slug: data.agent.displaySlug } })
      return
    case 'account':
    case 'mcp':
      void navigate({ to: '/settings/$tab', params: { tab: 'connections' } })
      return
    case 'webhook':
      if (data.agentSlug)
        void navigate({
          to: '/agents/$slug/webhooks/$webhookId',
          params: { slug: data.agentSlug, webhookId: data.resourceId },
        })
      return
    case 'cron':
      if (data.agentSlug)
        void navigate({
          to: '/agents/$slug/tasks/$taskId',
          params: { slug: data.agentSlug, taskId: data.resourceId },
        })
      return
    case 'chat':
      if (data.agentSlug)
        void navigate({
          to: '/agents/$slug/chat/$integrationId',
          params: { slug: data.agentSlug, integrationId: data.resourceId },
        })
      return
  }
}

/** Floating "Open" chip under a selected node — the navigation affordance.
 *  Below, not above: a node near the canvas top would put an above-toolbar
 *  underneath the app header, which steals the click. */
function OpenToolbar({ data }: { data: GraphNodeData }) {
  const navigate = useNavigate()
  return (
    <NodeToolbar position={Position.Bottom} offset={10}>
      <button
        type="button"
        className="flex items-center gap-1 rounded-md border border-border/60 bg-card px-1.5 py-1 text-2xs text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
        onClick={(event) => {
          event.stopPropagation()
          openGraphNode(navigate, data)
        }}
        data-testid="graph-node-open"
      >
        <ArrowUpRight className="h-3 w-3" />
        Open
      </button>
    </NodeToolbar>
  )
}

function CenterHandles() {
  return (
    <>
      <Handle type="source" position={Position.Top} style={centerHandleStyle} isConnectable={false} />
      <Handle type="target" position={Position.Top} style={centerHandleStyle} isConnectable={false} />
    </>
  )
}

const PORT_POSITIONS: Record<string, Position> = {
  top: Position.Top,
  bottom: Position.Bottom,
  left: Position.Left,
  right: Position.Right,
}

/**
 * The four connection points (N/S/E/W) on the node's visible shape, shown
 * while it's selected. Real React Flow handles: the handle itself is an
 * invisible hit zone ~2× the dot; the child .port-dot stages FigJam-style
 * (rest dot → circled arrow on zone hover → filled arrow + .port-ghost
 * drag preview on direct hover). When connectable, dragging one out draws
 * a new connection (drop targets snap within ReactFlow's connectionRadius).
 * All styling/state lives in agent-graph.css (.graph-port).
 */
function ConnectPorts({ connectable }: { connectable: boolean }) {
  return (
    <>
      {(['top', 'bottom', 'left', 'right'] as const).map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={PORT_POSITIONS[side]}
          className="graph-port"
          isConnectable={connectable}
        >
          <span className="port-hit" aria-hidden />
          <span className="port-dot" aria-hidden />
          <span className="port-ghost" aria-hidden />
        </Handle>
      ))}
    </>
  )
}

const agentBorder: Record<AgentActivityStatus, string> = {
  working: 'border-green-500/50',
  awaiting_input: 'border-orange-500/60',
  idle: 'border-border/60',
  sleeping: 'border-border/60',
}

export function AgentGraphNode({ data }: NodeProps<Node<AgentNodeData, 'agent'>>) {
  const { agent } = data
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Agent ${agent.name}`}
      onKeyDown={activateOnKey}
      className={cn(
        'group relative flex h-20 w-44 cursor-pointer flex-col rounded-xl border-[0.5px] bg-card px-3 py-2.5 shadow-sm transition-[box-shadow,transform] duration-300 hover:-translate-y-0.5 hover:shadow-lg',
        agentBorder[
          getAgentActivityStatus(
            agent.status,
            agent.hasActiveSessions ?? false,
            agent.hasSessionsAwaitingInput ?? false,
          )
        ],
      )}
      data-testid={`graph-node-agent-${agent.slug}`}
    >
      <OpenToolbar data={data} />
      <ConnectPorts connectable />
      {/* Traditional card header: title top-left, icon-only status top-right */}
      <div className="flex w-full items-start justify-between gap-2">
        <span className="line-clamp-2 min-w-0 break-words text-left text-xs">{agent.name}</span>
        <AgentStatus
          status={agent.status}
          hasActiveSessions={agent.hasActiveSessions ?? false}
          hasSessionsAwaitingInput={agent.hasSessionsAwaitingInput ?? false}
          iconOnly
          className="mt-0.5 shrink-0"
        />
      </div>
      <CenterHandles />
    </div>
  )
}

const toneDot: Record<ResourceTone, string> = {
  ok: 'bg-green-500',
  muted: 'bg-muted-foreground/50',
  attention: 'bg-orange-500',
  error: 'bg-red-500',
}

/** Kind eyebrow on the detail card — disambiguates e.g. a GitHub account
 *  from a GitHub MCP server, which share the same chip logo. */
const KIND_LABEL: Record<ResourceKind, string> = {
  account: 'API connection',
  mcp: 'MCP server',
  webhook: 'Webhook',
  cron: 'Scheduled task',
  chat: 'Chat integration',
}

// Status badge in the hover pill — same palette as the agent homepage
// sidebar cards (home-triggers/home-connections status pills).
const toneBadge: Record<ResourceTone, string> = {
  ok: 'bg-green-500/10 text-green-700 dark:text-green-400',
  muted: 'bg-muted text-muted-foreground',
  attention: 'bg-orange-500/10 text-orange-700 dark:text-orange-400',
  error: 'bg-red-500/10 text-red-700 dark:text-red-400',
}

function ResourceIcon({ data }: { data: ResourceNodeData }) {
  // One size + muted stroke for every generic icon; the color class is inert
  // on real service logos (they're <img>s).
  const className = 'h-5 w-5 text-muted-foreground'
  switch (data.kind) {
    case 'account':
      return <ServiceIcon slug={data.iconSlug} fallback="blocks" className={className} />
    case 'chat':
      return <ServiceIcon slug={data.iconSlug} fallback="request" className={className} />
    case 'mcp':
      return <ServiceIcon slug={data.iconSlug} fallback="blocks" className={className} />
    case 'webhook':
      return <Webhook className={className} />
    case 'cron':
      return <Timer className={className} />
  }
}

export function ResourceGraphNode({ data, selected }: NodeProps<Node<ResourceNodeData, 'resource'>>) {
  const navigate = useNavigate()
  // Card pins open on selection, or globally via the details-view toggle.
  const pinned = selected || !!data.showDetails
  // Hover-open state with a short grace period, so the cursor can cross the
  // gap from the chip onto the card (and click Settings there) without the
  // card fading out mid-journey.
  const [hoverOpen, setHoverOpen] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    setHoverOpen(true)
  }
  const scheduleCloseHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setHoverOpen(false), 150)
  }
  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
  }, [])
  const shown = pinned || hoverOpen
  // Activity spark charts (crons + webhooks) — same rollup the agent
  // homepage sidebar cards use. Keyed per owning agent, so react-query
  // dedupes the fetch across all of that agent's trigger nodes; other
  // resource kinds pass null and never fetch.
  const wantsActivity = data.kind === 'cron' || data.kind === 'webhook'
  const { data: activityStats, isPending: activityPending } = useAgentActivityStats(
    wantsActivity ? (data.agentSlug ?? null) : null,
  )
  // Counter-scale the detail pill so it renders at true text size at every
  // zoom level (transform[2] = zoom; selecting just it skips pan re-renders).
  const zoom = useStore((s) => s.transform[2])
  // No `title` attr: the OS tooltip would race the fade-in label with the
  // same text.
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${data.kind} ${data.label} — ${data.statusLabel}`}
      onKeyDown={activateOnKey}
      className="relative flex w-32 cursor-pointer flex-col items-center gap-1"
      data-testid={`graph-node-${data.kind}-${data.resourceId}`}
    >
      {/* Only the chip (not the node's empty label slot) opens the hover
          card; the card itself keeps it open via the same grace-period
          handlers so Settings is reachable. */}
      <div
        className="group relative flex h-10 w-10 items-center justify-center rounded-lg border-[0.5px] border-border/60 bg-card shadow-sm transition-[box-shadow,transform] duration-300 hover:-translate-y-0.5 hover:shadow-lg"
        onMouseEnter={openHover}
        onMouseLeave={scheduleCloseHover}
      >
        {/* Webhooks/crons/chats are owned by their agent and created through
            forms — you can't draw one, so their ports stay decorative. */}
        <ConnectPorts connectable={data.kind === 'account' || data.kind === 'mcp'} />
        <ResourceIcon data={data} />
        <span className={cn('absolute right-0.5 top-0.5 h-[5px] w-[5px] rounded-full', toneDot[data.tone])} />
      </div>
      {/* Details float ABOVE the chip, absolutely positioned so they never
          occupy layout (edge anchors and collision footprints stay put).
          Hover = quiet frosted fade; pinning (selection / details toggle)
          POPS: the inner card scales up from the chip with a slight
          overshoot, staggered per resource so details-mode ripples across
          the canvas. Outer shell owns positioning + the zoom counter-scale
          (inline transform), inner owns the visual card + the pop — the two
          transforms can't share one element. mb-3 clears the top port dot. */}
      <div
        className={cn(
          'absolute bottom-full left-1/2 mb-3 w-48 transition-opacity duration-200',
          shown ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
        )}
        style={{ transform: `translateX(-50%) scale(${1 / zoom})`, transformOrigin: 'bottom center' }}
        onMouseEnter={openHover}
        onMouseLeave={scheduleCloseHover}
      >
      <div
        className={cn(
          'flex w-full flex-col rounded-lg border px-3 py-2 transition-[transform,background-color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]',
          pinned
            ? 'translate-y-0 scale-100 border-border/60 bg-card shadow-md'
            : 'translate-y-1 scale-90 border-transparent bg-card/40 backdrop-blur-sm',
        )}
        style={{
          transformOrigin: 'bottom center',
          // Deterministic per-resource stagger (0–140ms) on the way IN only.
          transitionDelay: pinned
            ? `${([...data.resourceId].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 997, 0) % 5) * 35}ms`
            : '0ms',
        }}
      >
        <span className="block w-full truncate text-[9px] uppercase tracking-wider text-muted-foreground">
          {KIND_LABEL[data.kind]}
        </span>
        <span className="block w-full truncate text-xs font-medium">{data.label}</span>
        {data.sublabel && (
          <span className="mt-0.5 block w-full truncate text-xs text-muted-foreground">{data.sublabel}</span>
        )}
        {data.kind === 'cron' && (
          <div className="mt-1.5">
            {activityStats?.cronByTaskId[data.resourceId] !== undefined ? (
              <CronSparkChart label={`${data.label} schedule`} data={activityStats.cronByTaskId[data.resourceId]} />
            ) : activityPending ? (
              <ActivitySparkChartSkeleton />
            ) : null}
          </div>
        )}
        {data.kind === 'webhook' && (
          <div className="mt-1.5">
            {activityStats?.webhookByTriggerId[data.resourceId] !== undefined ? (
              <ActivitySparkChart
                label={`${data.label} activity`}
                data={activityStats.webhookByTriggerId[data.resourceId]}
              />
            ) : activityPending ? (
              <ActivitySparkChartSkeleton />
            ) : null}
          </div>
        )}
        {/* Footer: status badge left, settings link right (counts live on
            the connector chips now) */}
        <div className="mt-1.5 flex w-full items-center justify-between gap-2">
          <span
            className={cn(
              'inline-flex min-w-0 items-center gap-1 rounded-full px-1.5 py-0 text-2xs',
              toneBadge[data.tone],
            )}
          >
            <span className={cn('h-1 w-1 shrink-0 rounded-full', toneDot[data.tone])} />
            <span className="truncate">{data.status}</span>
          </span>
          {shown && (
            <button
              type="button"
              className="-mr-1 flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation()
                openGraphNode(navigate, data)
              }}
              data-testid="graph-node-open"
            >
              Settings
              <ArrowUpRight className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      </div>
      <CenterHandles />
    </div>
  )
}
