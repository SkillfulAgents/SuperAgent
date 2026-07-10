/**
 * Right-hand directory of connectable resources (accounts, MCP servers) for
 * the home connections graph. Rows mirror the canvas nodes: same icon and
 * status dot, plus how many agents use the resource. Hovering a row
 * spotlights that resource's edges on the canvas (AgentGraph fades the
 * rest); clicking navigates to connection settings, same as the node.
 */

import { cn } from '@shared/lib/utils/cn'
import { ResourceIcon, toneDot } from './graph-nodes'
import type { GraphNodeSpec, ResourceNodeData } from './use-graph-data'

export interface ResourcePanelItem {
  id: string
  data: ResourceNodeData
  agentCount: number
}

/** Accounts and MCP servers from the graph's node list, with linked-agent counts. */
export function resourcePanelItems(nodes: GraphNodeSpec[], edges: { target: string }[]): ResourcePanelItem[] {
  const agentCounts = new Map<string, number>()
  for (const edge of edges) {
    agentCounts.set(edge.target, (agentCounts.get(edge.target) ?? 0) + 1)
  }
  return nodes.flatMap((n) =>
    n.data.kind === 'account' || n.data.kind === 'mcp'
      ? [{ id: n.id, data: n.data, agentCount: agentCounts.get(n.id) ?? 0 }]
      : [],
  )
}

function ResourceGroup({
  title,
  items,
  onHover,
  onSelect,
}: {
  title: string
  items: ResourcePanelItem[]
  onHover: (nodeId: string | null) => void
  onSelect: () => void
}) {
  if (items.length === 0) return null
  return (
    <div>
      <div className="px-2 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-muted"
          onMouseEnter={() => onHover(item.id)}
          onMouseLeave={() => onHover(null)}
          onClick={onSelect}
          title={item.data.statusLabel}
          data-testid={`graph-panel-${item.data.kind}-${item.data.resourceId}`}
        >
          <span className="relative flex h-6 w-6 shrink-0 items-center justify-center">
            <ResourceIcon data={item.data} />
            <span
              className={cn(
                'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-card',
                toneDot[item.data.tone],
              )}
            />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs">{item.data.label}</span>
          <span className="shrink-0 text-2xs text-muted-foreground">
            {item.agentCount > 0 ? `${item.agentCount} agent${item.agentCount === 1 ? '' : 's'}` : 'unused'}
          </span>
        </button>
      ))}
    </div>
  )
}

export function ResourcePanel({
  items,
  onHover,
  onSelect,
}: {
  items: ResourcePanelItem[]
  onHover: (nodeId: string | null) => void
  onSelect: () => void
}) {
  if (items.length === 0) return null
  return (
    <div
      className="max-h-[55vh] w-56 overflow-y-auto rounded-md border bg-card pb-1 shadow-sm"
      data-testid="graph-resource-panel"
    >
      <ResourceGroup
        title="Accounts"
        items={items.filter((i) => i.data.kind === 'account')}
        onHover={onHover}
        onSelect={onSelect}
      />
      <ResourceGroup
        title="MCP servers"
        items={items.filter((i) => i.data.kind === 'mcp')}
        onHover={onHover}
        onSelect={onSelect}
      />
    </div>
  )
}
