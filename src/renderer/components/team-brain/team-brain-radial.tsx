import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { polar, radialTree, type RadialNode } from '@renderer/lib/team-brain/team-brain-radial'
import type { TeamBrainNode } from '@renderer/lib/team-brain/team-brain-structure'
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

/**
 * One colour per section, for its pages (and the signal racing out to them
 * as the tree opens), as the reference's file types are coloured. The README,
 * Team Brain's own page, is in the foreground colour. Drawn as `currentColor`.
 */
const SECTION_COLOR: Record<string, string> = {
  readme: 'text-foreground',
  company: 'text-sky-500',
  people: 'text-teal-500',
  customers: 'text-orange-500',
  sales: 'text-amber-500',
  marketing: 'text-pink-500',
  brand: 'text-rose-500',
  product: 'text-violet-500',
  engineering: 'text-blue-500',
  meetings: 'text-emerald-500',
}
const sectionColor = (node: RadialNode) => SECTION_COLOR[node.section ?? ''] ?? 'text-muted-foreground'

type Drag = { x: number; y: number; from: { x: number; y: number; k: number }; target: RadialNode | null; moved: boolean }

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
export function TeamBrainRadial({ drive, onOpenFile, height }: { drive: readonly TeamBrainNode[]; onOpenFile: OpenFile; height: number }) {
  const nodes = useMemo(() => radialTree(drive, { sectionGap: SECTION_GAP }), [drive])
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const depth = useMemo(() => Math.max(...nodes.map((n) => n.depth)), [nodes])
  // Sections ring the middle closely, their names running outwards; deeper folders spread out towards the pages.
  const radius = useCallback(
    (n: RadialNode) =>
      n.kind === 'file' ? RING : n.depth === 0 ? 0 : SECTION_RING + ((FOLDER_RING - SECTION_RING) * (n.depth - 1)) / Math.max(depth - 2, 1),
    [depth],
  )
  const frameRef = useRef<HTMLDivElement>(null)
  const width = useFrameWidth(frameRef)
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
  /** The zoom, for sizing folder pills to stay one size on screen. */
  const [zoomK, setZoomK] = useState(1)
  const [font, setFont] = useState('sans-serif')
  useEffect(() => {
    if (svgRef.current) setFont(getComputedStyle(svgRef.current).fontFamily || 'sans-serif')
  }, [])
  const [selected, setSelected] = useState<string | null>(null)
  /** How far the whole tree is turned, so a chosen folder sits at three o'clock. */
  const [turn, setTurn] = useState(0)
  const turnRef = useRef(0)
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
    const speed = (RING - SECTION_RING) / ENTRY.signalMs
    const at = new Map<string, number>()
    for (const node of nodes) {
      const parent = node.parent ? byId.get(node.parent) : undefined
      if (!parent) continue
      // Nothing is drawn from the middle: the signal lights the sections in turn, and a page sitting
      // straight off the middle (the README) is reached as if it had a section of its own.
      at.set(
        node.id,
        parent.kind === 'root'
          ? ENTRY.sweepMs * (node.angle / TAU) + (radius(node) - SECTION_RING) / speed
          : at.get(parent.id)! + (radius(node) - radius(parent)) / speed,
      )
    }
    return at
  }, [nodes, byId, radius])
  const [entering, setEntering] = useState(() => !prefersReducedMotion())
  /** The opening's turn and zoom into place, which runs off the animation frames rather than the clock. A touch ends it early. */
  const [settling, setSettling] = useState(entering)
  const entryMs = useMemo(() => Math.max(ENTRY.settleMs, ...[...arrivals.values()].map((t) => t + ENTRY.nameAfterMs + ENTRY.nameMs)), [arrivals])
  useEffect(() => {
    if (!entering) return
    const done = setTimeout(() => setEntering(false), entryMs)
    return () => clearTimeout(done)
  }, [entering, entryMs])
  /** Where a node's opening animations start, for the CSS in `globals.css`. */
  const arriveAt = (id: string) => ({ '--arrive-at': `${Math.round(arrivals.get(id) ?? 0)}ms` }) as CSSProperties

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
    viewRef.current?.setAttribute('transform', `translate(${x} ${y}) scale(${k})`)
    // Names divide by this so they stay one size on screen at any zoom.
    svgRef.current?.style.setProperty('--graph-k', String(k))
    setZoomedIn(k >= fittedZoom.current * NAME_DEEP_AT)
    setZoomK(k)
  }, [])

  /** The whole tree, centred, with room for the page names around it and clear of the faded edges. */
  const fittedView = useCallback((): View => {
    const k = clampZoom((Math.min(width, height) / 2 - NAME_ROOM - EDGE_FADE) / RING)
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
        setTurn(turnRef.current)
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
        else onDone?.()
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
      setTurn(turnRef.current)
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
  }, [])

  const start = (event: ReactPointerEvent, target: RadialNode | null) => {
    if (event.button !== 0) return
    event.stopPropagation()
    // Taking hold stops any turn or zoom in progress, right where it is.
    cancelAnimationFrame(turning.current)
    setSettling(false)
    lastTouch.current = performance.now()
    moveEndsAt.current = 0
    drag.current = { x: event.clientX, y: event.clientY, from: { ...view.current }, target, moved: false }
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
    swallowClick.current = !!d && (d.moved || !!d.target?.file)
    if (!d || d.moved) return
    const target = d.target
    if (target?.file) return onOpenFile(target.file.node, { path: target.file.path, folder: target.file.folder })
    if (target?.kind === 'folder') {
      setSelected(target.id)
      const turned = THREE_OCLOCK - target.angle
      return moveTo(turned, branchView(target, turned))
    }
    // Clicking out: back to the whole tree, centred and turned back.
    setSelected(null)
    moveTo(0, fittedView())
  }

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
              const grow = entering
                ? {
                    pathLength: 1,
                    style: {
                      '--grow-at': `${Math.round(arrivals.get(parent.id) ?? 0)}ms`,
                      '--grow-ms': `${Math.round((arrivals.get(node.id) ?? 0) - (arrivals.get(parent.id) ?? 0))}ms`,
                      '--head': Math.min(0.4, 16 / Math.max(Math.hypot(...Object.values(polar(0, radius(node) - radius(parent)))), 1)),
                    } as CSSProperties,
                  }
                : null
              return (
                <g key={node.id}>
                  <path
                    d={d}
                    vectorEffect={grow ? undefined : 'non-scaling-stroke'}
                    strokeWidth={(lit ? 1.25 : 1) / (grow ? fittedZoom.current : 1)}
                    strokeOpacity={lit ? 0.4 : focus ? 0.03 : 0.1}
                    className={cn('pointer-events-none stroke-foreground transition-[stroke-opacity]', grow && 'team-brain-radial-grow')}
                    {...grow}
                  />
                  {grow && (
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
              const speed = (RING - SECTION_RING) / PULSE.signalMs
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
                        strokeWidth={1.75 / zoomK}
                        strokeLinecap="round"
                        className="team-brain-radial-impulse stroke-current"
                        style={
                          {
                            '--grow-at': `${Math.round((radius(parent) - SECTION_RING) / speed)}ms`,
                            '--grow-ms': `${Math.round(length / speed)}ms`,
                            '--head': Math.min(0.4, 16 / Math.max(length, 1)),
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
            if (node.kind === 'root') return null
            const angle = angleOf(node)
            const p = polar(angle, radius(node))
            const page = node.kind === 'file'
            const r = page ? 4 : node.depth === 1 ? 3.5 : 2.5
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
                    {entering && <circle r={r} style={arriveAt(node.id)} className={cn('team-brain-radial-bloom pointer-events-none fill-current', sectionColor(node))} />}
                    <circle
                      r={isHovered ? r * 1.5 : r}
                      style={entering ? arriveAt(node.id) : undefined}
                      className={cn('fill-current transition-[r]', sectionColor(node), entering && 'team-brain-radial-pop')}
                    />
                    {/* A hovered page's name grows a little, clear of its grown dot. Name and dot both take the click. */}
                    <text
                      transform={`rotate(${flip ? degrees + 180 : degrees})`}
                      x={(flip ? -1 : 1) * ((isHovered ? r * 1.5 : r) + 5)}
                      textAnchor={flip ? 'end' : 'start'}
                      dominantBaseline="central"
                      className={cn(
                        'transition-[font-size] duration-150 ease-out',
                        isHovered ? 'fill-foreground font-medium' : focus?.has(node.id) ? 'fill-foreground/80' : 'fill-muted-foreground/70',
                        entering && 'team-brain-radial-name',
                      )}
                      style={{ fontSize: `calc(${isHovered ? 11.5 : 9.5}px / var(--graph-k, 1))`, ...(entering ? arriveAt(node.id) : null) }}
                    >
                      {node.label}
                    </text>
                  </>
                ) : !pill ? (
                  // Not drawn: the branches just meet here. Still a target, a little wider than a dot, to hover or choose it.
                  <circle r={6 / zoomK} className="fill-transparent" data-testid={`team-brain-radial-junction-${node.id}`} />
                ) : (
                  // A named folder is a pill with its name inside, lying along its spoke and reaching
                  // outwards from where the folder sits, so the pills fan out from the middle.
                  (() => {
                    const size = node.depth === 1 ? 11 : 10
                    const w = (nameWidth(node.label, size, font) + PILL.x * 2) / zoomK
                    const h = (size + PILL.y * 2) / zoomK
                    return (
                      <g style={entering ? arriveAt(node.id) : undefined} className={cn(entering && 'team-brain-radial-pop')}>
                      <g transform={`rotate(${flip ? degrees + 180 : degrees})`} data-testid={`team-brain-radial-pill-${node.id}`}>
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
                          style={{ fontSize: `calc(${size}px / var(--graph-k, 1))` }}
                        >
                          {node.label}
                        </text>
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

