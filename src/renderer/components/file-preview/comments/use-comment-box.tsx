import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useFilePreview, type FileComment } from '@renderer/context/file-preview-context'
import { mediaKeyAction } from '../renderers/use-media-keys'
import { locateAnchor, markerOf, placeMarkers, prepareAnchor, refineAnchor, resolveAnchor, type Placed } from './anchor'
import { CommentOverlay } from './comment-overlay'
import { CommentPin } from './comment-pin'
import type { AnchorKind, AnchorOf, CommentAnchor, CommentSurface } from './kinds'
import type { PointerAt, Situation } from './kinds/types'

interface Pending {
  anchor: CommentAnchor
  /** Where the box opens, in the container's coordinates. */
  rect: DOMRect
  /** Opened with M: the box starts the mic. */
  listen: boolean
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
}

/** Clicks here belong to the box or a marker, not to the file. */
const OWN_UI = '[data-comment-overlay], [data-comment-marker]'

/**
 * Comments on a viewer, from what the viewer offers (`surface`). Owns the C / M keys,
 * clicks on the file, the open comment, its box, and every marker. A `null` surface
 * turns comments off for this viewer.
 */
export function useCommentBox(
  containerRef: RefObject<HTMLElement | null>,
  surface: CommentSurface | null,
  filePath: string,
  agentSlug: string,
): { box: ReactNode; open: (at?: Situation) => void; enabled: boolean; isOpen: boolean } {
  const { commentsEnabled, commentsFor } = useFilePreview()
  const enabled = !!commentsEnabled && surface != null
  const [pending, setPending] = useState<Pending | null>(null)
  const pointer = useRef<PointerAt | null>(null)
  const latest = useRef({ surface, pending })
  useEffect(() => { latest.current = { surface, pending } })

  useEffect(() => {
    if (!enabled) setPending(null)
  }, [enabled])

  /** The box opens at the pointer, or with the mouse elsewhere at the comment's first marker, else the top of the file. */
  const boxRect = useCallback((surface: CommentSurface, anchor: CommentAnchor, at: Situation): DOMRect => {
    const container = containerRef.current?.getBoundingClientRect()
    if (!container) return new DOMRect()
    if (at.on !== 'elsewhere') return new DOMRect(at.clientX - container.left, at.clientY - container.top)
    const site = locateAnchor(surface, anchor, true)[0]
    if (!site) return new DOMRect()
    const host = site.host.getBoundingClientRect()
    return new DOMRect(
      host.left + (site.x / 100) * host.width - container.left,
      host.top + (site.y / 100) * host.height - container.top,
    )
  }, [containerRef])

  /** Opens a comment on the first situation that resolves. */
  const begin = useCallback((tries: Situation[], listen: boolean) => {
    const { surface } = latest.current
    if (!surface) return
    for (const at of tries) {
      const anchor = resolveAnchor(surface, at)
      if (!anchor) continue
      prepareAnchor(surface, anchor)
      setPending({ anchor, rect: boxRect(surface, anchor, at), listen })
      return
    }
  }, [boxRect])

  /** Moves the open comment. A click moves its box with it; a drag leaves the box in place. */
  const refine = useCallback((at: PointerAt, moveBox = false) => {
    const { surface, pending } = latest.current
    if (!surface || !pending) return
    const anchor = refineAnchor(surface, at, pending.anchor)
    if (!anchor) return
    setPending({ ...pending, anchor, rect: moveBox ? boxRect(surface, anchor, at) : pending.rect })
  }, [boxRect])

  /** For a viewer's own "Add Comment" button: opens at `at`, else at the file's default. */
  const open = useCallback((at?: Situation) => {
    if (!latest.current.pending) begin(at ? [at, { on: 'elsewhere' }] : [{ on: 'elsewhere' }], false)
  }, [begin])

  useEffect(() => {
    if (!enabled) return
    const inFile = (target: EventTarget | null): target is Element =>
      target instanceof Element && !!containerRef.current?.contains(target)

    const onClick = (e: MouseEvent) => {
      if (!inFile(e.target) || e.target.closest(OWN_UI)) return
      const at: PointerAt = { on: 'click', target: e.target, clientX: e.clientX, clientY: e.clientY }
      if (latest.current.pending) refine(at, true)
      else begin([at], false)
    }
    const onPointerMove = (e: PointerEvent | MouseEvent) => {
      pointer.current = inFile(e.target) ? { on: 'mouse', target: e.target, clientX: e.clientX, clientY: e.clientY } : null
    }
    // Leaving the window fires no move outside the file.
    const onPointerOut = (e: PointerEvent | MouseEvent) => {
      if (!e.relatedTarget) pointer.current = null
    }
    const onKeyDown = (e: KeyboardEvent) => {
      // Escape closes an open box from anywhere a field does not own the key. The box's own field handles it there.
      if (e.key === 'Escape' && latest.current.pending && !e.defaultPrevented && !isTyping(e.target)) {
        setPending(null)
        return
      }
      const action = mediaKeyAction(e)
      if (action?.type !== 'comment' || latest.current.pending) return
      e.preventDefault()
      // Holding the key opens once.
      if (e.repeat) return
      begin(pointer.current ? [pointer.current, { on: 'elsewhere' }] : [{ on: 'elsewhere' }], action.listen)
    }
    window.addEventListener('click', onClick)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerout', onPointerOut)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('click', onClick)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerout', onPointerOut)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [enabled, containerRef, begin, refine])

  const comments = commentsFor(filePath, agentSlug)
  const box = enabled && surface && (
    <>
      <CommentMarkers surface={surface} comments={comments} pending={pending} refine={refine} />
      {pending && (
        <CommentOverlay
          anchor={pending.anchor}
          rect={pending.rect}
          filePath={filePath}
          agentSlug={agentSlug}
          autoEdit
          autoListen={pending.listen}
          onClose={() => setPending(null)}
        />
      )}
    </>
  )

  return { box, open, enabled, isOpen: pending != null }
}

/** The same markers at the same places: nothing to redraw. */
function samePlaces(a: Placed[], b: Placed[]): boolean {
  return a.length === b.length && a.every((p, i) =>
    p.site.host === b[i].site.host && p.site.x === b[i].site.x && p.site.y === b[i].site.y
    && p.anchor === b[i].anchor && p.isOpen === b[i].isOpen && p.numbers.join() === b[i].numbers.join())
}

/** Asks each comment's kind where its markers go, after the viewer has drawn, and draws them there. */
function CommentMarkers({ surface, comments, pending, refine }: {
  surface: CommentSurface
  comments: FileComment[]
  pending: Pending | null
  refine: (at: PointerAt) => void
}) {
  const [placed, setPlaced] = useState<Placed[]>([])

  // After every render: hosts move with the viewer (the playhead, a loaded grid). samePlaces stops the loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const next = placeMarkers(surface, comments.map(c => c.anchor), pending?.anchor ?? null)
    setPlaced(prev => (samePlaces(prev, next) ? prev : next))
  })

  return placed.map(p => createPortal(markerFor(p.anchor.kind, p.anchor, surface, p, refine), p.site.host, p.key))
}

/** The kind's own marker, or the shared numbered pin. */
function markerFor<K extends AnchorKind>(kind: K, anchor: AnchorOf<K>, surface: CommentSurface, p: Placed, refine: (at: PointerAt) => void): ReactNode {
  const own = markerOf(kind, surface)
  if (!own) return <CommentPin x={p.site.x} y={p.site.y} number={p.numbers[0]} />
  const { Marker, slice } = own
  return <Marker slice={slice} anchor={anchor} site={p.site} numbers={p.numbers} isOpen={p.isOpen} refine={refine} />
}
