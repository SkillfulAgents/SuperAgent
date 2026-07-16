/**
 * Deterministic initial layout for the home connections graph.
 *
 * Hybrid, in three bands:
 *  1. The connected subgraph (agents that have resources or permission
 *     edges, plus those resources) is laid out with a force simulation
 *     (d3-force: link springs + many-body repulsion + collision), which
 *     produces the organic mind-map shape, pulls shared resources between
 *     their agents, and physically prevents node overlap.
 *  2. Bare agents (no edges at all) pack into a tight grid below — a
 *     workspace with a long tail of unconnected agents stays compact
 *     instead of inflating the force cloud.
 *  3. Unlinked resources wrap into their own grid at the bottom.
 *
 * Deterministic: inputs are sorted, seeds are computed (never random), and
 * the simulation runs a fixed number of synchronous ticks — d3-force's
 * only "randomness" is a constant-seeded LCG used when nodes coincide.
 * User-dragged positions override these.
 */

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'
import type { GraphEdgeSpec, GraphNodeSpec } from './use-graph-data'

export interface XY {
  x: number
  y: number
}

// Collision radii cover the rendered footprint (agent card ~176×80,
// resource chip + label ~128×80) plus breathing room.
const AGENT_COLLIDE_RADIUS = 135
const RESOURCE_COLLIDE_RADIUS = 85
const SIMULATION_TICKS = 300

// Grid cells for the disconnected bands.
const BARE_CELL_WIDTH = 250
const BARE_CELL_HEIGHT = 130
const ORPHAN_CELL_WIDTH = 170
const ORPHAN_CELL_HEIGHT = 130
const BAND_GAP = 200
const MIN_GRID_WIDTH = 1250

interface SimNode extends SimulationNodeDatum {
  id: string
  isAgent: boolean
}

type SimLink = SimulationLinkDatum<SimNode> & { variant: GraphEdgeSpec['variant'] }

function round(p: { x: number; y: number }): XY {
  return { x: Math.round(p.x), y: Math.round(p.y) }
}

/** Lay a sorted id list into a fixed-width grid; returns the band's height. */
function packGrid(
  positions: Record<string, XY>,
  ids: string[],
  originY: number,
  width: number,
  cellWidth: number,
  cellHeight: number,
): number {
  const columns = Math.max(1, Math.floor(width / cellWidth))
  ids.forEach((id, i) => {
    positions[id] = round({
      x: (i % columns) * cellWidth,
      y: originY + Math.floor(i / columns) * cellHeight,
    })
  })
  return Math.ceil(ids.length / columns) * cellHeight
}

export function computeLayout(nodes: GraphNodeSpec[], edges: GraphEdgeSpec[]): Record<string, XY> {
  const positions: Record<string, XY> = {}

  // Agent↔agent edges (permission, activity) relate agents without making a
  // resource anyone's "owner".
  const isAgentToAgent = (variant: GraphEdgeSpec['variant']) => variant === 'permission' || variant === 'activity'

  const linked = new Set<string>()
  for (const edge of edges) {
    linked.add(edge.source)
    linked.add(edge.target)
  }

  const connected = nodes.filter((n) => linked.has(n.id)).sort((a, b) => a.id.localeCompare(b.id))
  const bareAgents = nodes
    .filter((n) => n.data.kind === 'agent' && !linked.has(n.id))
    .map((n) => n.id)
    .sort()
  const orphanResources = nodes
    .filter((n) => n.data.kind !== 'agent' && !linked.has(n.id))
    .map((n) => n.id)
    .sort()

  // ── Band 1: force-directed connected subgraph ─────────────────────────
  let forceBottom = 0
  let forceWidth = 0
  if (connected.length > 0) {
    // Deterministic seed: connected agents on a coarse grid, each resource
    // near its first owner, nudged apart by index. The simulation relaxes
    // this into the final shape.
    const connectedAgents = connected.filter((n) => n.data.kind === 'agent').map((n) => n.id)
    const seedColumns = Math.max(1, Math.ceil(Math.sqrt(connectedAgents.length * (16 / 9))))
    const agentSeed = new Map<string, XY>()
    connectedAgents.forEach((id, i) => {
      agentSeed.set(id, { x: (i % seedColumns) * 420, y: Math.floor(i / seedColumns) * 420 })
    })
    const firstOwnerOf = new Map<string, string>()
    for (const edge of edges) {
      if (isAgentToAgent(edge.variant)) continue
      if (!firstOwnerOf.has(edge.target)) firstOwnerOf.set(edge.target, edge.source)
    }

    const simNodes: SimNode[] = connected.map((n, i) => {
      const isAgent = n.data.kind === 'agent'
      const seed = isAgent ? agentSeed.get(n.id) : agentSeed.get(firstOwnerOf.get(n.id) ?? '')
      const theta = (i * 2 * Math.PI) / connected.length
      return {
        id: n.id,
        isAgent,
        x: (seed?.x ?? 0) + 90 * Math.cos(theta),
        y: (seed?.y ?? 0) + 90 * Math.sin(theta),
      }
    })
    const simLinks: SimLink[] = edges.map((e) => ({ source: e.source, target: e.target, variant: e.variant }))

    const simulation = forceSimulation(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance((l) => (isAgentToAgent(l.variant) ? 340 : 170))
          // Resource springs bind satellites to their agent; agent↔agent
          // relations pull only gently — activity a bit more than permission,
          // so communicating agents drift toward each other.
          .strength((l) => (l.variant === 'permission' ? 0.04 : l.variant === 'activity' ? 0.12 : 0.5)),
      )
      .force(
        'charge',
        forceManyBody<SimNode>().strength((d) => (d.isAgent ? -650 : -220)),
      )
      .force(
        'collide',
        forceCollide<SimNode>()
          .radius((d) => (d.isAgent ? AGENT_COLLIDE_RADIUS : RESOURCE_COLLIDE_RADIUS))
          .strength(0.9),
      )
      // Weak centering keeps disconnected components of the subgraph from
      // repelling each other into the distance.
      .force('x', forceX(0).strength(0.05))
      .force('y', forceY(0).strength(0.05))
      .stop()
    simulation.tick(SIMULATION_TICKS)

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of simNodes) {
      minX = Math.min(minX, n.x ?? 0)
      minY = Math.min(minY, n.y ?? 0)
      maxX = Math.max(maxX, n.x ?? 0)
      maxY = Math.max(maxY, n.y ?? 0)
    }
    for (const n of simNodes) {
      positions[n.id] = round({ x: (n.x ?? 0) - minX, y: (n.y ?? 0) - minY })
    }
    forceBottom = maxY - minY
    forceWidth = maxX - minX
  }

  // ── Bands 2 + 3: grids for bare agents and unlinked resources ─────────
  const gridWidth = Math.max(MIN_GRID_WIDTH, forceWidth)
  let cursorY = connected.length > 0 ? forceBottom + BAND_GAP : 0
  if (bareAgents.length > 0) {
    cursorY += packGrid(positions, bareAgents, cursorY, gridWidth, BARE_CELL_WIDTH, BARE_CELL_HEIGHT) + BAND_GAP
  }
  if (orphanResources.length > 0) {
    packGrid(positions, orphanResources, cursorY, gridWidth, ORPHAN_CELL_WIDTH, ORPHAN_CELL_HEIGHT)
  }

  return positions
}
