import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { polar, radialTree, type RadialNode } from '@renderer/lib/team-brain/team-brain-radial'
import type { TeamBrainNode } from '@renderer/lib/team-brain/team-brain-structure'
import { revealDrive } from '@renderer/lib/team-brain/team-brain-budget'
import { subscribeToFrames } from '@renderer/components/agents/agent-avatar/orb-ticker'
import { CLICK_SLOP, prefersReducedMotion, useFrameWidth, type OpenFile } from './team-brain-radial-parts'

/** The outer ring, where every page sits; folders sit on rings inside it by depth. */
const RING = 300
const ZOOM = { min: 0.3, max: 4 }
/** Room left beyond the outer ring for page names, in screen pixels. */
const NAME_ROOM = 118
/** How far in from each side the frame fades out (`.team-brain-radial-fade`). */
const EDGE_FADE = 40
/** Sections are always named; deeper folders once zoomed in this far past the fitted view, or when in focus. */
const NAMED_DEPTH = 1
const NAME_DEEP_AT = 1.6
/** A chosen folder is turned to three o'clock, over this long. */
const TURN_MS = 700
const THREE_OCLOCK = Math.PI / 2
const TAU = 2 * Math.PI
/** An angle brought into one turn, 0 up to 2π. */
const wrap = (angle: number) => ((angle % TAU) + TAU) % TAU
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
/**
 * The tree's opening, when the page opens: a signal leaves the middle, the
 * sections light in turn clockwise from twelve over `sweepMs`, and it runs out
 * along every branch at one speed, reaching the pages on the rim `signalMs`
 * after their section. Each folder and page lights as it arrives, and names
 * come into focus just after. Meanwhile the whole tree turns in from a little
 * behind and draws closer, settling over `settleMs`.
 */
const ENTRY = { sweepMs: 520, signalMs: 950, settleMs: 2400, fromTurn: -0.5, fromZoom: 0.82, nameMs: 600, nameAfterMs: 90 }
/**
 * When a section joins or leaves, the others glide round to their new places over this long: apart first to make room
 * for one growing in, together after one has drawn back in.
 */
const GLIDE_MS = 550
/** The short way round from one angle to another. */
const shortest = (delta: number) => wrap(delta + Math.PI) - Math.PI
/**
 * The sections' ring, close round the middle; their pills all start on it, so
 * sections are held at least `SECTION_GAP` round from each other, which is
 * room for a pill and a little air at the fitted zoom. Deeper folders spread
 * out from here to `FOLDER_RING`.
 */
const SECTION_RING = 0.22 * RING
const SECTION_GAP = 0.6
const FOLDER_RING = 0.72 * RING
/**
 * Left alone, the tree drifts round, in radians a second, from this long after the last touch. It eases in gently over
 * `easeInMs`, and out over `easeOutMs` when the pointer comes onto it, quickly enough to read a name it has stopped on.
 */
/** How far the drift turns, in radians, before the tree is redrawn there; names flip sides at most this late. */
const DRIFT_REDRAW = 0.05
const DRIFT = { speed: 0.03, afterMs: 1500, easeInMs: 900, easeOutMs: 250 }
/**
 * While it drifts, a pulse every so often runs out from a section to one of its pages in the section's colour, as the
 * opening's signal does, and blooms on arrival: one leaves `everyMs` apart (give or take `jitterMs`), and each takes
 * `signalMs` to reach the rim. No more than `most` at once.
 */
const PULSE = { everyMs: 1100, jitterMs: 700, signalMs: 1400, most: 3 }
/** How far in a chosen branch may be zoomed, so a folder of one page doesn't fill the screen. */
const BRANCH_ZOOM_MAX = 2.4
const clampZoom = (k: number) => Math.min(Math.max(k, ZOOM.min), ZOOM.max)
/** The zoom that fits the whole tree, names and all, in a frame. */
const fitZoom = (width: number, height: number) => clampZoom((Math.min(width, height) / 2 - NAME_ROOM - EDGE_FADE) / RING)

type View = { x: number; y: number; k: number }

/** How wide a folder's name is set, in screen pixels, for the pill around it. Measured in the page's own font, once per name. */
const nameWidths = new Map<string, number>()
let measurer: CanvasRenderingContext2D | null | undefined
function nameWidth(text: string, size: number, font: string): number {
  const key = `${size}|${font}|${text}`
  const known = nameWidths.get(key)
  if (known !== undefined) return known
  if (measurer === undefined) measurer = document.createElement('canvas').getContext?.('2d') ?? null
  let width = text.length * size * 0.56
  if (measurer) {
    measurer.font = `${size}px ${font}`
    width = measurer.measureText(text).width
  }
  nameWidths.set(key, width)
  return width
}
/** Room around a folder's name inside its pill, in screen pixels. */
const PILL = { x: 6, y: 3.5 }
/** A page's dot, in the tree's own units, so it shrinks and grows with the zoom; a hovered one grows by half. */
const PAGE_DOT = 4
/** The middle's pill and the index under it: their heights, the gap between them, the index's name past its dot, and the room kept to the sections' pills, in screen pixels. */
const MIDDLE = { front: 12 + PILL.y * 2, index: 12, gap: 4, nameGap: 5, clearance: 8 }

/**
 * One colour per section, for its pages (and the signal racing out to them
 * as the tree opens), as the reference's file types are coloured. The README,
 * Team Brain's own page, is in the foreground colour. Drawn as `currentColor`.
 */
const SECTION_COLORS = ['text-sky-500', 'text-teal-500', 'text-orange-500', 'text-amber-500', 'text-pink-500', 'text-rose-500', 'text-violet-500', 'text-blue-500', 'text-emerald-500']

/** Where a node is drawn: its angle round the middle and its distance out. */
type Placement = { angle: number; radius: number }
type Drag = { x: number; y: number; from: { x: number; y: number; k: number }; target: RadialNode | null; moved: boolean; opens?: () => void }

/** A curved branch from a folder out to a child, bending at the middle ring (d3's radial link). */
function branch(parent: RadialNode, child: RadialNode, radius: (n: RadialNode) => number, angleOf: (n: RadialNode) => number): string {
  const r0 = radius(parent)
  const r1 = radius(child)
  const mid = (r0 + r1) / 2
  const from = polar(angleOf(parent), r0)
  // From the middle, a branch has no direction of its own, so it leaves along its child's.
  const c1 = polar(parent.kind === 'root' ? angleOf(child) : angleOf(parent), parent.kind === 'root' ? r1 * 0.2 : mid)
  const c2 = polar(angleOf(child), mid)
  const to = polar(angleOf(child), r1)
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} C ${c1.x.toFixed(1)} ${c1.y.toFixed(1)} ${c2.x.toFixed(1)} ${c2.y.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`
}

/**
 * The drive as a radial tree, after the "codebase as a tree" explorations:
 * Team Brain at the middle, sections and folders on rings, every page on the
 * outer ring with its name running outwards, coloured by section, every page
 * the same size. Hovering a page grows its name; hovering a folder
 * fades the rest and keeps everything under it. Clicking a folder keeps its
 * branch lit, turns the tree to bring it round to three o'clock and zooms to
 * fit the branch; clicking the background lets it go and returns to the whole
 * tree, centred. It floats on the page with no frame or buttons: a pinch (or
 * ctrl-scroll) zooms around the pointer, a plain scroll scrolls the page,
 * dragging pans, clicking a page opens it. Team Brain itself is the middle, left unmarked:
 * the sections ring it. It opens by growing out from the middle (see `ENTRY`), and left
 * alone it drifts slowly round (`DRIFT`), with pulses of colour running out to its pages (`PULSE`).
 */
export function TeamBrainRadial({
  drive,
  expanded,
  onExpandedChange,
  onOpenFile,
  height,
  onOpenCentre,
  onOpenIndex,
  retracting,
  onRetracted,
}: {
  drive: readonly TeamBrainNode[]
  /** Folders opened past what the tree shows on its own. */
  expanded: ReadonlySet<string>
  onExpandedChange: (expanded: ReadonlySet<string>) => void
  onOpenFile: OpenFile
  height: number
  /** The front page the middle opens; with none, the middle is left unmarked. */
  onOpenCentre?: () => void
  /** The agents' index, a page's dot and name just under the middle. */
  onOpenIndex?: () => void
  /** Sections the page is taking away: they draw back into the middle, the index with them, then `onRetracted` lets the page drop them. */
  retracting?: readonly string[]
  onRetracted?: () => void
}) {
  /** A folded folder just opened: chosen once the tree is laid out again with its contents. */
  const [opening, setOpening] = useState<string | null>(null)
  const shown = useMemo(() => revealDrive(drive, expanded), [drive, expanded])
  const nodes = useMemo(() => radialTree(shown, { sectionGap: SECTION_GAP }), [shown])
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const colors = useMemo(() => {
    const sections = nodes.filter((n) => n.depth === 1)
    let i = 0
    return new Map(sections.map((n) => [n.id, n.kind === 'file' ? 'text-foreground' : SECTION_COLORS[i++ % SECTION_COLORS.length]]))
  }, [nodes])
  const sectionColor = (node: RadialNode) => colors.get(node.section ?? '') ?? 'text-muted-foreground'
  const depth = useMemo(() => Math.max(...nodes.map((n) => n.depth)), [nodes])
  const frameRef = useRef<HTMLDivElement>(null)
  const width = useFrameWidth(frameRef)
  const [font, setFont] = useState('sans-serif')
  // The sections ring the middle closely, but never so close that a tree drawn small runs their pills into the middle's.
  // The middle's pill keeps one size on screen, so at the fitted zoom the ring sits at least that far out.
  const centred = !!onOpenCentre || !!onOpenIndex
  const sectionRing = useMemo(() => {
    if (!centred || width === 0) return SECTION_RING
    const clear = (nameWidth('Team Brain', 12, font) + PILL.x * 2) / 2 + MIDDLE.clearance
    return Math.min(Math.max(SECTION_RING, clear / fitZoom(width, height)), 0.6 * RING)
  }, [centred, width, height, font])
  // Sections ring the middle closely, their names running outwards; deeper folders spread out towards the pages.
  const radius = useCallback(
    (n: RadialNode) =>
      n.kind === 'file' || (n.hidden && n.depth > 1) ? RING : n.depth === 0 ? 0 : sectionRing + ((FOLDER_RING - sectionRing) * (n.depth - 1)) / Math.max(depth - 2, 1),
    [depth, sectionRing],
  )
  const svgRef = useRef<SVGSVGElement>(null)
  const viewRef = useRef<SVGGElement>(null)
  const view = useRef({ x: 0, y: 0, k: 1 })
  const drag = useRef<Drag | null>(null)
  /**
   * The last press panned the tree or opened a page in the drawer: its click goes no further, so it isn't taken for
   * a click on the page behind the drawer. Told here rather than by the click's target: the tree holds the pointer
   * from the press, so the click lands on the tree itself, not on the page pressed.
   */
  const swallowClick = useRef(false)
  const fitted = useRef(false)
  const [hovered, setHovered] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const fittedZoom = useRef(1)
  const [zoomedIn, setZoomedIn] = useState(false)
  const zoomedInRef = useRef(false)
  useEffect(() => {
    if (svgRef.current) setFont(getComputedStyle(svgRef.current).fontFamily || 'sans-serif')
  }, [])
  const [selected, setSelected] = useState<string | null>(null)
  /** How far the whole tree is turned, so a chosen folder sits at three o'clock. */
  const [turn, setTurn] = useState(0)
  const turnRef = useRef(0)
  /** The turn the tree is drawn at. While it turns, the rest is a rotation of the whole tree, so frames don't re-render it. */
  const drawnTurn = useRef(0)
  const turning = useRef(0)
  useEffect(() => () => cancelAnimationFrame(turning.current), [])
  /** What holds the drift: the last touch, the pointer over the tree, a chosen folder, a turn under way. */
  const lastTouch = useRef(0)
  const inside = useRef(false)
  const selectedRef = useRef<string | null>(null)
  useEffect(() => {
    selectedRef.current = selected
  }, [selected])
  const moveEndsAt = useRef(0)
  const angleOf = useCallback((n: RadialNode) => n.angle + turn, [turn])

  /** When the opening signal reaches each node, in ms from the page opening. Parents come before their children in `nodes`. */
  const arrivals = useMemo(() => {
    const speed = (RING - sectionRing) / ENTRY.signalMs
    const at = new Map<string, number>()
    for (const node of nodes) {
      const parent = node.parent ? byId.get(node.parent) : undefined
      if (!parent) continue
      // Nothing is drawn from the middle: the signal lights the sections in turn, and a page sitting
      // straight off the middle (the README) is reached as if it had a section of its own.
      at.set(
        node.id,
        parent.kind === 'root'
          ? ENTRY.sweepMs * (node.angle / TAU) + (radius(node) - sectionRing) / speed
          : at.get(parent.id)! + (radius(node) - radius(parent)) / speed,
      )
    }
    return at
  }, [nodes, byId, radius, sectionRing])
  const [entering, setEntering] = useState(() => !prefersReducedMotion())
  /** The opening's turn and zoom into place, which runs off the animation frames rather than the clock. A touch ends it early. */
  const [settling, setSettling] = useState(entering)
  const entryMs = useMemo(() => Math.max(ENTRY.settleMs, ...[...arrivals.values()].map((t) => t + ENTRY.nameAfterMs + ENTRY.nameMs)), [arrivals])
  useEffect(() => {
    if (!entering) return
    const done = setTimeout(() => setEntering(false), entryMs)
    return () => clearTimeout(done)
  }, [entering, entryMs])

  /**
   * After the opening, a section that joins the tree grows out from the middle on the opening's own timings, counted from
   * the section, and one being taken away (`retracting`) plays them backwards, pages first. Joining is noticed while
   * rendering, so the new nodes paint with their animation from their first frame. So is the index's coming and going.
   * Either way the others glide from where they were drawn (`placed`) to their new places, and a new section grows once
   * they have made room.
   */
  const sectionIds = nodes.filter((n) => n.depth === 1).map((n) => n.id)
  const sectionKey = sectionIds.join('\n')
  const [seen, setSeen] = useState({ sections: sectionKey, index: !!onOpenIndex })
  const [grown, setGrown] = useState<{ sections: ReadonlySet<string>; index: boolean } | null>(null)
  const placed = useRef<ReadonlyMap<string, Placement>>(new Map())
  const [glide, setGlide] = useState<{ from: ReadonlyMap<string, Placement> } | null>(null)
  if (seen.sections !== sectionKey || seen.index !== !!onOpenIndex) {
    const before = new Set(seen.sections.split('\n'))
    const added = sectionIds.filter((id) => !before.has(id))
    const index = !seen.index && !!onOpenIndex
    setSeen({ sections: sectionKey, index: !!onOpenIndex })
    if (!entering && !prefersReducedMotion()) {
      if (seen.sections !== sectionKey) setGlide({ from: placed.current })
      if (added.length > 0 || index) setGrown({ sections: new Set(added), index })
    }
  }
  const fromSection = (node: RadialNode) => (arrivals.get(node.id) ?? 0) - (arrivals.get(node.section ?? '') ?? 0)
  const leaving = useMemo(() => new Set(retracting), [retracting])
  /** How long a growing or retracting section's signal takes to reach its last page. */
  const reach = useCallback(
    (sections: ReadonlySet<string>) =>
      Math.max(0, ...nodes.flatMap((n) => (n.section && sections.has(n.section) ? [(arrivals.get(n.id) ?? 0) - (arrivals.get(n.section) ?? 0)] : []))),
    [nodes, arrivals],
  )
  const outReach = useMemo(() => reach(leaving), [reach, leaving])
  const restMs = ENTRY.nameAfterMs + ENTRY.nameMs
  useEffect(() => {
    if (!grown) return
    const done = setTimeout(() => setGrown(null), GLIDE_MS + reach(grown.sections) + restMs)
    return () => clearTimeout(done)
  }, [grown, reach, restMs])
  const retracted = useRef(onRetracted)
  retracted.current = onRetracted
  useEffect(() => {
    if (!retracting) return
    const done = setTimeout(() => retracted.current?.(), prefersReducedMotion() ? 0 : outReach + restMs)
    return () => clearTimeout(done)
  }, [retracting, outReach, restMs])

  /** How a node is animating, if it is: in with the opening or its section's growth, or out with its section, and from when. */
  const motionOf = (node: RadialNode): { out: boolean; at: number } | null => {
    if (entering) return { out: false, at: arrivals.get(node.id) ?? 0 }
    if (node.section && grown?.sections.has(node.section)) return { out: false, at: GLIDE_MS + fromSection(node) }
    if (node.section && leaving.has(node.section)) return { out: true, at: outReach - fromSection(node) }
    return null
  }
  /** The index comes in as its section does, and goes with the sections being taken away, last, as they reach the middle. */
  const indexMotion = entering ? null : grown?.index ? { out: false, at: GLIDE_MS } : retracting ? { out: true, at: outReach } : null
  /** Where a node's animations start, for the CSS in `team-brain.css`. */
  const startAt = (motion: { at: number }) => ({ '--arrive-at': `${Math.round(motion.at)}ms` }) as CSSProperties
  /** A motion's classes: the opening's, played backwards on the way out. */
  const play = (motion: { out: boolean } | null, name: string) => motion && cn(name, motion.out && 'team-brain-radial-out')

  /** Each page's way out from its section, section first: where a pulse runs. Pages straight off the middle have none. */
  const routes = useMemo(() => {
    const out = new Map<string, RadialNode[]>()
    for (const node of nodes) {
      if (node.kind !== 'file') continue
      const route: RadialNode[] = []
      for (let at: RadialNode | undefined = node; at && at.kind !== 'root'; at = at.parent ? byId.get(at.parent) : undefined) route.unshift(at)
      if (route.length > 1) out.set(node.id, route)
    }
    return out
  }, [nodes, byId])
  const pulseTargets = useRef<string[]>([])
  useEffect(() => {
    pulseTargets.current = [...routes.keys()]
  }, [routes])
  const [pulses, setPulses] = useState<{ id: number; page: string }[]>([])
  const pulseTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const timers = pulseTimers.current
    return () => timers.forEach(clearTimeout)
  }, [])


  /**
   * What stays lit: everything under the hovered folder, or the chosen one, and its line back to the
   * middle. Hovering a page only picks it out; it doesn't light a branch.
   */
  const hoveredFolder = hovered && byId.get(hovered)?.kind === 'folder' ? hovered : null
  const lead = hoveredFolder ?? selected
  const focus = useMemo(() => {
    if (!lead) return null
    const node = byId.get(lead)
    if (!node) return null
    const lit = new Set<string>([node.id])
    for (let up = node.parent; up; up = byId.get(up)?.parent ?? null) lit.add(up)
    const under = (id: string) => nodes.filter((n) => n.parent === id).forEach((n) => (lit.add(n.id), under(n.id)))
    under(node.id)
    return lit
  }, [lead, byId, nodes])

  const applyView = useCallback(() => {
    const { x, y, k } = view.current
    const spin = ((turnRef.current - drawnTurn.current) * 180) / Math.PI
    viewRef.current?.setAttribute('transform', `translate(${x} ${y}) scale(${k}) rotate(${spin})`)
    // Names, pills and pulses divide by this so they stay one size on screen at any zoom.
    svgRef.current?.style.setProperty('--graph-k', String(k))
    // The middle's name turns back by this, so it stays level while the tree turns round it.
    svgRef.current?.style.setProperty('--graph-spin', `${spin}deg`)
    const deep = k >= fittedZoom.current * NAME_DEEP_AT
    if (deep !== zoomedInRef.current) setZoomedIn((zoomedInRef.current = deep))
  }, [])
  // Once the tree is drawn at the new turn, the rotation standing in for it goes.
  useLayoutEffect(() => {
    drawnTurn.current = turn
    applyView()
  }, [turn, applyView])

  useEffect(() => {
    placed.current = new Map(nodes.map((n) => [n.id, { angle: n.angle, radius: radius(n) }]))
  }, [nodes, radius])
  const drawn = useRef({ nodes, byId, radius })
  drawn.current = { nodes, byId, radius }
  // The glide runs off the animation frames: React draws the new layout once, and each frame moves its nodes, names
  // and branches from where they were along the short way round, as the drift turns the whole tree. Names keep the
  // side they end on. It starts before the first paint, so the new layout never shows before the glide.
  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!glide || !svg) return
    const tagged = (attr: string) => new Map([...svg.querySelectorAll(`[${attr}]`)].map((el) => [el.getAttribute(attr) ?? '', el]))
    const nodeEls = tagged('data-node')
    const branchEls = tagged('data-branch')
    const spokeEls = tagged('data-spoke')
    const { nodes: laid, byId: laidById, radius: ring } = drawn.current
    const place = (e: number) => {
      const at = new Map<string, Placement>()
      for (const n of laid) {
        const from = glide.from.get(n.id)
        const to = { angle: n.angle, radius: ring(n) }
        at.set(n.id, from && e < 1 ? { angle: from.angle + shortest(to.angle - from.angle) * e, radius: from.radius + (to.radius - from.radius) * e } : to)
      }
      const angleAt = (n: RadialNode) => (at.get(n.id) ?? n).angle + drawnTurn.current
      const radiusAt = (n: RadialNode) => at.get(n.id)?.radius ?? ring(n)
      for (const n of laid) {
        if (n.kind === 'root') continue
        const p = polar(angleAt(n), radiusAt(n))
        nodeEls.get(n.id)?.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`)
        const spoke = spokeEls.get(n.id)
        if (spoke) {
          const degrees = (angleAt(n) * 180) / Math.PI - 90
          const offset = spoke.getAttribute('data-offset')
          spoke.setAttribute('transform', `rotate(${spoke.hasAttribute('data-flip') ? degrees + 180 : degrees})${offset ? ` ${offset}` : ''}`)
        }
        const parent = n.parent ? laidById.get(n.parent) : undefined
        const lines = branchEls.get(n.id)
        if (parent && lines) for (const line of lines.querySelectorAll('path')) line.setAttribute('d', branch(parent, n, radiusAt, angleAt))
      }
    }
    const started = performance.now()
    let frame = 0
    const step = (now: number) => {
      const t = Math.min((now - started) / GLIDE_MS, 1)
      place(easeInOut(t))
      if (t < 1) frame = requestAnimationFrame(step)
      else setGlide(null)
    }
    place(0)
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [glide])

  /** The whole tree, centred, with room for the page names around it and clear of the faded edges. */
  const fittedView = useCallback((): View => {
    const k = fitZoom(width, height)
    fittedZoom.current = k
    return { k, x: width / 2, y: height / 2 }
  }, [width, height])

  const fit = useCallback(() => {
    if (width === 0) return
    view.current = fittedView()
    applyView()
  }, [width, fittedView, applyView])

  /** A view filled by one folder's branch as it will sit once the tree is turned by `turned`, its pages' names running off to the right. */
  const branchView = useCallback(
    (folder: RadialNode, turned: number): View => {
      const ids = new Set([folder.id])
      const under = (id: string) => nodes.forEach((n) => n.parent === id && (ids.add(n.id), under(n.id)))
      under(folder.id)
      const points = nodes.filter((n) => ids.has(n.id)).map((n) => polar(n.angle + turned, radius(n)))
      const xs = points.map((p) => p.x)
      const ys = points.map((p) => p.y)
      const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
      const pad = 36
      const roomX = width - pad * 2 - NAME_ROOM
      // The top and bottom pages' names slant up and down, so they need headroom too.
      const roomY = height - pad * 2 - 48
      const k = Math.min(
        Math.max(Math.min(roomX / Math.max(maxX - minX, 1), roomY / Math.max(maxY - minY, 1)), fittedZoom.current),
        BRANCH_ZOOM_MAX,
      )
      return { k, x: pad + (roomX - (maxX - minX) * k) / 2 - minX * k, y: height / 2 - ((minY + maxY) / 2) * k }
    },
    [nodes, radius, width, height],
  )

  /** Turn the tree to `turned` (the short way round) and move the view to `to`, easing both together (in and out, unless told otherwise). */
  const moveTo = useCallback(
    (
      turned: number,
      to: View,
      { ms = TURN_MS, ease = easeInOut, onDone }: { ms?: number; ease?: (t: number) => number; onDone?: () => void } = {},
    ) => {
      cancelAnimationFrame(turning.current)
      moveEndsAt.current = performance.now() + ms
      const fromTurn = turnRef.current
      const toTurn = fromTurn + (wrap(turned - fromTurn + Math.PI) - Math.PI)
      const from = { ...view.current }
      const set = (t: number) => {
        turnRef.current = fromTurn + (toTurn - fromTurn) * t
        view.current = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, k: from.k + (to.k - from.k) * t }
        applyView()
      }
      if (prefersReducedMotion() || typeof requestAnimationFrame === 'undefined') {
        set(1)
        return onDone?.()
      }
      const startedAt = performance.now()
      const step = (now: number) => {
        const t = Math.min((now - startedAt) / ms, 1)
        set(ease(t))
        if (t < 1) turning.current = requestAnimationFrame(step)
        else {
          setTurn(turnRef.current)
          onDone?.()
        }
      }
      turning.current = requestAnimationFrame(step)
    },
    [applyView],
  )

  const zoomAt = useCallback(
    (mx: number, my: number, factor: number) => {
      const v = view.current
      const k = clampZoom(v.k * factor)
      view.current = { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k }
      applyView()
    },
    [applyView],
  )

  useEffect(() => {
    if (width === 0 || fitted.current) return
    fitted.current = true
    if (!entering) return fit()
    // Opening: start a little turned back and further off, and settle into place as the tree grows.
    const to = fittedView()
    view.current = { ...to, k: to.k * ENTRY.fromZoom }
    turnRef.current = ENTRY.fromTurn
    setTurn(ENTRY.fromTurn)
    applyView()
    moveTo(0, to, { ms: ENTRY.settleMs, ease: easeOutCubic, onDone: () => setSettling(false) })
  }, [width, fit, entering, fittedView, applyView, moveTo])

  // The frame narrowing or widening later (a column opening beside the page) settles the whole tree onto its new
  // size, unless a branch is chosen; then it keeps its view.
  const lastWidth = useRef(0)
  useEffect(() => {
    if (width === 0) return
    const previous = lastWidth.current
    lastWidth.current = width
    if (!fitted.current || previous === 0 || previous === width || selectedRef.current) return
    moveTo(turnRef.current, fittedView(), { ms: 300 })
  }, [width, fittedView, moveTo])

  // Scroll and pinch zoom around the pointer. Not a React handler: those are passive, so the page would scroll too.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (event: WheelEvent) => {
      // Free on the page, a plain scroll scrolls the page; a pinch (or ctrl-scroll) zooms.
      if (!event.ctrlKey) return
      event.preventDefault()
      cancelAnimationFrame(turning.current)
      setTurn(turnRef.current)
      setSettling(false)
      lastTouch.current = performance.now()
      const rect = svg.getBoundingClientRect()
      zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)))
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // Left alone, the tree drifts slowly round, easing in and, when the pointer comes onto it, out to a stop. A turn of
  // its own (a chosen folder, the opening) takes over at once.
  useEffect(() => {
    if (prefersReducedMotion()) return
    let last = performance.now()
    let velocity = 0
    let nextPulseAt = 0
    let pulseId = 0
    let live = 0
    return subscribeToFrames((now) => {
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      if (drag.current || selectedRef.current || now < moveEndsAt.current) return void (velocity = 0)
      const idle = !inside.current && now - lastTouch.current > DRIFT.afterMs
      velocity += ((idle ? DRIFT.speed : 0) - velocity) * Math.min((dt * 1000) / (idle ? DRIFT.easeInMs : DRIFT.easeOutMs), 1)
      if (velocity < 1e-4) return
      turnRef.current += velocity * dt
      if (Math.abs(turnRef.current - drawnTurn.current) > DRIFT_REDRAW) setTurn(turnRef.current)
      else applyView()
      // Pulses only while it is properly drifting, not while it eases to a stop under the pointer.
      if (!idle || velocity < DRIFT.speed / 2 || now < nextPulseAt || live >= PULSE.most) return
      const targets = pulseTargets.current
      if (targets.length === 0) return
      nextPulseAt = now + PULSE.everyMs + (Math.random() * 2 - 1) * PULSE.jitterMs
      const pulse = { id: pulseId++, page: targets[Math.floor(Math.random() * targets.length)] }
      live++
      setPulses((current) => [...current, pulse])
      // Gone once it has landed and its bloom has faded.
      const done = setTimeout(() => {
        live--
        pulseTimers.current.delete(done)
        setPulses((current) => current.filter((p) => p.id !== pulse.id))
      }, PULSE.signalMs + 1100)
      pulseTimers.current.add(done)
    })
  }, [applyView])

  const start = (event: ReactPointerEvent, target: RadialNode | null, opens?: () => void) => {
    if (event.button !== 0) return
    event.stopPropagation()
    // Taking hold stops any turn or zoom in progress, right where it is.
    cancelAnimationFrame(turning.current)
    setTurn(turnRef.current)
    setSettling(false)
    lastTouch.current = performance.now()
    moveEndsAt.current = 0
    drag.current = { x: event.clientX, y: event.clientY, from: { ...view.current }, target, moved: false, opens }
    svgRef.current?.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = event.clientX - d.x
    const dy = event.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < CLICK_SLOP) return
    if (!d.moved) {
      d.moved = true
      setDragging(true)
    }
    view.current = { ...d.from, x: d.from.x + dx, y: d.from.y + dy }
    applyView()
  }

  const end = () => {
    const d = drag.current
    drag.current = null
    setDragging(false)
    swallowClick.current = !!d && (d.moved || !!d.target?.file || !!d.opens)
    if (!d || d.moved) return
    if (d.opens) return d.opens()
    const target = d.target
    if (target?.file?.node.expands) {
      onExpandedChange(new Set(expanded).add(target.file.node.expands))
      return setOpening(target.file.node.expands)
    }
    if (target?.file) return onOpenFile(target.file.node, { path: target.file.path, folder: target.file.folder })
    if (target?.kind === 'folder' && target.folded) {
      onExpandedChange(new Set(expanded).add(target.id))
      return setOpening(target.id)
    }
    if (target?.kind === 'folder') {
      setSelected(target.id)
      const turned = THREE_OCLOCK - target.angle
      return moveTo(turned, branchView(target, turned))
    }
    // Clicking out: back to the whole tree, centred and turned back, with opened folders folded again.
    setSelected(null)
    onExpandedChange(new Set())
    moveTo(0, fittedView())
  }

  useEffect(() => {
    const target = opening ? byId.get(opening) : undefined
    // Turned to once its contents are listed and laid out.
    if (!target || !nodes.some((n) => n.parent === target.id)) return
    setOpening(null)
    setSelected(target.id)
    const turned = THREE_OCLOCK - target.angle
    moveTo(turned, branchView(target, turned))
  }, [opening, byId, nodes, moveTo, branchView])

  const pages = nodes.filter((n) => n.kind === 'file').length
  const dim = (id: string) => focus !== null && !focus.has(id)

  return (
    <div ref={frameRef} className="team-brain-radial-fade relative" style={{ height }} data-testid="team-brain-radial" data-entering={entering || settling || undefined}>
      <svg
        ref={svgRef}
        width={width}
        height={height}
        role="img"
        aria-label={`The drive as a radial tree of ${pages} pages`}
        className={cn('block touch-none select-none', dragging ? 'cursor-grabbing' : 'cursor-grab')}
        onPointerDown={(event) => start(event, null)}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onClick={(event) => {
          if (swallowClick.current) event.stopPropagation()
          swallowClick.current = false
        }}
        onPointerEnter={() => (inside.current = true)}
        onPointerLeave={() => {
          inside.current = false
          lastTouch.current = performance.now()
        }}
      >
        <g ref={viewRef}>
          {/* Branches: faint, except a lit branch's and a hovered page's own. */}
          <g fill="none">
            {nodes.map((node) => {
              const parent = node.parent ? byId.get(node.parent) : undefined
              // Nothing is drawn at the middle, so nothing runs to it.
              if (!parent || parent.kind === 'root') return null
              const d = branch(parent, node, radius, angleOf)
              const lit = (focus?.has(node.id) && focus.has(parent.id)) || hovered === node.id
              // While the tree opens, each branch is drawn out from its folder as the signal runs along it, and a short
              // head in its section's colour runs at the front. Measured along the branch (`pathLength`), so the stroke
              // scales with the view for now instead of staying one pixel: dashes and non-scaling strokes disagree on length.
              const motion = motionOf(node)
              const parentMotion = motionOf(parent)
              const grow = motion
                ? {
                    pathLength: 1,
                    style: {
                      '--grow-at': `${Math.round(Math.min(motion.at, parentMotion?.at ?? 0))}ms`,
                      '--grow-ms': `${Math.round(Math.abs(motion.at - (parentMotion?.at ?? 0)))}ms`,
                      '--head': Math.min(0.4, 16 / Math.max(Math.hypot(...Object.values(polar(0, radius(node) - radius(parent)))), 1)),
                    } as CSSProperties,
                  }
                : null
              return (
                <g key={node.id} data-branch={node.id}>
                  <path
                    d={d}
                    vectorEffect={grow ? undefined : 'non-scaling-stroke'}
                    strokeWidth={(lit ? 1.25 : 1) / (grow ? fittedZoom.current : 1)}
                    strokeOpacity={lit ? 0.4 : focus ? 0.03 : 0.1}
                    className={cn('pointer-events-none stroke-foreground transition-[stroke-opacity]', play(motion, 'team-brain-radial-grow'))}
                    {...grow}
                  />
                  {grow && !motion?.out && (
                    <path
                      d={d}
                      strokeWidth={1.75 / fittedZoom.current}
                      strokeLinecap="round"
                      className={cn('team-brain-radial-impulse pointer-events-none stroke-current', sectionColor(node))}
                      {...grow}
                    />
                  )}
                  {/* A page's line answers the pointer like the page does, over a band wider than the line itself. */}
                  {node.kind === 'file' && (
                    <path
                      d={d}
                      vectorEffect="non-scaling-stroke"
                      strokeWidth={10}
                      stroke="transparent"
                      pointerEvents="stroke"
                      className="cursor-pointer"
                      onPointerDown={(event) => start(event, node)}
                      onPointerEnter={() => !drag.current && setHovered(node.id)}
                      onPointerLeave={() => !drag.current && setHovered(null)}
                      data-testid={`team-brain-radial-branch-${node.id}`}
                    />
                  )}
                </g>
              )
            })}
          </g>

          {/* Pulses while it drifts: the opening's signal again, down one section's branch to one page, then a bloom. */}
          <g fill="none" className="pointer-events-none" aria-hidden="true">
            {pulses.map((pulse) => {
              const route = routes.get(pulse.page)
              if (!route) return null
              const speed = (RING - sectionRing) / PULSE.signalMs
              const page = route[route.length - 1]
              const end = polar(angleOf(page), radius(page))
              return (
                <g key={pulse.id} className={sectionColor(page)}>
                  {route.slice(1).map((child, i) => {
                    const parent = route[i]
                    const length = radius(child) - radius(parent)
                    return (
                      <path
                        key={child.id}
                        d={branch(parent, child, radius, angleOf)}
                        pathLength={1}
                        strokeLinecap="round"
                        className="team-brain-radial-impulse stroke-current"
                        style={
                          {
                            '--grow-at': `${Math.round((radius(parent) - sectionRing) / speed)}ms`,
                            '--grow-ms': `${Math.round(length / speed)}ms`,
                            '--head': Math.min(0.4, 16 / Math.max(length, 1)),
                            strokeWidth: 'calc(1.75px / var(--graph-k, 1))',
                          } as CSSProperties
                        }
                      />
                    )
                  })}
                  <circle
                    cx={end.x}
                    cy={end.y}
                    r={4}
                    className="team-brain-radial-bloom fill-current"
                    style={{ '--arrive-at': `${PULSE.signalMs}ms` } as CSSProperties}
                  />
                </g>
              )
            })}
          </g>

          {nodes.map((node) => {
            if (node.kind === 'root') {
              if (!onOpenCentre && !onOpenIndex) return null
              // The middle is Team Brain itself: its front pages as pills like the sections', the people's, and with the
              // team record shown the agents' just under it. Level and one size on screen however the tree turns or zooms.
              const frontWidth = nameWidth('Team Brain', 12, font) + PILL.x * 2
              // The index is a page's dot and name, in grey, hover and all. The dot keeps the tree's units as a page's does, so it is
              // sized through the zoom inside this screen-sized group (Tailwind needs those sizes written out); the pair is centred under the pill.
              const dot = (size: number) => `calc(${size}px * var(--graph-k, 1))`
              const indexName = nameWidth('INDEX', 9.5, font)
              const below = onOpenCentre ? MIDDLE.front / 2 + MIDDLE.gap + MIDDLE.index / 2 : 0
              return (
                <g key={node.id} style={entering ? startAt({ at: 0 }) : undefined} className={cn(entering && 'team-brain-radial-pop')} data-testid="team-brain-radial-centre">
                  <g style={{ transform: 'rotate(calc(-1 * var(--graph-spin, 0deg))) scale(calc(1 / var(--graph-k, 1)))' }}>
                    {onOpenCentre && (
                      <g onPointerDown={(event) => start(event, node, onOpenCentre)} className="group cursor-pointer" data-testid="team-brain-radial-front">
                        <rect
                          x={-frontWidth / 2}
                          y={-MIDDLE.front / 2}
                          width={frontWidth}
                          height={MIDDLE.front}
                          rx={MIDDLE.front / 2}
                          vectorEffect="non-scaling-stroke"
                          className="fill-background stroke-border transition-colors group-hover:stroke-foreground/40"
                        />
                        <text textAnchor="middle" dominantBaseline="central" className="fill-foreground" style={{ fontSize: '12px' }}>
                          Team Brain
                        </text>
                      </g>
                    )}
                    {onOpenIndex && (
                      <g
                        style={{ transform: `translate(calc(${-(MIDDLE.nameGap + indexName) / 2}px - ${dot(PAGE_DOT)}), ${below}px)` }}
                        onPointerDown={(event) => start(event, node, onOpenIndex)}
                        className="group cursor-pointer"
                        data-testid="team-brain-radial-index"
                      >
                        <g style={indexMotion ? startAt(indexMotion) : undefined} className={cn(play(indexMotion, 'team-brain-radial-pop'))}>
                          <circle className="fill-muted-foreground/50 transition-[r] [r:calc(4px*var(--graph-k,1))] group-hover:[r:calc(6px*var(--graph-k,1))]" />
                          <text
                            dominantBaseline="central"
                            className={cn(
                              'fill-muted-foreground/70 text-[9.5px] transition-[font-size] duration-150 ease-out group-hover:fill-foreground group-hover:font-medium group-hover:text-[11.5px]',
                              '[transform:translateX(calc(4px*var(--graph-k,1)+5px))] group-hover:[transform:translateX(calc(6px*var(--graph-k,1)+5px))]',
                            )}
                          >
                            INDEX
                          </text>
                        </g>
                      </g>
                    )}
                  </g>
                </g>
              )
            }
            const angle = angleOf(node)
            const p = polar(angle, radius(node))
            const motion = motionOf(node)
            // A folded folder below the sections stands on the pages' ring, named as a page is, with what it holds.
            const page = node.kind === 'file' || (!!node.hidden && node.depth > 1)
            const r = page ? PAGE_DOT : node.depth === 1 ? 3.5 : 2.5
            const isHovered = hovered === node.id
            const isSelected = selected === node.id
            const faded = dim(node.id)
            // Below the sections, a folder is unmarked (where its branches meet) until a zoom or a hover names it; named, it is a pill.
            const pill = !page && (node.depth <= NAMED_DEPTH || zoomedIn || (focus?.has(node.id) ?? false))
            // Names run outwards along their spoke, flipped on the left half so they read left to right.
            const degrees = (angle * 180) / Math.PI - 90
            const flip = wrap(angle) > Math.PI
            return (
              <g
                key={node.id}
                transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`}
                data-node={node.id}
                onPointerDown={(event) => start(event, node)}
                onPointerEnter={() => !drag.current && setHovered(node.id)}
                onPointerLeave={() => !drag.current && setHovered(null)}
                // A faded pill stays solid, so the lines behind it don't show through; only its outline and name fade.
                className={cn('cursor-pointer transition-opacity', faded && !pill && 'opacity-10')}
                data-testid={`team-brain-radial-node-${node.id}`}
                data-selected={isSelected || undefined}
              >
                {page ? (
                  <>
                    {/* As the signal reaches it, a page lights: a soft bloom of its colour, the dot, then its name. */}
                    {motion && !motion.out && <circle r={r} style={startAt(motion)} className={cn('team-brain-radial-bloom pointer-events-none fill-current', sectionColor(node))} />}
                    <circle
                      r={isHovered ? r * 1.5 : r}
                      style={motion ? startAt(motion) : undefined}
                      className={cn('fill-current transition-[r]', sectionColor(node), play(motion, 'team-brain-radial-pop'))}
                    />
                    {/* A hovered page's name grows a little, clear of its grown dot. Name and dot both take the click. */}
                    {/* Sized by a scale round where the name starts, not by font size, so a zoom re-lays out no text. */}
                    <g
                      transform={`rotate(${flip ? degrees + 180 : degrees}) translate(${(flip ? -1 : 1) * ((isHovered ? r * 1.5 : r) + 5)} 0)`}
                      data-spoke={node.id}
                      data-flip={flip || undefined}
                      data-offset={`translate(${(flip ? -1 : 1) * ((isHovered ? r * 1.5 : r) + 5)} 0)`}
                    >
                      <text
                        textAnchor={flip ? 'end' : 'start'}
                        dominantBaseline="central"
                        className={cn(
                          'transition-[font-size] duration-150 ease-out',
                          isHovered ? 'fill-foreground font-medium' : focus?.has(node.id) ? 'fill-foreground/80' : 'fill-muted-foreground/70',
                          play(motion, 'team-brain-radial-name'),
                        )}
                        style={{ fontSize: `${isHovered ? 11.5 : 9.5}px`, transform: 'scale(calc(1 / var(--graph-k, 1)))', ...(motion ? startAt(motion) : null) }}
                      >
                        {node.label}
                      </text>
                    </g>
                  </>
                ) : !pill ? (
                  // Not drawn: the branches just meet here. Still a target, a little wider than a dot, to hover or choose it.
                  <circle style={{ r: 'calc(6px / var(--graph-k, 1))' }} className="fill-transparent" data-testid={`team-brain-radial-junction-${node.id}`} />
                ) : (
                  // A named folder is a pill with its name inside, lying along its spoke and reaching
                  // outwards from where the folder sits, so the pills fan out from the middle.
                  (() => {
                    const size = node.depth === 1 ? 11 : 10
                    const w = nameWidth(node.label, size, font) + PILL.x * 2
                    const h = size + PILL.y * 2
                    return (
                      <g style={motion ? startAt(motion) : undefined} className={cn(play(motion, 'team-brain-radial-pop'))}>
                      <g transform={`rotate(${flip ? degrees + 180 : degrees})`} data-spoke={node.id} data-flip={flip || undefined} data-testid={`team-brain-radial-pill-${node.id}`}>
                      <g style={{ transform: 'scale(calc(1 / var(--graph-k, 1)))' }}>
                        <rect
                          x={flip ? -w : 0}
                          y={-h / 2}
                          width={w}
                          height={h}
                          rx={h / 2}
                          vectorEffect="non-scaling-stroke"
                          className={cn(
                            'transition-colors',
                            isSelected ? 'fill-foreground stroke-foreground' : 'fill-background',
                            !isSelected && (isHovered ? 'stroke-foreground/40' : faded ? 'stroke-border/40' : 'stroke-border'),
                          )}
                        />
                        <text
                          x={(flip ? -w : w) / 2}
                          textAnchor="middle"
                          dominantBaseline="central"
                          className={cn(
                            'transition-colors',
                            isSelected
                              ? 'fill-background font-medium'
                              : isHovered
                                ? 'fill-foreground'
                                : faded
                                  ? 'fill-muted-foreground/25'
                                  : node.depth === 1
                                    ? 'fill-foreground/75'
                                    : 'fill-muted-foreground',
                          )}
                          style={{ fontSize: `${size}px` }}
                        >
                          {node.label}
                        </text>
                      </g>
                      </g>
                      </g>
                    )
                  })()
                )}
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}


/** How long a light takes to run once round each ring, innermost first, while the drive is read. */
const WAIT_LAPS_MS = [7000, 11000, 15000]

/**
 * What stands in for the tree while the drive is first listed: the tree's own frame and fitted size, the middle's
 * "Team Brain" pill where the tree will grow from, and its three rings drawn faint, a light running slowly round each
 * (alternating ways) so the wait reads as the drive being read rather than an empty page. It fades in only after a
 * moment, so a quick listing never flashes it, and holds still under reduced motion.
 */
export function TeamBrainRadialLoading({ height }: { height: number }) {
  const frameRef = useRef<HTMLDivElement>(null)
  const width = useFrameWidth(frameRef)
  const [font, setFont] = useState('sans-serif')
  useEffect(() => {
    if (frameRef.current) setFont(getComputedStyle(frameRef.current).fontFamily || 'sans-serif')
  }, [])
  const k = width ? fitZoom(width, height) : 1
  const frontWidth = nameWidth('Team Brain', 12, font) + PILL.x * 2
  // The rings where the tree's sections, folders and pages will sit, the sections' kept clear of the pill as the tree keeps them.
  const sectionRing = Math.min(Math.max(SECTION_RING, (frontWidth / 2 + MIDDLE.clearance) / k), 0.6 * RING)
  const rings = [sectionRing, FOLDER_RING, RING].map((r) => r * k)
  const cx = width / 2
  const cy = height / 2
  return (
    <div
      ref={frameRef}
      className="team-brain-radial-fade team-brain-radial-wait-in relative"
      style={{ height }}
      role="status"
      aria-label="Loading Team Brain"
      data-testid="team-brain-radial-loading"
    >
      {width > 0 && (
        <svg width={width} height={height} aria-hidden="true" className="block">
          {rings.map((r, i) => {
            const lap = 2 * Math.PI * r
            return (
              <g key={i}>
                <circle cx={cx} cy={cy} r={r} strokeDasharray="1 6" strokeLinecap="round" className="fill-none stroke-foreground/15" />
                <g
                  className="team-brain-radial-wait"
                  style={{ transformOrigin: `${cx}px ${cy}px`, animationDuration: `${WAIT_LAPS_MS[i]}ms`, animationDirection: i % 2 ? 'reverse' : 'normal' } as CSSProperties}
                >
                  <circle
                    cx={cx}
                    cy={cy}
                    r={r}
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeDasharray={`${lap * 0.12} ${lap}`}
                    className="fill-none stroke-foreground/30"
                  />
                </g>
              </g>
            )
          })}
          <g transform={`translate(${cx} ${cy})`}>
            <rect
              x={-frontWidth / 2}
              y={-MIDDLE.front / 2}
              width={frontWidth}
              height={MIDDLE.front}
              rx={MIDDLE.front / 2}
              className="fill-background stroke-border"
            />
            <text textAnchor="middle" dominantBaseline="central" className="fill-foreground" style={{ fontSize: '12px' }}>
              Team Brain
            </text>
            <text y={MIDDLE.front / 2 + 16} textAnchor="middle" dominantBaseline="central" className="fill-muted-foreground" style={{ fontSize: '11px' }}>
              Reading the drive…
            </text>
          </g>
        </svg>
      )}
    </div>
  )
}
