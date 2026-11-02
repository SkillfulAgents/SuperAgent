import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Folder, Loader2 } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { OFFERED_ORBS } from '@renderer/components/agents/agent-avatar/avatar-orbs'
import { subscribeToFrames } from '@renderer/components/agents/agent-avatar/orb-ticker'
import { useAgents, type ApiAgent } from '@renderer/hooks/use-agents'
import { teamBrainSource } from '@renderer/lib/team-brain/team-brain-sources'
import { TEAM_BRAIN_SOURCE_IDS } from '@renderer/lib/team-brain/team-brain-schema'
import { TeamBrainMark } from './team-brain-mark'
import { TeamBrainSourceIcon } from './team-brain-source-icon'

/**
 * The picture that explains Team Brain in one look: a constellation of the
 * workspace's own agents and the sources it reads, every one joined to the
 * brain, and under it the folders it keeps, fading into the headline below. A
 * slow loop shows one thing at a time: Slack comes in and Customer Intel lights
 * up and reads "Updating", an agent reads, another agent adds to Product
 * Knowledge. Laid out on a fixed 816x500 stage so the lines and the nodes share
 * one coordinate space; the stage scales as a unit on narrow windows.
 */
const W = 816
const H = 500
const BRAIN = { x: W / 2, y: 210, half: 28 }
// Lines stop this far from the brain's centre, just clear of its tile.
const REACH = 36
const BLOOM = 220
const LOOP_S = 12
const LOOP = `${LOOP_S}s`
// When in the loop (as fractions of it) each pulse runs, and the folder row a pulse into the brain lands in.
const SLACK_IN = { from: 0.0333, to: 0.1667, row: 1 }
const AGENT_READ = { from: 0.45, to: 0.5833 }
const AGENT_WRITE = { from: 0.6667, to: 0.8, row: 2 }
// A row reads "Updating" this long after its pulse lands, while it's tinted, then "now".
const UPDATING = 0.12

// Where each node sits relative to the brain, left to right, in a dome that rises
// highest over the brain. Sources and agents take turns, so the two mix; a spot
// with nothing to fill it stays a faint star.
const SLOTS: readonly (readonly [number, number])[] = [
  [-292, -83], [-255, -131], [-242, -30], [-210, -104], [-181, -161], [-158, -40], [-129, -135],
  [-68, -78], [-65, -164], [-6, -189], [21, -152], [43, -93], [113, -170], [113, -90],
  [153, -151], [153, -20], [181, -93], [227, -136], [231, -5], [239, -81], [275, -122],
]
const AGENT_SLOTS = SLOTS.filter((_, i) => i % 2 === 1)
// Agents never repeat a colour or a shape, unless a workspace can't otherwise show this many.
const MIN_AGENTS = 3
const SOURCE_SLOTS = SLOTS.filter((_, i) => i % 2 === 0)
// Nodes along the top of the dome are drawn a size smaller, so it reads with some depth.
const isFar = (dy: number) => dy < -130

// The block tucks well under the brain's lower edge and runs to the bottom of the
// stage, fading out on the way, so it seems to rise out of the headline below.
const BLOCK = { x: BRAIN.x - 130, y: BRAIN.y + 14, w: 260, h: H - BRAIN.y - 14 }
// The block is solid down to this share of its height, then fades to nothing at the stage's bottom.
const SOLID = 0.5
const FADE = `linear-gradient(to bottom, #000 ${SOLID * 100}%, transparent)`
/** How much of the picture's height, from its bottom, the folder block's fade covers; the page lines its own fades up with it. */
export const FOLDER_FADE_SHARE = (BLOCK.h * (1 - SOLID)) / H
const FOLDER_ROW = { top: 52, h: 30 }

const FOLDERS: { name: string; meta: string }[] = [
  { name: 'Company Info', meta: '2d' },
  { name: 'Customer Intel', meta: '3h' },
  { name: 'Product Knowledge', meta: '1h' },
  { name: 'Engineering Docs', meta: '5h' },
  { name: 'Meetings', meta: '1d' },
  { name: 'Brand Guidelines', meta: '3d' },
  { name: 'Sales Playbooks', meta: '4d' },
]

const paletteIndex = (agent: Pick<ApiAgent, 'avatar'>) => {
  const index = agent.avatar ? OFFERED_ORBS.findIndex((orb) => orb.name === agent.avatar?.color) : -1
  return index === -1 ? OFFERED_ORBS.length : index
}

/**
 * Up to `max` agents that read as a set: as many as the workspace allows with no
 * colour or shape twice (a largest matching of colours to shapes, so one early
 * agent can't crowd out two later ones). Repeats come in only to reach `min`,
 * new colours first. The picks run in palette order, warm to cool like the picker.
 */
export function pickDiagramAgents<T extends Pick<ApiAgent, 'avatar'>>(agents: readonly T[], max: number, min = 0): T[] {
  const byColor = new Map<string, T[]>()
  for (const agent of agents) {
    if (!agent.avatar) continue
    byColor.set(agent.avatar.color, [...(byColor.get(agent.avatar.color) ?? []), agent])
  }
  // Kuhn's augmenting paths: give each colour a shape, moving earlier picks to another of their shapes if that frees one.
  const byShape = new Map<string, T>()
  const place = (color: string, tried: Set<string>): boolean => {
    for (const agent of byColor.get(color) ?? []) {
      const shape = agent.avatar!.shape
      if (tried.has(shape)) continue
      tried.add(shape)
      const holder = byShape.get(shape)
      if (!holder || place(holder.avatar!.color, tried)) {
        byShape.set(shape, agent)
        return true
      }
    }
    return false
  }
  for (const color of byColor.keys()) place(color, new Set())

  const matched = new Set(byShape.values())
  const picked = agents.filter((agent) => matched.has(agent)).slice(0, max)
  const colors = new Set(picked.map((agent) => agent.avatar?.color))
  const fill = (fits: (agent: T) => boolean) => {
    for (const agent of agents) {
      if (picked.length >= Math.min(min, max)) return
      if (picked.includes(agent) || !fits(agent)) continue
      picked.push(agent)
      colors.add(agent.avatar?.color)
    }
  }
  fill((agent) => !!agent.avatar && !colors.has(agent.avatar.color))
  fill(() => true)
  return picked.sort((a, b) => paletteIndex(a) - paletteIndex(b))
}

interface Node {
  x: number
  y: number
  size: number
}

const place = ([dx, dy]: readonly [number, number], near: number, far: number): Node => ({
  x: BRAIN.x + dx,
  y: BRAIN.y + dy,
  size: isFar(dy) ? far : near,
})

// Confluence and Jira both wear Atlassian's mark; one of them is enough in the picture.
const SOURCES = TEAM_BRAIN_SOURCE_IDS.filter((id) => id !== 'confluence')
const SOURCE_NODES = SOURCE_SLOTS.slice(0, SOURCES.length).map((slot) => place(slot, 38, 32))
const AGENT_NODES = AGENT_SLOTS.map((slot) => place(slot, 30, 26))

/** The agent spots `count` agents take, spread evenly across the dome; the rest stay empty. */
function agentSpots(count: number) {
  const taken =
    count >= AGENT_NODES.length
      ? AGENT_NODES.map((_, i) => i)
      : count === 1
        ? [Math.floor(AGENT_NODES.length / 2)]
        : Array.from({ length: count }, (_, i) => Math.round((i * (AGENT_NODES.length - 1)) / (count - 1)))
  return taken.map((i) => AGENT_NODES[i])
}

// Every node drifts a few pixels on its own slow loop, so the constellation breathes.
const DRIFT = { reach: 4, period: 9 }

function drift(i: number, t: number) {
  const phase = i * 2.39 // golden-angle offsets, as the home page's clouds use
  const speed = (2 * Math.PI * (0.8 + 0.15 * (i % 4))) / DRIFT.period
  return {
    dx: DRIFT.reach * Math.sin(speed * t + phase),
    dy: DRIFT.reach * Math.cos(speed * 0.77 * t + phase * 1.7),
  }
}

/** The straight stretch from a node's edge to just outside the brain. */
function segment({ x, y, size }: Node) {
  const dx = BRAIN.x - x
  const dy = BRAIN.y - y
  const length = Math.hypot(dx, dy)
  const ux = dx / length
  const uy = dy / length
  const from = size / 2 + 3
  return { x1: x + ux * from, y1: y + uy * from, x2: BRAIN.x - ux * REACH, y2: BRAIN.y - uy * REACH, length: length - from - REACH }
}

function ray(node: Node) {
  const { x1, y1, x2, y2 } = segment(node)
  const fmt = (n: number) => n.toFixed(1)
  return `M ${fmt(x1)} ${fmt(y1)} L ${fmt(x2)} ${fmt(y2)}`
}

// A pulse is a short glowing stretch of a node's line that runs from one end to the other.
const PULSE = 26
const PULSE_GLOW = { filter: 'drop-shadow(0 0 3px hsl(var(--brand) / 0.9))' }

/**
 * A laser pulse along a node's line between two points of the loop (fractions
 * of it), into the brain or, with `reverse`, out of it. While it waits the dash
 * sits just off one end of the line, its round cap clear of the line too.
 */
function Pulse({
  node,
  from,
  to,
  reverse,
  pathRef,
}: {
  node: Node
  from: number
  to: number
  reverse?: boolean
  pathRef: (path: SVGPathElement | null) => void
}) {
  const { length } = segment(node)
  const atStart = PULSE + 4
  const atEnd = -(length + 4)
  const [first, last] = reverse ? [atEnd, atStart] : [atStart, atEnd]
  return (
    <path
      ref={pathRef}
      d={ray(node)}
      fill="none"
      strokeWidth="2"
      strokeLinecap="round"
      strokeDasharray={`${PULSE} ${length + PULSE}`}
      strokeDashoffset={first}
      className="stroke-brand"
      style={PULSE_GLOW}
    >
      <animate
        attributeName="stroke-dashoffset"
        dur={LOOP}
        repeatCount="indefinite"
        calcMode="linear"
        values={`${first};${first};${last};${last}`}
        keyTimes={`0;${from};${to};1`}
      />
    </path>
  )
}

/** A folder row turning brand-tinted for a moment after something lands in it. In the block's own coordinates. */
function Flash({ row, at }: { row: number; at: number }) {
  return (
    <rect
      x={6}
      y={FOLDER_ROW.top + row * FOLDER_ROW.h}
      width={BLOCK.w - 12}
      height={FOLDER_ROW.h}
      rx="7"
      opacity="0"
      className="fill-brand/10"
    >
      <animate
        attributeName="opacity"
        dur={LOOP}
        repeatCount="indefinite"
        values="0;0;1;1;0;0"
        keyTimes={`0;${at};${at + 0.025};${at + UPDATING};${at + 0.18};1`}
      />
    </rect>
  )
}

export function TeamBrainDiagram({ className }: { className?: string }) {
  const { data: agents = [] } = useAgents()
  const shown = pickDiagramAgents(agents, AGENT_SLOTS.length, MIN_AGENTS)
  const sourceNodes = SOURCE_NODES
  const filled = agentSpots(shown.length)

  // Sources then agents, the order the lines are drawn in; the drift moves each node and its line together.
  const nodeRefs = useRef<(HTMLElement | null)[]>([])
  const rayRefs = useRef<(SVGPathElement | null)[]>([])
  // Each pulse rides on one node's line, by that node's index above.
  const pulseRefs = useRef<Record<string, { index: number; path: SVGPathElement | null }>>({})
  const pulseRef = (name: string, index: number) => (path: SVGPathElement | null) => {
    pulseRefs.current[name] = { index, path }
  }
  // The pulses' own clock, so a folder row says "Updating" just as its pulse lands.
  const pulsesRef = useRef<SVGSVGElement>(null)
  const rowRefs = useRef<(HTMLLIElement | null)[]>([])
  const agentCount = shown.length
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const linked = [...SOURCE_NODES, ...agentSpots(agentCount)]
    const landings = agentCount > 0 ? [SLACK_IN, AGENT_WRITE] : [SLACK_IN]
    const clock = pulsesRef.current
    const start = performance.now()
    return subscribeToFrames((now) => {
      // Each row: its old age until the first pulse lands, then "Updating" while tinted, then "now".
      if (typeof clock?.getCurrentTime === 'function') {
        const loops = clock.getCurrentTime() / LOOP_S
        for (const { to, row } of landings) {
          const since = loops - to
          const state = since < 0 ? 'idle' : since % 1 < UPDATING ? 'updating' : 'now'
          const element = rowRefs.current[row]
          if (element && element.dataset.state !== state) element.dataset.state = state
        }
      }
      const t = (now - start) / 1000
      const rays = linked.map((node, i) => {
        const { dx, dy } = drift(i, t)
        const element = nodeRefs.current[i]
        if (element) element.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`
        const d = ray({ ...node, x: node.x + dx, y: node.y + dy })
        rayRefs.current[i]?.setAttribute('d', d)
        return d
      })
      for (const { index, path } of Object.values(pulseRefs.current)) path?.setAttribute('d', rays[index])
    })
  }, [agentCount])

  const frameRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const measure = () => {
      const next = Math.min(1, frame.clientWidth / W)
      setScale((previous) => (previous === next ? previous : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={frameRef}
      className={cn('relative mx-auto w-full max-w-[816px] text-left', className)}
      style={{ aspectRatio: `${W} / ${H}` }}
      aria-label="Your agents and sources connect to Team Brain, which keeps its folders up to date"
      role="img"
      data-testid="team-brain-diagram"
    >
      <div className="absolute left-0 top-0 origin-top-left" style={{ width: W, height: H, transform: `scale(${scale})` }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full text-foreground/[0.06]" aria-hidden="true">
          {[...sourceNodes, ...filled].map((node, i) => (
            <path
              key={`${node.x}-${node.y}`}
              ref={(path) => {
                rayRefs.current[i] = path
              }}
              d={ray(node)}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
            />
          ))}
        </svg>
        <svg ref={pulsesRef} viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full motion-reduce:hidden" aria-hidden="true">
          <Pulse node={sourceNodes[0]} from={SLACK_IN.from} to={SLACK_IN.to} pathRef={pulseRef('in', 0)} />
          {filled.length > 0 && (
            <>
              <Pulse node={filled[0]} from={AGENT_READ.from} to={AGENT_READ.to} reverse pathRef={pulseRef('read', sourceNodes.length)} />
              <Pulse
                node={filled[filled.length - 1]}
                from={AGENT_WRITE.from}
                to={AGENT_WRITE.to}
                pathRef={pulseRef('write', sourceNodes.length + filled.length - 1)}
              />
            </>
          )}
        </svg>

        {SOURCES.map((id, i) => {
          const { x, y, size } = sourceNodes[i]
          return (
            <div
              key={id}
              ref={(element) => {
                nodeRefs.current[i] = element
              }}
              title={teamBrainSource(id).name}
              className="absolute flex items-center justify-center rounded-full border bg-card shadow-sm"
              style={{ left: x - size / 2, top: y - size / 2, width: size, height: size }}
            >
              <TeamBrainSourceIcon id={id} className={size > 32 ? 'h-[18px] w-[18px]' : 'h-4 w-4'} />
            </div>
          )
        })}

        {shown.map((agent, i) => {
          const { x, y, size } = filled[i]
          return (
            <span
              key={agent.slug}
              ref={(element) => {
                nodeRefs.current[SOURCE_NODES.length + i] = element
              }}
              title={agent.name}
              className="absolute"
              style={{ left: x - size / 2, top: y - size / 2 }}
            >
              {agent.avatar ? (
                <AgentAvatar agent={agent} size={size} />
              ) : (
                <span className="block rounded-full bg-muted" style={{ width: size, height: size }} />
              )}
            </span>
          )
        })}

        {/* A soft blue bloom behind the brain; the folder block covers its lower half. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute rounded-full"
          style={{
            left: BRAIN.x - BLOOM / 2,
            top: BRAIN.y - BLOOM / 2,
            width: BLOOM,
            height: BLOOM,
            background: 'radial-gradient(circle, hsl(var(--brand) / 0.35) 0%, hsl(var(--brand) / 0.12) 38%, transparent 70%)',
            filter: 'blur(6px)',
          }}
        />
        <span className="absolute z-10" style={{ left: BRAIN.x - BRAIN.half, top: BRAIN.y - BRAIN.half }}>
          <TeamBrainMark size="lg" className="shadow-md" />
        </span>

        <div
          className="absolute"
          style={{ left: BLOCK.x, top: BLOCK.y, width: BLOCK.w, height: BLOCK.h, maskImage: FADE, WebkitMaskImage: FADE }}
        >
          <div className="absolute inset-0 rounded-[14px] border bg-card">
            <div className="border-b border-border/60 px-3 pb-2.5 pt-[18px] text-[13px] font-medium leading-[18px]">Team Brain</div>
          </div>
          <svg viewBox={`0 0 ${BLOCK.w} ${BLOCK.h}`} className="absolute inset-0 h-full w-full motion-reduce:hidden" aria-hidden="true">
            <Flash row={SLACK_IN.row} at={SLACK_IN.to} />
            {filled.length > 0 && <Flash row={AGENT_WRITE.row} at={AGENT_WRITE.to} />}
          </svg>
          <ul className="absolute" style={{ left: 12, top: FOLDER_ROW.top, width: BLOCK.w - 24 }}>
            {FOLDERS.map(({ name, meta }, row) => (
              // data-state (idle, updating, now) is written by the frame loop above.
              <li
                key={name}
                ref={(element) => {
                  rowRefs.current[row] = element
                }}
                className="group flex items-center gap-2 text-xs"
                style={{ height: FOLDER_ROW.h }}
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" strokeWidth={1.75} aria-hidden="true" />
                <span className="min-w-0 truncate text-muted-foreground">{name}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1 pl-2 text-[11px] text-muted-foreground group-data-[state=updating]:text-brand">
                  <Loader2 className="hidden h-3 w-3 animate-spin group-data-[state=updating]:block" aria-hidden="true" />
                  <span className="group-data-[state=now]:hidden group-data-[state=updating]:hidden">{meta}</span>
                  <span className="hidden group-data-[state=updating]:inline">Updating</span>
                  <span className="hidden group-data-[state=now]:inline">now</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
