/**
 * Home connections graph — React Flow canvas over useGraphData().
 *
 * Positions: user-dragged coordinates persist to user settings
 * (`graphNodePositions`, debounced PUT, same pattern as `agentOrder`);
 * anything without a saved position gets the deterministic auto-layout.
 * Dragged connector geometry (elbow offsets, pinned ports) persists the
 * same way (`graphEdgeGeometry`).
 * Data refreshes (SSE-invalidated queries) rebuild node payloads while
 * preserving whatever positions are currently on screen.
 */

import '@xyflow/react/dist/style.css'
import './agent-graph.css'

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  Panel,
  ReactFlow,
  useNodesState,
  useStore,
  type EdgeMouseHandler,
  type IsValidConnection,
  type Node,
  type OnConnect,
  type OnConnectStart,
  type OnEdgesChange,
  type NodeMouseHandler,
  type ReactFlowInstance,
} from '@xyflow/react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useNavTransient } from '@renderer/context/nav-transient-context'
import { Loader2, RotateCcw } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { useUpdateUserSettings, useUserSettings } from '@renderer/hooks/use-user-settings'
import { AgentGraphNode, ResourceGraphNode, openGraphNode } from './graph-nodes'
import { ElbowEdge, type EdgeGeometryOverride, type GraphEdge } from './graph-edges'
import { computeLayout, type XY } from './layout'
import { useGraphData, type GraphEdgeSpec, type GraphNodeData } from './use-graph-data'

type RfNode = Node<GraphNodeData>

const nodeTypes = { agent: AgentGraphNode, resource: ResourceGraphNode }
const edgeTypes = { elbow: ElbowEdge }

// Two-state line language: solid gray = connected (regardless of traffic
// volume — counts live on the node pill), red dashes = broken endpoint.
const EDGE_DASH = '6 4'

// Count-chip unit (singular) by the edge's target kind. Resource edges are
// always built agent → resource; agent targets mean invocation edges.
const EDGE_UNIT: Record<string, string> = {
  account: 'call',
  mcp: 'tool call',
  chat: 'session',
  webhook: 'fire',
  cron: 'run',
  agent: 'invocation',
}

function edgeStyle(e: GraphEdgeSpec): CSSProperties {
  // Broken endpoint (expired auth, errored server, disconnected chat).
  if (e.broken) {
    return { stroke: 'rgb(239 68 68 / 0.7)', strokeWidth: 1.25, strokeDasharray: EDGE_DASH } // red-500, matching the error status dot
  }
  return { stroke: 'hsl(var(--muted-foreground) / 0.45)', strokeWidth: 1.25 }
}

const PERSIST_DEBOUNCE_MS = 600

/** Debug readout of the current viewport zoom. */
function ZoomReadout() {
  const zoom = useStore((s) => s.transform[2])
  return (
    <Panel position="bottom-center">
      <div className="rounded border bg-card/80 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
        zoom {zoom.toFixed(2)}
      </div>
    </Panel>
  )
}

/**
 * Dot grid that survives zooming out: dots scale with the canvas, but each
 * time zoom halves, the grid spacing doubles (staying anchored to flow
 * coordinates) and the dot radius counter-scales — so the rendered pattern
 * always sits between 10–20px spacing with ~1.5px dots. Must render as a
 * ReactFlow child (useStore needs its context).
 */
function AdaptiveDotsBackground() {
  const zoom = useStore((s) => s.transform[2])
  const doublings = Math.max(0, Math.ceil(Math.log2(1 / zoom)))
  return (
    <Background
      variant={BackgroundVariant.Dots}
      gap={10 * 2 ** doublings}
      size={1.5 / zoom}
      color="hsl(var(--muted-foreground) / 0.3)"
    />
  )
}

// ── Drawing new connections ──────────────────────────────────────────────
// A drawn edge must create the real relationship behind it: an invoke
// permission for agent→agent, an account/MCP link for agent↔resource.
// Webhooks, crons and chat integrations can't be drawn — they're created
// through their own forms (their ports aren't connectable either).

function nodeKind(nodeId: string): string {
  return nodeId.slice(0, nodeId.indexOf(':'))
}

function nodeRef(nodeId: string): string {
  return nodeId.slice(nodeId.indexOf(':') + 1)
}

function drawnConnectionKind(source: string, target: string): 'invoke' | 'account' | 'mcp' | null {
  const kinds = [nodeKind(source), nodeKind(target)].sort()
  if (kinds[0] === 'agent' && kinds[1] === 'agent') return source !== target ? 'invoke' : null
  if (kinds[0] === 'account' && kinds[1] === 'agent') return 'account'
  if (kinds[0] === 'agent' && kinds[1] === 'mcp') return 'mcp'
  return null
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

/**
 * Remove the relationship behind an edge; true = something changed.
 * Resource edges unlink the account/MCP; agent↔agent edges revoke invoke
 * permissions in both directions (invocation history is untouched).
 */
async function deleteGraphConnection(edge: GraphEdgeSpec): Promise<boolean> {
  try {
    if (edge.variant === 'resource') {
      // Resource edges are always built agent → resource.
      const slug = nodeRef(edge.source)
      const resourceKind = nodeKind(edge.target)
      const resourceId = nodeRef(edge.target)
      const res = await apiFetch(
        resourceKind === 'account'
          ? `/api/agents/${slug}/connected-accounts/${resourceId}`
          : `/api/agents/${slug}/remote-mcps/${resourceId}`,
        { method: 'DELETE' },
      )
      if (!res.ok) throw new Error(`Failed to unlink (${res.status})`)
      toast.success(resourceKind === 'account' ? 'Account unlinked' : 'MCP server unlinked')
      return true
    }
    const a = nodeRef(edge.source)
    const b = nodeRef(edge.target)
    let changed = false
    for (const [caller, target] of [
      [a, b],
      [b, a],
    ] as const) {
      const res = await apiFetch(`/api/agents/${caller}/x-agent-policies`)
      if (!res.ok) throw new Error(`Failed to load policies (${res.status})`)
      const { policies } = (await res.json()) as {
        policies: { operation: string; targetAgentSlug: string | null; decision: string }[]
      }
      const kept = policies.filter((p) => !(p.operation === 'invoke' && p.targetAgentSlug === target))
      if (kept.length === policies.length) continue
      const put = await apiFetch(`/api/agents/${caller}/x-agent-policies`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          policies: kept.map((p) => ({ operation: p.operation, targetSlug: p.targetAgentSlug, decision: p.decision })),
        }),
      })
      if (!put.ok) throw new Error(`Failed to save policies (${put.status})`)
      changed = true
    }
    if (changed) toast.success('Invoke permission revoked')
    return changed
  } catch (error) {
    console.error('Failed to delete connection:', error)
    toast.error("Couldn't remove the connection")
    return false
  }
}

/** Create the relationship behind a drawn edge; true = something changed. */
async function createDrawnConnection(source: string, target: string): Promise<boolean> {
  const kind = drawnConnectionKind(source, target)
  if (!kind) return false
  try {
    if (kind === 'invoke') {
      // Drag direction = permission direction: source may invoke target.
      const caller = nodeRef(source)
      const targetSlug = nodeRef(target)
      const res = await apiFetch(`/api/agents/${caller}/x-agent-policies`)
      if (!res.ok) throw new Error(`Failed to load policies (${res.status})`)
      const { policies } = (await res.json()) as {
        policies: { operation: string; targetAgentSlug: string | null; decision: string }[]
      }
      if (policies.some((p) => p.operation === 'invoke' && p.targetAgentSlug === targetSlug)) {
        toast.info('These agents are already connected')
        return false
      }
      // The PUT replaces the whole policy list — carry existing rows along.
      const put = await apiFetch(`/api/agents/${caller}/x-agent-policies`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          policies: [
            ...policies.map((p) => ({ operation: p.operation, targetSlug: p.targetAgentSlug, decision: p.decision })),
            { operation: 'invoke', targetSlug, decision: 'allow' },
          ],
        }),
      })
      if (!put.ok) throw new Error(`Failed to save policy (${put.status})`)
      toast.success('Invoke permission added')
      return true
    }
    const agentNodeId = nodeKind(source) === 'agent' ? source : target
    const resourceNodeId = agentNodeId === source ? target : source
    const slug = nodeRef(agentNodeId)
    const resourceId = nodeRef(resourceNodeId)
    const res =
      kind === 'account'
        ? await apiFetch(`/api/agents/${slug}/connected-accounts`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ accountIds: [resourceId] }),
          })
        : await apiFetch(`/api/agents/${slug}/remote-mcps`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ mcpIds: [resourceId] }),
          })
    if (!res.ok) throw new Error(`Failed to link (${res.status})`)
    toast.success(kind === 'account' ? 'Account linked to agent' : 'MCP server linked to agent')
    return true
  } catch (error) {
    console.error('Failed to create connection:', error)
    toast.error("Couldn't create the connection")
    return false
  }
}

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

  // Source node of an in-progress connection drag; nodes that can't legally
  // receive the connection fade while it's set (applied in the node sync).
  const [connectingFromId, setConnectingFromId] = useState<string | null>(null)

  // Details view: pin every resource's detail card open (vs. the simple
  // view's hover/select reveal).
  const [showDetails, setShowDetails] = useState(false)

  // Render once data is settled (success OR error) — a failed settings fetch
  // degrades to a non-persisting canvas instead of an eternal spinner.
  const ready = !graph.isLoading && !settingsQuery.isLoading

  // Sync domain nodes into React Flow state: fresh data payloads each time;
  // dragged/saved positions pin a node, the rest track the latest layout.
  useEffect(() => {
    if (!ready) return
    setNodes((prev) => {
      // Rebuilds must not wipe click-selection (ports + Open toolbar ride it).
      const selectedIds = new Set(prev.filter((n) => n.selected).map((n) => n.id))
      return graph.nodes.map((spec) => ({
        id: spec.id,
        type: spec.data.kind === 'agent' ? ('agent' as const) : ('resource' as const),
        position:
          draggedPositionsRef.current[spec.id] ??
          savedPositionsRef.current?.[spec.id] ??
          layoutPositions[spec.id] ?? { x: 0, y: 0 },
        data: spec.data.kind === 'agent' ? spec.data : { ...spec.data, showDetails },
        // Click selects (shows ports + the Open toolbar); navigation moved
        // to the toolbar and double-click. Delete key must not touch nodes.
        selectable: true,
        deletable: false,
        selected: selectedIds.has(spec.id),
        // Mid connection-drag, fade anything the drag can't legally land on.
        className:
          connectingFromId && spec.id !== connectingFromId && !drawnConnectionKind(connectingFromId, spec.id)
            ? 'opacity-25 transition-opacity duration-200'
            : 'transition-opacity duration-200',
      }))
    })
  }, [ready, graph.nodes, layoutPositions, setNodes, connectingFromId, showDetails])

  // Hovering an edge surfaces the real numbers (label at the midpoint) and
  // thickens the stroke so it's clear which line is being read.
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)
  const onEdgeMouseEnter: EdgeMouseHandler<GraphEdge> = useCallback((_event, edge) => setHoveredEdgeId(edge.id), [])
  const onEdgeMouseLeave: EdgeMouseHandler<GraphEdge> = useCallback(() => setHoveredEdgeId(null), [])

  // Connector geometry (elbow offsets, pinned ports) dragged this mount,
  // merged over saved values for rendering and persisted alongside node
  // positions.
  const [draggedEdgeGeometry, setDraggedEdgeGeometry] = useState<Record<string, EdgeGeometryOverride>>({})
  const draggedEdgeGeometryRef = useRef<Record<string, EdgeGeometryOverride>>({})
  const savedEdgeGeometryRef = useRef<Record<string, EdgeGeometryOverride> | undefined>(undefined)
  useEffect(() => {
    savedEdgeGeometryRef.current = userSettings?.graphEdgeGeometry
  }, [userSettings?.graphEdgeGeometry])

  // Persist only user-dragged geometry (node positions, elbow offsets),
  // merged over previously saved values — auto-laid-out elements stay fluid
  // instead of getting pinned at whatever the layout said the moment
  // someone dragged something else.
  const persistNow = useCallback(() => {
    if (!canPersist) return
    const update: {
      graphNodePositions?: Record<string, XY>
      graphEdgeGeometry?: Record<string, EdgeGeometryOverride>
    } = {}
    if (Object.keys(draggedPositionsRef.current).length > 0) {
      const positions: Record<string, XY> = { ...(savedPositionsRef.current ?? {}) }
      for (const [id, position] of Object.entries(draggedPositionsRef.current)) {
        positions[id] = { x: Math.round(position.x), y: Math.round(position.y) }
      }
      update.graphNodePositions = positions
    }
    if (Object.keys(draggedEdgeGeometryRef.current).length > 0) {
      const geometry = { ...(savedEdgeGeometryRef.current ?? {}) }
      for (const [id, patch] of Object.entries(draggedEdgeGeometryRef.current)) {
        geometry[id] = { ...geometry[id], ...patch }
      }
      update.graphEdgeGeometry = geometry
    }
    if (Object.keys(update).length === 0) return
    mutateSettings(update)
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

  // Connector drags commit once, on release (live movement renders inside
  // the edge component), then ride the same debounced persist as node drags.
  const commitEdgeGeometry = useCallback(
    (edgeId: string, patch: EdgeGeometryOverride) => {
      const next = { ...draggedEdgeGeometryRef.current[edgeId], ...patch }
      draggedEdgeGeometryRef.current[edgeId] = next
      setDraggedEdgeGeometry((prev) => ({ ...prev, [edgeId]: next }))
      schedulePersist()
    },
    [schedulePersist],
  )

  // Edges are a controlled prop (derived from graph data), so React Flow's
  // click-to-select only sticks if we catch the 'select' changes it emits
  // and fold them back into the derived array.
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set())
  const onEdgesChange: OnEdgesChange<GraphEdge> = useCallback((changes) => {
    setSelectedEdgeIds((prev) => {
      let next: Set<string> | null = null
      for (const change of changes) {
        if (change.type !== 'select') continue
        next = next ?? new Set(prev)
        if (change.selected) next.add(change.id)
        else next.delete(change.id)
      }
      return next ?? prev
    })
  }, [])

  // Dragging out of a node port draws a new connection; dropping it creates
  // the real relationship, then the topology refetch draws the edge.
  const onConnectStart: OnConnectStart = useCallback((_event, params) => setConnectingFromId(params.nodeId), [])
  const onConnectEnd = useCallback(() => setConnectingFromId(null), [])
  const queryClient = useQueryClient()
  const isValidConnection: IsValidConnection<GraphEdge> = useCallback(
    (connection) => drawnConnectionKind(connection.source, connection.target) !== null,
    [],
  )
  const onConnect: OnConnect = useCallback(
    (connection) => {
      void createDrawnConnection(connection.source, connection.target).then((created) => {
        if (created) void queryClient.invalidateQueries({ queryKey: ['home-graph'] })
      })
    },
    [queryClient],
  )

  // Deleting a selected connector (toolbar trash or Delete/Backspace)
  // removes the underlying relationship; the topology refetch redraws.
  const deleteEdge = useCallback(
    (edgeId: string) => {
      const spec = graph.edges.find((e) => e.id === edgeId)
      if (!spec?.deletable) return
      void deleteGraphConnection(spec).then((changed) => {
        if (changed) void queryClient.invalidateQueries({ queryKey: ['home-graph'] })
      })
    },
    [graph.edges, queryClient],
  )
  const onEdgesDelete = useCallback(
    (deleted: GraphEdge[]) => {
      for (const edge of deleted) deleteEdge(edge.id)
    },
    [deleteEdge],
  )
  // "Edit permissions" on an agent↔agent connector: go to the caller agent's
  // page with a one-shot asking it to open the policies tab.
  const { setOpenAgentSettings } = useNavTransient()
  const editEdgePermissions = useCallback(
    (edgeId: string) => {
      const spec = graph.edges.find((e) => e.id === edgeId)
      if (!spec?.policyAgentSlug) return
      setOpenAgentSettings({ slug: spec.policyAgentSlug, tab: 'x-agent-policies' })
      void navigate({ to: '/agents/$slug', params: { slug: spec.policyAgentSlug } })
    },
    [graph.edges, setOpenAgentSettings, navigate],
  )

  const savedEdgeGeometry = userSettings?.graphEdgeGeometry
  const edges: GraphEdge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        const hovered = e.id === hoveredEdgeId
        let style = edgeStyle(e)
        if (hovered) style = { ...style, strokeWidth: 2.5 }
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'elbow',
          style,
          focusable: false,
          // Clicking a connector reveals its grab handles and endpoint dots;
          // clicking the canvas deselects (nodes opt out of selection instead
          // of the canvas, since pane-click deselect is gated on
          // elementsSelectable).
          selectable: true,
          selected: selectedEdgeIds.has(e.id),
          // Gates the Delete/Backspace path (React Flow skips non-deletables).
          deletable: !!e.deletable,
          data: {
            geometry: { ...savedEdgeGeometry?.[e.id], ...draggedEdgeGeometry[e.id] },
            count: e.weight ?? 0,
            unit: EDGE_UNIT[nodeKind(e.target)] ?? 'run',
            hovered,
            showDetails,
            onGeometryCommit: commitEdgeGeometry,
            onDelete: e.deletable ? deleteEdge : undefined,
            onEditPermissions: e.policyAgentSlug ? editEdgePermissions : undefined,
          },
        }
      }),
    [
      graph.edges,
      hoveredEdgeId,
      draggedEdgeGeometry,
      savedEdgeGeometry,
      commitEdgeGeometry,
      selectedEdgeIds,
      deleteEdge,
      editEdgePermissions,
      showDetails,
    ],
  )

  // Keep fitting the viewport as the per-agent fan-out queries stream nodes
  // in — but stop the moment the user pans/zooms/drags, so we never yank a
  // viewport they've taken control of.
  const rfInstance = useRef<ReactFlowInstance<RfNode, GraphEdge> | null>(null)
  const userInteracted = useRef(false)
  useEffect(() => {
    if (userInteracted.current || nodes.length === 0) return
    const raf = requestAnimationFrame(() => {
      if (!userInteracted.current) void rfInstance.current?.fitView({ padding: 0.15, maxZoom: 1 })
    })
    return () => cancelAnimationFrame(raf)
  }, [nodes.length])

  // Reset: forget saved + dragged geometry everywhere and re-solve the
  // auto-layout, then refit the viewport around it.
  const resetLayout = useCallback(() => {
    draggedPositionsRef.current = {}
    savedPositionsRef.current = {}
    draggedEdgeGeometryRef.current = {}
    savedEdgeGeometryRef.current = {}
    setDraggedEdgeGeometry({})
    if (persistTimer.current) {
      clearTimeout(persistTimer.current)
      persistTimer.current = null
    }
    mutateSettings({ graphNodePositions: {}, graphEdgeGeometry: {} })
    setNodes((prev) => prev.map((n) => ({ ...n, position: layoutPositions[n.id] ?? { x: 0, y: 0 } })))
    requestAnimationFrame(() => {
      void rfInstance.current?.fitView({ padding: 0.15, maxZoom: 1 })
    })
  }, [layoutPositions, setNodes, mutateSettings])

  // Click = select; the page behind a node opens via its toolbar or double-click.
  const onNodeDoubleClick: NodeMouseHandler<RfNode> = useCallback(
    (_event, node) => openGraphNode(navigate, node.data),
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
      <ReactFlow<RfNode, GraphEdge>
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeDragStop={schedulePersist}
        onEdgeMouseEnter={onEdgeMouseEnter}
        onEdgeMouseLeave={onEdgeMouseLeave}
        onInit={(instance) => {
          rfInstance.current = instance
        }}
        // Loose mode: our ports are all type="source", and a connection may
        // end on any of them. The generous radius means drops snap to the
        // nearest port without pixel-hunting.
        connectionMode={ConnectionMode.Loose}
        connectionRadius={30}
        connectionLineStyle={{ stroke: 'rgb(59 130 246 / 0.6)', strokeWidth: 1.5, strokeDasharray: '6 4' }}
        isValidConnection={isValidConnection}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        deleteKeyCode={['Backspace', 'Delete']}
        onEdgesDelete={onEdgesDelete}
        // Selected connectors (and their endpoint dots) render above nodes,
        // so the dots stay visible and grabbable where they dock.
        elevateEdgesOnSelect
        proOptions={{ hideAttribution: true }}
        nodeDragThreshold={4}
        minZoom={0.15}
        maxZoom={1.35}
        // Inline style, not a bg-* class: xyflow's style.css sets its own
        // background-color on .react-flow (loaded after Tailwind, same
        // specificity), silently overriding any utility class. 5%
        // muted-foreground over the app background ≈ a 97%-lightness wash in
        // light mode — a faint gray so the white nodes pop.
        style={{ backgroundColor: 'hsl(var(--muted-foreground) / 0.05)' }}
      >
        <AdaptiveDotsBackground />
        <ZoomReadout />
        <Controls showInteractive={false} />
        <Panel position="top-right" className="flex items-center gap-2">
          <label
            htmlFor="graph-details-switch"
            className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs shadow-sm"
          >
            Details
            <Switch
              id="graph-details-switch"
              checked={showDetails}
              onCheckedChange={setShowDetails}
              className="scale-75"
              data-testid="graph-toggle-details"
            />
          </label>
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
