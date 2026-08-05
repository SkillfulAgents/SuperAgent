/**
 * Custom React Flow edges for the home connections graph — FigJam-style
 * orthogonal connectors.
 *
 * Every node exposes four ports (the side midpoints of its VISIBLE shape:
 * the rounded card for agents, just the 40px icon chip for resource nodes —
 * anchoring the full bounding box would leave connectors stopping short of
 * the artwork).
 *
 * Routes are orthogonal polylines described by `coords`: one cross-axis
 * coordinate per interior segment. The first/last segments are anchored to
 * the ports, orientations alternate, and rounded corners are derived — so
 * the whole route is a handful of numbers, which is what persists. No
 * stored coords (or a parity mismatch after re-pinning a port) falls back
 * to the auto route (straight L, or midpoint S between facing sides).
 *
 * Manipulation, visible on selection: a pill handle on each segment drags
 * it perpendicular (dragging an END segment first spawns a short stub bend
 * at the port, exactly like FigJam); endpoint dots slide freely around the
 * node's perimeter, magnetizing to the four cardinal anchors when close.
 * Live drags render locally and commit once, on release, through
 * edge.data.onGeometryCommit.
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  useInternalNode,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type InternalNode,
} from '@xyflow/react'
import { Network, Trash2 } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import type { GraphNodeData } from './use-graph-data'

export type PortSide = 'top' | 'bottom' | 'left' | 'right'

export interface EdgeGeometryOverride {
  /** Cross-coordinates of the route's interior segments (waypoint model above) */
  coords?: number[]
  /** Pinned anchor on the source node's perimeter, degrees (0 = right,
   *  90 = bottom); absent = auto (facing side) */
  sourceAngle?: number
  /** Pinned anchor on the target node's perimeter; absent = auto */
  targetAngle?: number
  /** Count-chip position as a fraction of the route's length (default 0.5) */
  chipT?: number
}

export interface ElbowEdgeData extends Record<string, unknown> {
  geometry?: EdgeGeometryOverride
  /** Recorded interactions over this connection — shown as the count chip */
  count?: number
  /** Singular unit for the chip ("call", "fire", "run"…); pluralized here */
  unit?: string
  /** Edge is hovered (tracked by AgentGraph — the chip portal can't see :hover) */
  hovered?: boolean
  /** Details-view toggle: keep the count chip visible without hover */
  showDetails?: boolean
  onGeometryCommit?: (edgeId: string, patch: EdgeGeometryOverride) => void
  /** Remove the relationship behind this edge (shown as a toolbar button when selected) */
  onDelete?: (edgeId: string) => void
  /** Open the caller agent's permission editor (agent↔agent edges) */
  onEditPermissions?: (edgeId: string) => void
}

export type GraphEdge = Edge<ElbowEdgeData>

const BORDER_RADIUS = 12
/** Resource nodes anchor on their icon chip (h-10 w-10 in ResourceGraphNode),
 *  horizontally centered at the top of the node's layout box. */
const RESOURCE_CHIP = 40
/** Length of the port stub spawned when an end segment is dragged. */
const STUB = 20
/** Segments shorter than this get no handle — too small to grab. */
const MIN_GRAB_SEGMENT = 20
/** Route-complexity cap: stop spawning stub bends past this many coords. */
const MAX_COORDS = 9
/** Default count-chip distance from the target node along the route. */
const CHIP_NODE_OFFSET = 28

/** Endpoint drags snap to a cardinal anchor within this many degrees;
 *  in between, the dot rides the perimeter freely. */
const SNAP_DEGREES = 12

type Axis = 'h' | 'v'

function axisOf(side: PortSide): Axis {
  return side === 'left' || side === 'right' ? 'h' : 'v'
}

function outward(side: PortSide): 1 | -1 {
  return side === 'right' || side === 'bottom' ? 1 : -1
}

interface Box {
  cx: number
  cy: number
  left: number
  right: number
  top: number
  bottom: number
  /** Which perimeter the anchors ride: chips are circles, agent cards are boxes */
  shape: 'circle' | 'rect'
}

interface XYPoint {
  x: number
  y: number
}

function visualBox(node: InternalNode): Box {
  const { x, y } = node.internals.positionAbsolute
  const w = node.measured?.width ?? 0
  const h = node.measured?.height ?? 0
  if ((node.data as GraphNodeData | undefined)?.kind === 'agent') {
    return { cx: x + w / 2, cy: y + h / 2, left: x, right: x + w, top: y, bottom: y + h, shape: 'rect' }
  }
  const left = x + (w - RESOURCE_CHIP) / 2
  return {
    cx: left + RESOURCE_CHIP / 2,
    cy: y + RESOURCE_CHIP / 2,
    left,
    right: left + RESOURCE_CHIP,
    top: y,
    bottom: y + RESOURCE_CHIP,
    // Rounded square, like the agent cards — anchors ride the box perimeter.
    shape: 'rect',
  }
}

/** Perimeter anchor for an angle: where a ray from the node's center exits
 *  its visible shape, plus the cardinal side whose axis the route should
 *  exit along. */
function anchorFromAngle(box: Box, angleDeg: number): { point: XYPoint; side: PortSide } {
  const rad = (angleDeg * Math.PI) / 180
  const dx = Math.cos(rad)
  const dy = Math.sin(rad)
  let t: number
  if (box.shape === 'circle') {
    t = (box.right - box.left) / 2
  } else {
    // Ray–box intersection: distance to the first wall the ray hits.
    const hw = (box.right - box.left) / 2
    const hh = (box.bottom - box.top) / 2
    t = Math.min(hw / Math.max(Math.abs(dx), 1e-9), hh / Math.max(Math.abs(dy), 1e-9))
  }
  const norm = ((angleDeg % 360) + 360) % 360
  return {
    point: { x: box.cx + t * dx, y: box.cy + t * dy },
    side: norm < 45 || norm >= 315 ? 'right' : norm < 135 ? 'bottom' : norm < 225 ? 'left' : 'top',
  }
}

/** Pointer position → perimeter angle, magnetized to the cardinals. */
function angleForPoint(box: Box, p: XYPoint): number {
  const deg = (((Math.atan2(p.y - box.cy, p.x - box.cx) * 180) / Math.PI + 360) % 360 + 360) % 360
  for (const cardinal of [0, 90, 180, 270, 360]) {
    if (Math.abs(deg - cardinal) <= SNAP_DEGREES) return cardinal % 360
  }
  return Math.round(deg)
}

const SIDE_ANGLE: Record<PortSide, number> = { right: 0, bottom: 90, left: 180, top: 270 }

/** Auto route between two ports: L for perpendicular sides, midpoint S for
 *  facing sides, an outward bow when both ends leave from the same side. */
function defaultCoords(sp: XYPoint, sourceSide: PortSide, tp: XYPoint, targetSide: PortSide): number[] {
  const axis = axisOf(sourceSide)
  if (axis !== axisOf(targetSide)) return []
  if (sourceSide !== targetSide) {
    return [axis === 'h' ? (sp.x + tp.x) / 2 : (sp.y + tp.y) / 2]
  }
  const s = axis === 'h' ? sp.x : sp.y
  const t = axis === 'h' ? tp.x : tp.y
  return [outward(sourceSide) === 1 ? Math.max(s, t) + 2 * STUB : Math.min(s, t) - 2 * STUB]
}

function roundedPath(pts: XYPoint[]): string {
  const parts = [`M ${pts[0].x} ${pts[0].y}`]
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]
    const p = pts[i]
    const next = pts[i + 1]
    const inLen = Math.hypot(p.x - prev.x, p.y - prev.y)
    const outLen = Math.hypot(next.x - p.x, next.y - p.y)
    const r = Math.min(BORDER_RADIUS, inLen / 2, outLen / 2)
    if (r < 0.5) {
      parts.push(`L ${p.x} ${p.y}`)
      continue
    }
    const inPt = { x: p.x - ((p.x - prev.x) / inLen) * r, y: p.y - ((p.y - prev.y) / inLen) * r }
    const outPt = { x: p.x + ((next.x - p.x) / outLen) * r, y: p.y + ((next.y - p.y) / outLen) * r }
    parts.push(`L ${inPt.x} ${inPt.y}`, `Q ${p.x} ${p.y} ${outPt.x} ${outPt.y}`)
  }
  const last = pts[pts.length - 1]
  parts.push(`L ${last.x} ${last.y}`)
  return parts.join(' ')
}

interface RouteSegment {
  index: number
  axis: Axis
  mid: XYPoint
  length: number
}

interface ElbowGeometry {
  path: string
  /** Route corner points, source → target (for projecting drags onto the path) */
  points: XYPoint[]
  /** On-path anchor (chipT of the route's length in) — the toolbar/chip anchor */
  labelX: number
  /** Axis of the segment the anchor sits on (toolbar offsets perpendicular) */
  anchorAxis: Axis
  labelY: number
  segments: RouteSegment[]
  /** Effective interior coords (validated stored coords, or the auto route) */
  coords: number[]
  sourceSide: PortSide
  targetSide: PortSide
  sourcePoint: XYPoint
  targetPoint: XYPoint
  sourceBox: Box
  targetBox: Box
}

function elbowGeometry(
  sourceNode: InternalNode,
  targetNode: InternalNode,
  override: EdgeGeometryOverride,
): ElbowGeometry {
  const sourceBox = visualBox(sourceNode)
  const targetBox = visualBox(targetNode)
  // Auto sides: whichever sides face each other, so the connector never
  // doubles back through a node.
  const horizontal = Math.abs(targetBox.cx - sourceBox.cx) >= Math.abs(targetBox.cy - sourceBox.cy)
  const forward = horizontal ? targetBox.cx >= sourceBox.cx : targetBox.cy >= sourceBox.cy
  const autoSourceSide: PortSide = horizontal ? (forward ? 'right' : 'left') : forward ? 'bottom' : 'top'
  const autoTargetSide: PortSide = horizontal ? (forward ? 'left' : 'right') : forward ? 'top' : 'bottom'
  // Anchors ride the perimeter (any angle); the route exits along the
  // nearest cardinal's axis.
  const sourceAnchor = anchorFromAngle(sourceBox, override.sourceAngle ?? SIDE_ANGLE[autoSourceSide])
  const targetAnchor = anchorFromAngle(targetBox, override.targetAngle ?? SIDE_ANGLE[autoTargetSide])
  const sourceSide = sourceAnchor.side
  const targetSide = targetAnchor.side
  const sp = sourceAnchor.point
  const tp = targetAnchor.point
  const sourceAxis = axisOf(sourceSide)
  const targetAxis = axisOf(targetSide)

  // Segment count parity is fixed by the port axes; stored coords from
  // before a port re-pin may no longer fit — fall back to the auto route.
  const parityOk = override.coords && override.coords.length % 2 === (sourceAxis === targetAxis ? 1 : 0)
  const coords = parityOk && override.coords ? override.coords : defaultCoords(sp, sourceSide, tp, targetSide)

  // cross[i] = the cross-axis coordinate segment i runs along.
  const cross = [sourceAxis === 'h' ? sp.y : sp.x, ...coords, targetAxis === 'h' ? tp.y : tp.x]
  const pts: XYPoint[] = [sp]
  for (let i = 0; i + 1 < cross.length; i++) {
    const axis: Axis = i % 2 === 0 ? sourceAxis : sourceAxis === 'h' ? 'v' : 'h'
    pts.push(axis === 'h' ? { x: cross[i + 1], y: cross[i] } : { x: cross[i], y: cross[i + 1] })
  }
  pts.push(tp)

  const segments: RouteSegment[] = []
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    segments.push({
      index: i,
      axis: a.y === b.y ? 'h' : 'v',
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      length: Math.abs(a.x - b.x) + Math.abs(a.y - b.y),
    })
  }
  // Toolbar/chip anchor: a user-draggable fraction of the route's total
  // length — always ON the line, so the floating actions never drift from
  // it. Default: a fixed distance in from the TARGET end (the resource the
  // count describes), so chips hug their node instead of floating mid-air
  // on long routes; short routes fall back toward the middle. Its segment's
  // axis lets the toolbar offset perpendicular to the line.
  const total = segments.reduce((sum, s) => sum + s.length, 0)
  const defaultChipT = total > 0 ? Math.max(0.5, 1 - CHIP_NODE_OFFSET / total) : 0.5
  const chipT = Math.min(1, Math.max(0, override.chipT ?? defaultChipT))
  let anchor = pts[0]
  let anchorAxis: Axis = 'h'
  let remaining = total * chipT
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
    if (remaining <= length && length > 0) {
      const f = remaining / length
      anchor = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
      anchorAxis = a.y === b.y ? 'h' : 'v'
      break
    }
    remaining -= length
  }

  return {
    path: roundedPath(pts),
    points: pts,
    labelX: anchor.x,
    labelY: anchor.y,
    anchorAxis,
    segments,
    coords,
    sourceSide,
    targetSide,
    sourcePoint: sp,
    targetPoint: tp,
    sourceBox,
    targetBox,
  }
}

/** Where along the polyline (as a 0..1 fraction of its length) the point
 *  projects most closely. */
function pathFraction(points: XYPoint[], p: XYPoint): number {
  let total = 0
  const lengths: number[] = []
  for (let i = 0; i + 1 < points.length; i++) {
    const length = Math.abs(points[i + 1].x - points[i].x) + Math.abs(points[i + 1].y - points[i].y)
    lengths.push(length)
    total += length
  }
  if (total === 0) return 0.5
  let bestFraction = 0.5
  let bestDistance = Infinity
  let walked = 0
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]
    const b = points[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
    const cx = a.x + t * dx
    const cy = a.y + t * dy
    const d2 = (p.x - cx) ** 2 + (p.y - cy) ** 2
    if (d2 < bestDistance) {
      bestDistance = d2
      bestFraction = (walked + t * lengths[i]) / total
    }
    walked += lengths[i]
  }
  return bestFraction
}

/** Pointer-capture drag plumbing shared by segment pills and endpoint dots. */
function usePointerDrag(onStart: () => void, onMove: (p: XYPoint) => void, onEnd: () => void) {
  const { screenToFlowPosition } = useReactFlow()
  const dragging = useRef(false)
  return {
    onPointerDown: (event: ReactPointerEvent<Element>) => {
      dragging.current = true
      event.currentTarget.setPointerCapture(event.pointerId)
      event.stopPropagation()
      onStart()
    },
    onPointerMove: (event: ReactPointerEvent<Element>) => {
      if (!dragging.current) return
      onMove(screenToFlowPosition({ x: event.clientX, y: event.clientY }))
    },
    onPointerUp: (event: ReactPointerEvent<Element>) => {
      if (!dragging.current) return
      dragging.current = false
      event.currentTarget.releasePointerCapture(event.pointerId)
      onEnd()
    },
    // A cancelled pointer (touch scroll takeover, window blur mid-drag)
    // never fires pointerup — without this the uncommitted live geometry
    // stays applied until the next completed gesture.
    onPointerCancel: (event: ReactPointerEvent<Element>) => {
      if (!dragging.current) return
      dragging.current = false
      event.currentTarget.releasePointerCapture(event.pointerId)
      onEnd()
    },
  }
}

const HANDLE_FILL = 'hsl(var(--card))'
const HANDLE_STROKE = 'rgb(59 130 246)' // blue-500, matching the port dots

function SegmentHandle({
  segment,
  onStart,
  onMove,
  onEnd,
}: {
  segment: RouteSegment
  onStart: () => void
  onMove: (p: XYPoint) => void
  onEnd: () => void
}) {
  const handlers = usePointerDrag(onStart, onMove, onEnd)
  const along = 18
  const across = 5.5
  return (
    <rect
      className="elbow-drag-handle"
      x={segment.mid.x - (segment.axis === 'h' ? along : across) / 2}
      y={segment.mid.y - (segment.axis === 'h' ? across : along) / 2}
      width={segment.axis === 'h' ? along : across}
      height={segment.axis === 'h' ? across : along}
      rx={across / 2}
      fill={HANDLE_STROKE}
      style={{ cursor: segment.axis === 'h' ? 'ns-resize' : 'ew-resize', pointerEvents: 'all' }}
      {...handlers}
    />
  )
}

function EndpointDot({
  point,
  onMove,
  onEnd,
}: {
  point: XYPoint
  onMove: (p: XYPoint) => void
  onEnd: () => void
}) {
  const handlers = usePointerDrag(() => undefined, onMove, onEnd)
  return (
    <circle
      cx={point.x}
      cy={point.y}
      r={4.5}
      fill={HANDLE_FILL}
      stroke={HANDLE_STROKE}
      strokeWidth={1.5}
      style={{ cursor: 'move', pointerEvents: 'all' }}
      {...handlers}
    />
  )
}

/** Geometry + live-drag state shared by both edge components. Live drags
 *  render locally (no parent churn per pointermove) and commit on release —
 *  React batches the commit with the local reset, so there's no snap-back. */
function useElbow(id: string, source: string, target: string, data: ElbowEdgeData | undefined) {
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)
  const [live, setLive] = useState<EdgeGeometryOverride | null>(null)
  // Which segment the active drag steers. Dragging an END segment first
  // restructures the route (a stub bend appears at the port), shifting the
  // dragged segment's index — the pill that captured the pointer keeps
  // feeding moves to the right segment through this ref.
  const dragIndex = useRef<number | null>(null)
  if (!sourceNode || !targetNode) return null

  const geometry = elbowGeometry(sourceNode, targetNode, { ...data?.geometry, ...live })
  const commit = (patch: EdgeGeometryOverride) => {
    data?.onGeometryCommit?.(id, patch)
    setLive(null)
  }

  const beginSegmentDrag = (index: number) => {
    const last = geometry.segments.length - 1
    dragIndex.current = index
    if (index !== 0 && index !== last) return
    if (geometry.coords.length + 2 > MAX_COORDS) {
      dragIndex.current = null
      return
    }
    if (index === 0) {
      const axis = axisOf(geometry.sourceSide)
      const along = axis === 'h' ? geometry.sourcePoint.x : geometry.sourcePoint.y
      const crossCoord = axis === 'h' ? geometry.sourcePoint.y : geometry.sourcePoint.x
      setLive((prev) => ({
        ...prev,
        coords: [along + outward(geometry.sourceSide) * STUB, crossCoord, ...geometry.coords],
      }))
      dragIndex.current = 2
    } else {
      const axis = axisOf(geometry.targetSide)
      const along = axis === 'h' ? geometry.targetPoint.x : geometry.targetPoint.y
      const crossCoord = axis === 'h' ? geometry.targetPoint.y : geometry.targetPoint.x
      setLive((prev) => ({
        ...prev,
        coords: [...geometry.coords, crossCoord, along + outward(geometry.targetSide) * STUB],
      }))
      // The dragged segment keeps its index — the new bends land after it.
    }
  }

  const dragSegment = (p: XYPoint) => {
    const index = dragIndex.current
    if (index === null) return
    const segment = geometry.segments[index]
    if (!segment || index < 1 || index > geometry.coords.length) return
    const coords = [...geometry.coords]
    coords[index - 1] = segment.axis === 'h' ? p.y : p.x
    setLive((prev) => ({ ...prev, coords }))
  }

  const endSegmentDrag = () => {
    dragIndex.current = null
    if (live?.coords) commit({ coords: live.coords.map(Math.round) })
    else setLive(null)
  }

  return {
    geometry,
    beginSegmentDrag,
    dragSegment,
    endSegmentDrag,
    dragSource: (p: XYPoint) => setLive((prev) => ({ ...prev, sourceAngle: angleForPoint(geometry.sourceBox, p) })),
    endSource: () => (live?.sourceAngle !== undefined ? commit({ sourceAngle: live.sourceAngle }) : setLive(null)),
    dragTarget: (p: XYPoint) => setLive((prev) => ({ ...prev, targetAngle: angleForPoint(geometry.targetBox, p) })),
    endTarget: () => (live?.targetAngle !== undefined ? commit({ targetAngle: live.targetAngle }) : setLive(null)),
    dragChip: (p: XYPoint) => setLive((prev) => ({ ...prev, chipT: pathFraction(geometry.points, p) })),
    endChip: () => (live?.chipT !== undefined ? commit({ chipT: Math.round(live.chipT * 1000) / 1000 }) : setLive(null)),
  }
}

type UseElbowResult = NonNullable<ReturnType<typeof useElbow>>

/** Count chip riding the connector's midpoint: the number of recorded runs
 *  ("0 runs" = connected but never used). Shown on edge hover or while the
 *  details view is on; counter-scaled so it reads at true size at any zoom,
 *  like the node detail cards. */
function CountChip({
  geometry,
  count,
  unit,
  visible,
  onDragMove,
  onDragEnd,
}: {
  geometry: ElbowGeometry
  count: number
  unit: string
  visible: boolean
  onDragMove: (p: XYPoint) => void
  onDragEnd: () => void
}) {
  // Keep the chip alive mid-drag even when the pointer leaves the edge's
  // hover band (pointer capture keeps the events coming regardless).
  const [dragging, setDragging] = useState(false)
  const handlers = usePointerDrag(
    () => setDragging(true),
    onDragMove,
    () => {
      setDragging(false)
      onDragEnd()
    },
  )
  const shown = visible || dragging
  const amount = count >= 1000 ? `${(count / 1000).toFixed(1)}k` : `${count}`
  return (
    <EdgeLabelRenderer>
      <div
        className={cn(
          'nodrag nopan absolute cursor-grab select-none rounded-full border border-border/60 bg-card px-1.5 text-2xs leading-4 text-muted-foreground shadow-sm transition-opacity duration-150 active:cursor-grabbing dark:border-white/10 dark:bg-neutral-800',
          shown ? 'opacity-100' : 'opacity-0',
        )}
        style={{
          // Counter-scaled via --graph-zoom (published once by the canvas) so
          // the chip reads at true size without a per-chip zoom subscription.
          transform: `translate(${geometry.labelX}px, ${geometry.labelY}px) translate(-50%, -50%) scale(calc(1 / var(--graph-zoom, 1)))`,
          pointerEvents: shown ? 'all' : 'none',
          zIndex: 1001,
        }}
        {...handlers}
      >
        {amount} {unit}
        {count === 1 ? '' : 's'}
      </div>
    </EdgeLabelRenderer>
  )
}

/** Floating action chip above a selected connector: delete / edit permissions. */
function EdgeToolbar({
  id,
  geometry,
  data,
}: {
  id: string
  geometry: ElbowGeometry
  data: ElbowEdgeData | undefined
}) {
  if (!data?.onDelete && !data?.onEditPermissions) return null
  // Offset perpendicular to the anchor's segment — an "always above" offset
  // would sit ON a vertical line, where the selected edge's elevated
  // interaction band (z ~1000) swallows the clicks. zIndex keeps it above
  // that band even where they still graze.
  const dx = geometry.anchorAxis === 'v' ? 28 : 0
  const dy = geometry.anchorAxis === 'v' ? 0 : -24
  return (
    <EdgeLabelRenderer>
      <div
        className="nodrag nopan absolute flex items-center gap-0.5 rounded-md border border-border/60 bg-card p-0.5 shadow-sm"
        style={{
          transform: `translate(-50%, -50%) translate(${geometry.labelX + dx}px, ${geometry.labelY + dy}px)`,
          pointerEvents: 'all',
          zIndex: 1001,
        }}
      >
        {data.onEditPermissions && (
          <button
            type="button"
            title="Edit permissions"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => data.onEditPermissions?.(id)}
            data-testid="graph-edge-edit"
          >
            <Network className="h-3 w-3" />
          </button>
        )}
        {data.onDelete && (
          <button
            type="button"
            title="Remove connection"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-red-500"
            onClick={() => data.onDelete?.(id)}
            data-testid="graph-edge-delete"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
    </EdgeLabelRenderer>
  )
}

function ElbowControls({ elbow, selected }: { elbow: UseElbowResult; selected?: boolean }) {
  const { geometry } = elbow
  // Handles appear only once the connector is clicked (the ~20px interaction
  // path means "close to it" counts) — hover stays reserved for the usage label.
  if (!selected) return null
  return (
    <>
      {geometry.segments
        .filter((s) => s.length >= MIN_GRAB_SEGMENT)
        .map((s) => (
          <SegmentHandle
            key={s.index}
            segment={s}
            onStart={() => elbow.beginSegmentDrag(s.index)}
            onMove={elbow.dragSegment}
            onEnd={elbow.endSegmentDrag}
          />
        ))}
      <EndpointDot point={geometry.sourcePoint} onMove={elbow.dragSource} onEnd={elbow.endSource} />
      <EndpointDot point={geometry.targetPoint} onMove={elbow.dragTarget} onEnd={elbow.endTarget} />
    </>
  )
}

type ElbowProps = EdgeProps<GraphEdge>

export function ElbowEdge({
  id,
  source,
  target,
  style,
  data,
  selected,
  label,
  labelStyle,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  interactionWidth,
}: ElbowProps) {
  const elbow = useElbow(id, source, target, data)
  if (!elbow) return null
  const { geometry } = elbow
  return (
    <>
      <BaseEdge
        path={geometry.path}
        style={style}
        interactionWidth={interactionWidth}
        label={label}
        labelX={geometry.labelX}
        labelY={geometry.labelY}
        labelStyle={labelStyle}
        labelBgStyle={labelBgStyle}
        labelBgPadding={labelBgPadding}
        labelBgBorderRadius={labelBgBorderRadius}
      />
      {data?.count !== undefined && (
        <CountChip
          geometry={geometry}
          count={data.count}
          unit={data.unit ?? 'run'}
          visible={!!data.hovered || !!data.showDetails}
          onDragMove={elbow.dragChip}
          onDragEnd={elbow.endChip}
        />
      )}
      <ElbowControls elbow={elbow} selected={selected} />
      {selected && <EdgeToolbar id={id} geometry={geometry} data={data} />}
    </>
  )
}

