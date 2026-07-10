/**
 * Home connections graph — React Flow canvas over useGraphData().
 *
 * Positions: user-dragged coordinates persist to user settings
 * (`graphNodePositions`, debounced PUT, same pattern as `agentOrder`);
 * anything without a saved position gets the deterministic auto-layout.
 * Data refreshes (SSE-invalidated queries) rebuild node payloads while
 * preserving whatever positions are currently on screen.
 */

import '@xyflow/react/dist/style.css'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Panel,
  ReactFlow,
  useNodesState,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type ReactFlowInstance,
} from '@xyflow/react'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useUpdateUserSettings, useUserSettings } from '@renderer/hooks/use-user-settings'
import { AgentGraphNode, ResourceGraphNode } from './graph-nodes'
import { computeLayout, type XY } from './layout'
import { useGraphData, type GraphEdgeVariant, type GraphNodeData } from './use-graph-data'

type RfNode = Node<GraphNodeData>

const nodeTypes = { agent: AgentGraphNode, resource: ResourceGraphNode }

type CSSStyle = { stroke: string; strokeWidth: number; strokeDasharray?: string }

// Interaction counts → stroke width, log-scaled so a 100-fire webhook doesn't
// render as a bar. Base width per variant, +0..3px with volume.
function weightedWidth(base: number, weight?: number): number {
  return base + Math.min(3, Math.log2(1 + (weight ?? 0)))
}

// Connected-but-never-exercised paths render dashed; recorded activity
// (audit-log calls, trigger fires, chat sessions) makes them solid and
// scales their width.
function edgeStyle(variant: GraphEdgeVariant, weight?: number): CSSStyle {
  switch (variant) {
    case 'resource':
      return weight
        ? { stroke: 'hsl(var(--muted-foreground) / 0.5)', strokeWidth: weightedWidth(1.5, weight) }
        : { stroke: 'hsl(var(--muted-foreground) / 0.35)', strokeWidth: 1.25, strokeDasharray: '4 4' }
    case 'trigger':
      return weight
        ? { stroke: 'hsl(var(--muted-foreground) / 0.45)', strokeWidth: weightedWidth(1, weight) }
        : { stroke: 'hsl(var(--muted-foreground) / 0.3)', strokeWidth: 1, strokeDasharray: '4 4' }
    case 'permission':
      return { stroke: 'hsl(var(--muted-foreground) / 0.55)', strokeWidth: 1.5, strokeDasharray: '6 4' }
    case 'activity':
      return { stroke: 'hsl(var(--muted-foreground) / 0.7)', strokeWidth: weightedWidth(1.5, weight) }
  }
}

const PERSIST_DEBOUNCE_MS = 600

export function AgentGraph() {
  const navigate = useNavigate()
  const graph = useGraphData()
  // Saved positions must be loaded before nodes are seeded, or the first drag
  // would persist auto-layout coordinates over the user's arrangement.
  const settingsQuery = useUserSettings()
  const { data: userSettings } = settingsQuery
  const { mutate: mutateSettings } = useUpdateUserSettings()
  // Persisting is only safe once the saved positions have actually arrived:
  // the settings PUT replaces the whole graphNodePositions map, so writing
  // while the fetch is missing/errored would wipe every saved position.
  const canPersist = settingsQuery.isSuccess

  const [nodes, setNodes, onNodesChange] = useNodesState<RfNode>([])

  const savedPositionsRef = useRef<Record<string, XY> | undefined>(undefined)
  useEffect(() => {
    savedPositionsRef.current = userSettings?.graphNodePositions
  }, [userSettings?.graphNodePositions])

  // Positions the user has dragged this mount. Only these (and saved ones)
  // pin a node; everything else follows the auto-layout, which keeps
  // re-solving as the per-agent fan-out queries stream edges in. Freezing a
  // node at its first-seen layout position would strand it wherever the
  // then-partial edge data happened to put it (e.g. two "solo" satellites
  // of the same agent stacked on one spot).
  const draggedPositionsRef = useRef<Record<string, XY>>({})
  const handleNodesChange: typeof onNodesChange = useCallback(
    (changes) => {
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          draggedPositionsRef.current[change.id] = change.position
        }
      }
      onNodesChange(changes)
    },
    [onNodesChange],
  )

  const layoutPositions = useMemo(() => computeLayout(graph.nodes, graph.edges), [graph.nodes, graph.edges])

  // Render once data is settled (success OR error) — a failed settings fetch
  // degrades to a non-persisting canvas instead of an eternal spinner.
  const ready = !graph.isLoading && !settingsQuery.isLoading

  // Sync domain nodes into React Flow state: fresh data payloads each time;
  // dragged/saved positions pin a node, the rest track the latest layout.
  useEffect(() => {
    if (!ready) return
    setNodes(() =>
      graph.nodes.map((spec) => ({
        id: spec.id,
        type: spec.data.kind === 'agent' ? ('agent' as const) : ('resource' as const),
        position:
          draggedPositionsRef.current[spec.id] ??
          savedPositionsRef.current?.[spec.id] ??
          layoutPositions[spec.id] ?? { x: 0, y: 0 },
        data: spec.data,
      })),
    )
  }, [ready, graph.nodes, layoutPositions, setNodes])

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'straight',
        style: edgeStyle(e.variant, e.weight),
        focusable: false,
        selectable: false,
      })),
    [graph.edges],
  )

  // Keep fitting the viewport as the per-agent fan-out queries stream nodes
  // in — but stop the moment the user pans/zooms/drags, so we never yank a
  // viewport they've taken control of.
  const rfInstance = useRef<ReactFlowInstance<RfNode, Edge> | null>(null)
  const userInteracted = useRef(false)
  useEffect(() => {
    if (userInteracted.current || nodes.length === 0) return
    const raf = requestAnimationFrame(() => {
      if (!userInteracted.current) void rfInstance.current?.fitView({ padding: 0.15, maxZoom: 1 })
    })
    return () => cancelAnimationFrame(raf)
  }, [nodes.length])

  // Persist only user-dragged positions, merged over previously saved ones —
  // auto-laid-out nodes stay fluid instead of getting pinned at whatever the
  // layout said the moment someone dragged something else.
  const persistNow = useCallback(() => {
    if (!canPersist || Object.keys(draggedPositionsRef.current).length === 0) return
    const positions: Record<string, XY> = { ...(savedPositionsRef.current ?? {}) }
    for (const [id, position] of Object.entries(draggedPositionsRef.current)) {
      positions[id] = { x: Math.round(position.x), y: Math.round(position.y) }
    }
    mutateSettings({ graphNodePositions: positions })
  }, [canPersist, mutateSettings])

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const schedulePersist = useCallback(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null
      persistNow()
    }, PERSIST_DEBOUNCE_MS)
  }, [persistNow])
  // Unmount mid-debounce must FLUSH, not cancel: dragging a node and then
  // clicking through to an agent (which unmounts the graph) is the most
  // natural gesture here, and cancelling would silently drop the arrangement.
  const persistNowRef = useRef(persistNow)
  useEffect(() => {
    persistNowRef.current = persistNow
  }, [persistNow])
  useEffect(
    () => () => {
      if (persistTimer.current) {
        clearTimeout(persistTimer.current)
        persistTimer.current = null
        persistNowRef.current()
      }
    },
    [],
  )

  // Reset: forget saved + dragged positions everywhere and re-solve the
  // auto-layout, then refit the viewport around it.
  const resetLayout = useCallback(() => {
    draggedPositionsRef.current = {}
    savedPositionsRef.current = {}
    if (persistTimer.current) {
      clearTimeout(persistTimer.current)
      persistTimer.current = null
    }
    mutateSettings({ graphNodePositions: {} })
    setNodes((prev) => prev.map((n) => ({ ...n, position: layoutPositions[n.id] ?? { x: 0, y: 0 } })))
    requestAnimationFrame(() => {
      void rfInstance.current?.fitView({ padding: 0.15, maxZoom: 1 })
    })
  }, [layoutPositions, setNodes, mutateSettings])

  const onNodeClick: NodeMouseHandler<RfNode> = useCallback(
    (_event, node) => {
      const data = node.data
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
    },
    [navigate],
  )

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  return (
    <div
      className="h-full w-full"
      data-testid="agent-graph"
      onPointerDownCapture={() => {
        userInteracted.current = true
      }}
      onWheelCapture={() => {
        userInteracted.current = true
      }}
    >
      <ReactFlow<RfNode, Edge>
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onNodeDragStop={schedulePersist}
        onInit={(instance) => {
          rfInstance.current = instance
        }}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        nodeDragThreshold={4}
        minZoom={0.15}
        maxZoom={1.75}
        className="bg-background"
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="hsl(var(--muted-foreground) / 0.3)" />
        <Controls showInteractive={false} />
        <Panel position="top-right">
          <Button variant="outline" size="sm" onClick={resetLayout} data-testid="graph-reset-layout">
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
            Reset layout
          </Button>
        </Panel>
        {graph.topologyFailed && (
          <Panel position="top-left">
            <div className="rounded-md border bg-card px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm">
              Couldn&apos;t load connections — showing agents only
            </div>
          </Panel>
        )}
      </ReactFlow>
    </div>
  )
}
