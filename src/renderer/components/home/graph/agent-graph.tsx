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
import { useNavTransient } from '@renderer/context/nav-transient-context'
import { Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { useUpdateUserSettings, useUserSettings, type UserSettingsData } from '@renderer/hooks/use-user-settings'
import { useUser } from '@renderer/context/user-context'
import {
  createDrawnConnection,
  deleteGraphConnection,
  drawnConnectionKind,
  nodeKind,
  nodeRef,
} from './graph-connections'
import { AgentGraphNode, ResourceGraphNode, openGraphNode } from './graph-nodes'
import { ElbowEdge, type EdgeGeometryOverride, type GraphEdge } from './graph-edges'
import { computeLayout, type XY } from './layout'
import { useGraphData, type GraphEdgeSpec, type GraphNodeData } from './use-graph-data'

type RfNode = Node<GraphNodeData>

const nodeTypes = { agent: AgentGraphNode, resource: ResourceGraphNode }
const edgeTypes = { elbow: ElbowEdge }

// Line language, two independent axes: COLOR = health (red = broken
// endpoint, gray otherwise); DASH = exercise (solid = the path has recorded
// traffic, dashed = connected but never used). Exact counts live on the chip.
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
  const exercised = (e.weight ?? 0) > 0
  return {
    // Broken endpoint (expired auth, errored server, disconnected chat) —
    // red-500, matching the error status dot.
    stroke: e.broken ? 'rgb(239 68 68 / 0.7)' : 'hsl(var(--muted-foreground) / 0.45)',
    strokeWidth: 1.25,
    strokeDasharray: exercised ? undefined : EDGE_DASH,
  }
}

const PERSIST_DEBOUNCE_MS = 600

/**
 * Publishes the viewport zoom as `--graph-zoom` on the canvas container —
 * the ONE zoom subscription. Per-consumer useStore subscriptions (toolbars,
 * detail cards, count chips) would re-render O(nodes + edges) components on
 * every zoomed frame; instead they read the variable inside their CSS
 * transforms and the browser re-resolves it with zero React work.
 */
function ZoomVariable() {
  const zoom = useStore((s) => s.transform[2])
  const domNode = useStore((s) => s.domNode)
  useEffect(() => {
    domNode?.style.setProperty('--graph-zoom', String(zoom))
  }, [zoom, domNode])
  return null
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

export function AgentGraph() {
  const navigate = useNavigate()
  const graph = useGraphData()
  // Drawing is role-gated in auth mode to mirror what the server enforces:
  // an invoke policy is written on the DRAG-SOURCE agent (owner-only
  // endpoint); a resource link is written on the agent side (user role).
  const { canUseAgent, canAdminAgent } = useUser()
  const canDrawConnection = useCallback(
    (source: string, target: string) => {
      const kind = drawnConnectionKind(source, target)
      if (!kind) return false
      if (kind === 'invoke') return canAdminAgent(nodeRef(source))
      const agentNodeId = nodeKind(source) === 'agent' ? source : target
      return canUseAgent(nodeRef(agentNodeId))
    },
    [canAdminAgent, canUseAgent],
  )
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

  // Layout depends only on the graph's STRUCTURE — which nodes exist, their
  // kind, and how they're wired — never on payloads (status, counts). The
  // queries feeding buildGraph refresh constantly via SSE invalidations and
  // mint fresh array identities each time, so keying this memo on identity
  // would re-run the 300-tick force simulation (a synchronous main-thread
  // block that grows with graph size) on every agent status flip.
  const layoutSignature = useMemo(
    () =>
      graph.nodes.map((n) => `${n.id}:${n.data.kind}`).join(';') +
      '|' +
      graph.edges.map((e) => `${e.source}>${e.target}:${e.variant}`).join(';'),
    [graph.nodes, graph.edges],
  )
  const layoutPositions = useMemo(
    () => computeLayout(graph.nodes, graph.edges),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature covers everything computeLayout reads
    [layoutSignature],
  )

  // Source node of an in-progress connection drag; nodes that can't legally
  // receive the connection fade while it's set (applied in the node sync).
  const [connectingFromId, setConnectingFromId] = useState<string | null>(null)

  // Details view: pin every resource's detail card open (vs. the simple
  // view's hover/select reveal). Persisted as a user preference; the local
  // override answers immediately while the PUT round-trips (and before the
  // invalidated settings query refetches).
  const [detailsOverride, setDetailsOverride] = useState<boolean | null>(null)
  const showDetails = detailsOverride ?? userSettings?.graphShowDetails ?? false
  const setShowDetails = useCallback(
    (next: boolean) => {
      setDetailsOverride(next)
      mutateSettings({ graphShowDetails: next })
    },
    [mutateSettings],
  )

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
          connectingFromId && spec.id !== connectingFromId && !canDrawConnection(connectingFromId, spec.id)
            ? 'opacity-25 transition-opacity duration-200'
            : 'transition-opacity duration-200',
      }))
    })
  }, [ready, graph.nodes, layoutPositions, setNodes, connectingFromId, showDetails, canDrawConnection])

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

  // Prune targets: ids that still exist in the loaded graph. Deleted
  // agents, unlinked accounts and completed one-time crons would otherwise
  // accrete in the persisted maps forever (every persist rewrites
  // saved ∪ dragged, and the PUT replaces the whole map — the client is the
  // only place pruning can happen). Snapshotted only while the FULL graph,
  // topology included, is loaded: a mid-load or failed-topology persist
  // must not mistake "not loaded" for "deleted" and wipe real entries.
  const pruneIdsRef = useRef<{ nodes: Set<string>; edges: Set<string> } | null>(null)
  useEffect(() => {
    if (graph.isLoading || graph.topologyFailed) return
    pruneIdsRef.current = {
      nodes: new Set(graph.nodes.map((n) => n.id)),
      edges: new Set(graph.edges.map((e) => e.id)),
    }
  }, [graph.isLoading, graph.topologyFailed, graph.nodes, graph.edges])

  // Persist only user-dragged geometry (node positions, elbow offsets),
  // merged over previously saved values — auto-laid-out elements stay fluid
  // instead of getting pinned at whatever the layout said the moment
  // someone dragged something else.
  const persistNow = useCallback(() => {
    if (!canPersist) return
    const prune = pruneIdsRef.current
    const update: {
      graphNodePositions?: Record<string, XY>
      graphEdgeGeometry?: Record<string, EdgeGeometryOverride>
    } = {}
    if (Object.keys(draggedPositionsRef.current).length > 0) {
      const positions: Record<string, XY> = { ...(savedPositionsRef.current ?? {}) }
      for (const [id, position] of Object.entries(draggedPositionsRef.current)) {
        positions[id] = { x: Math.round(position.x), y: Math.round(position.y) }
      }
      if (prune) {
        for (const id of Object.keys(positions)) {
          if (!prune.nodes.has(id)) delete positions[id]
        }
      }
      update.graphNodePositions = positions
    }
    if (Object.keys(draggedEdgeGeometryRef.current).length > 0) {
      const geometry = { ...(savedEdgeGeometryRef.current ?? {}) }
      for (const [id, patch] of Object.entries(draggedEdgeGeometryRef.current)) {
        geometry[id] = { ...geometry[id], ...patch }
      }
      if (prune) {
        for (const id of Object.keys(geometry)) {
          if (!prune.edges.has(id)) delete geometry[id]
        }
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
    (connection) => canDrawConnection(connection.source, connection.target),
    [canDrawConnection],
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
  // Per-id cache so a hover/selection change rebuilds ONLY the affected
  // edges' objects. Fresh identities defeat React Flow's per-edge memo —
  // without this, one mouse pass over a line re-renders every ElbowEdge on
  // the canvas twice (enter + leave), each recomputing its full geometry.
  const edgeCacheRef = useRef(new Map<string, { deps: readonly unknown[]; edge: GraphEdge }>())
  const edges: GraphEdge[] = useMemo(() => {
    const cache = edgeCacheRef.current
    const seen = new Set<string>()
    const result = graph.edges.map((e) => {
      seen.add(e.id)
      const hovered = e.id === hoveredEdgeId
      const selected = selectedEdgeIds.has(e.id)
      // Everything this edge's output is derived from, compared by identity.
      const deps = [
        e,
        hovered,
        selected,
        savedEdgeGeometry?.[e.id],
        draggedEdgeGeometry[e.id],
        showDetails,
        commitEdgeGeometry,
        deleteEdge,
        editEdgePermissions,
      ] as const
      const cached = cache.get(e.id)
      if (cached && cached.deps.every((d, i) => d === deps[i])) return cached.edge
      let style = edgeStyle(e)
      if (hovered) style = { ...style, strokeWidth: 2.5 }
      const edge: GraphEdge = {
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
        selected,
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
      cache.set(e.id, { deps, edge })
      return edge
    })
    for (const id of cache.keys()) {
      if (!seen.has(id)) cache.delete(id)
    }
    return result
  }, [
    graph.edges,
    hoveredEdgeId,
    draggedEdgeGeometry,
    savedEdgeGeometry,
    commitEdgeGeometry,
    selectedEdgeIds,
    deleteEdge,
    editEdgePermissions,
    showDetails,
  ])

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
    // Reflect the wipe in the query cache immediately: edges render straight
    // from userSettings.graphEdgeGeometry, so without this the old elbows
    // linger until the PUT + invalidate round-trip lands — and if the PUT
    // failed, the next drag-persist (which writes saved ∪ dragged from the
    // now-empty refs) would wipe them server-side for real anyway.
    queryClient.setQueryData<UserSettingsData>(['user-settings'], (prev) =>
      prev ? { ...prev, graphNodePositions: {}, graphEdgeGeometry: {} } : prev,
    )
    mutateSettings({ graphNodePositions: {}, graphEdgeGeometry: {} })
    setNodes((prev) => prev.map((n) => ({ ...n, position: layoutPositions[n.id] ?? { x: 0, y: 0 } })))
    requestAnimationFrame(() => {
      void rfInstance.current?.fitView({ padding: 0.15, maxZoom: 1 })
    })
  }, [layoutPositions, setNodes, mutateSettings, queryClient])

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
        // Canvas background lives in agent-graph.css (.agent-graph-canvas),
        // not a bg-* utility: xyflow's style.css sets its own background-color
        // on .react-flow, and the theme needs a dark-mode override anyway.
        className="agent-graph-canvas"
      >
        <AdaptiveDotsBackground />
        <ZoomVariable />
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
