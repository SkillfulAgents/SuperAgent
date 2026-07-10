/**
 * Custom React Flow nodes for the home connections graph.
 *
 * Agent nodes are circular status badges; resource nodes (accounts, MCPs,
 * triggers, chat integrations) are bare icon chips — their health shows
 * through the edge styling (red dashes) and the hover label, not on the
 * node itself. Handles are invisible and centered so straight edges radiate from
 * node centers, mind-map style.
 */

import type { CSSProperties, KeyboardEvent } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Plug, Webhook, CalendarClock } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { getAgentActivityStatus, type AgentActivityStatus } from '@shared/lib/types/agent-activity-status'
import { AgentStatus } from '@renderer/components/agents/agent-status'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import type { AgentNodeData, ResourceNodeData, ResourceTone } from './use-graph-data'

const centerHandleStyle: CSSProperties = {
  left: '50%',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  opacity: 0,
  pointerEvents: 'none',
}

// Nodes navigate on click (React Flow's onNodeClick); re-dispatching a click
// from Enter/Space gives keyboard users the same path without duplicating
// the routing logic here.
function activateOnKey(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  event.currentTarget.click()
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
 * while it's hovered. Real React Flow handles: when connectable, dragging
 * one out draws a new connection, FigJam-style (drop targets snap within
 * ReactFlow's connectionRadius). Visibility/pointer-events gating lives in
 * agent-graph.css (.graph-port) so hidden ports never block node drags.
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
        />
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
      aria-label={`Open agent ${agent.name}`}
      onKeyDown={activateOnKey}
      className={cn(
        'group relative flex h-28 w-28 cursor-pointer flex-col items-center justify-center rounded-full border-[0.5px] bg-card px-3 text-center shadow-sm transition-[box-shadow,transform] duration-300 hover:-translate-y-0.5 hover:shadow-lg',
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
      <ConnectPorts connectable />
      {/* Icon-only status (sidebar-style) floated at the circle's top,
          tucked just inside the edge */}
      <AgentStatus
        status={agent.status}
        hasActiveSessions={agent.hasActiveSessions ?? false}
        hasSessionsAwaitingInput={agent.hasSessionsAwaitingInput ?? false}
        iconOnly
        className="absolute left-1/2 top-3 -translate-x-1/2"
      />
      <span className="line-clamp-2 max-w-full break-words text-center text-xs">{agent.name}</span>
      <CenterHandles />
    </div>
  )
}

export const toneDot: Record<ResourceTone, string> = {
  ok: 'bg-green-500',
  muted: 'bg-muted-foreground/50',
  attention: 'bg-orange-500',
  error: 'bg-red-500',
}

// Usage badge in the hover pill: text matches the dot, chip bg is a faint
// wash of the same tone.
const toneBadge: Record<ResourceTone, string> = {
  ok: 'bg-green-500/10 text-green-500',
  muted: 'bg-muted-foreground/10 text-muted-foreground',
  attention: 'bg-orange-500/10 text-orange-500',
  error: 'bg-red-500/10 text-red-500',
}

export function ResourceIcon({ data }: { data: ResourceNodeData }) {
  const className = 'h-4 w-4 text-muted-foreground'
  switch (data.kind) {
    case 'account':
      return <ServiceIcon slug={data.iconSlug} fallback="oauth" className="h-5 w-5" />
    case 'chat':
      return <ServiceIcon slug={data.iconSlug} fallback="request" className="h-5 w-5" />
    case 'mcp':
      return <Plug className={className} />
    case 'webhook':
      return <Webhook className={className} />
    case 'cron':
      return <CalendarClock className={className} />
  }
}

export function ResourceGraphNode({ data }: NodeProps<Node<ResourceNodeData, 'resource'>>) {
  // No `title` attr: the OS tooltip would race the fade-in label with the
  // same text.
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${data.kind} ${data.label} — ${data.statusLabel}`}
      onKeyDown={activateOnKey}
      className="flex w-32 cursor-pointer flex-col items-center gap-1"
      data-testid={`graph-node-${data.kind}-${data.resourceId}`}
    >
      {/* Only the chip is the hover zone: it's its own `group` (port dots)
          and a `peer` for the sibling label — hovering the label's empty
          layout slot below must not light anything up. */}
      <div className="group peer relative flex h-10 w-10 items-center justify-center rounded-full border-[0.5px] border-border/60 bg-card shadow-sm transition-[box-shadow,transform] duration-300 hover:-translate-y-0.5 hover:shadow-lg">
        {/* Webhooks/crons/chats are owned by their agent and created through
            forms — you can't draw one, so their ports stay decorative. */}
        <ConnectPorts connectable={data.kind === 'account' || data.kind === 'mcp'} />
        <ResourceIcon data={data} />
      </div>
      {/* The label keeps its layout slot (opacity, not display) so edge
          anchors and collision footprints don't shift when it fades in. */}
      <div className="flex max-w-full flex-col items-start rounded-md bg-card/40 px-1.5 py-0.5 opacity-0 backdrop-blur-sm transition-opacity duration-200 peer-hover:opacity-100">
        <span className="block max-w-full truncate text-2xs text-foreground/80">{data.label}</span>
        {data.sublabel && (
          <span className="block max-w-full truncate text-2xs text-muted-foreground">{data.sublabel}</span>
        )}
        <span
          className={cn(
            'mt-0.5 inline-flex max-w-full items-center gap-1 rounded-full px-1.5 py-px text-[9px] leading-tight',
            toneBadge[data.tone],
          )}
        >
          <span className={cn('h-1 w-1 shrink-0 rounded-full', toneDot[data.tone])} />
          <span className="truncate">{data.status}</span>
        </span>
        {data.usage && (
          <span className="mt-0.5 block max-w-full truncate text-[9px] leading-tight text-muted-foreground">
            {data.usage}
          </span>
        )}
      </div>
      <CenterHandles />
    </div>
  )
}
