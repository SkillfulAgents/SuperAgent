/**
 * Custom React Flow nodes for the home connections graph.
 *
 * Agent nodes are small status cards; resource nodes (accounts, MCPs,
 * triggers, chat integrations) are icon chips with a status dot. Both reuse
 * the app's existing status indicators so colors/motion match the rest of
 * the UI. Handles are invisible and centered so straight edges radiate from
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

const agentBorder: Record<AgentActivityStatus, string> = {
  working: 'border-green-500/60',
  awaiting_input: 'border-orange-500/70',
  idle: 'border-border',
  sleeping: 'border-border opacity-70',
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
        'relative w-44 cursor-pointer rounded-lg border bg-card px-3 py-2.5 shadow-sm transition-colors hover:border-accent-foreground/40',
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
      {agent.hasUnreadNotifications && (
        <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-blue-500" title="New notifications" />
      )}
      <div className="truncate text-sm font-medium">{agent.name}</div>
      <AgentStatus
        status={agent.status}
        hasActiveSessions={agent.hasActiveSessions ?? false}
        hasSessionsAwaitingInput={agent.hasSessionsAwaitingInput ?? false}
        size="sm"
        className="mt-1"
      />
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

function ResourceIcon({ data }: { data: ResourceNodeData }) {
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
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${data.kind} ${data.label} — ${data.statusLabel}`}
      onKeyDown={activateOnKey}
      className="group flex w-32 cursor-pointer flex-col items-center gap-1"
      title={data.statusLabel}
      data-testid={`graph-node-${data.kind}-${data.resourceId}`}
    >
      <div className="relative flex h-10 w-10 items-center justify-center rounded-full border bg-card shadow-sm transition-colors group-hover:border-accent-foreground/40">
        <ResourceIcon data={data} />
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background',
            toneDot[data.tone],
          )}
        />
      </div>
      <span className="max-w-full truncate text-center text-2xs text-foreground/80">{data.label}</span>
      {data.sublabel && (
        <span className="-mt-1 max-w-full truncate text-center text-2xs text-muted-foreground">{data.sublabel}</span>
      )}
      <CenterHandles />
    </div>
  )
}
