import { ANCHOR_KINDS, type AnchorKind, type AnchorOf, type CellRef, type CommentAnchor, type CommentSurface, type SurfaceOf } from './kinds'
import type { AnchorKindSpec, PointerAt, Site, Situation } from './kinds/types'

const SPECS: { [K in AnchorKind]: AnchorKindSpec<AnchorOf<K>, SurfaceOf<K>> } = ANCHOR_KINDS

function isKind(key: string): key is AnchorKind {
  return key in SPECS
}

/** Kinds in resolution order. */
const KINDS = Object.keys(SPECS).filter(isKind)

function specOf<K extends AnchorKind>(kind: K): AnchorKindSpec<AnchorOf<K>, SurfaceOf<K>> {
  return SPECS[kind]
}

/** The kind's piece of the surface: what the viewer declared under its name, else its default. */
function sliceOf<K extends AnchorKind>(surface: CommentSurface, kind: K): SurfaceOf<K> | undefined {
  return surface[kind] ?? specOf(kind).defaultSurface
}

function resolveAs<K extends AnchorKind>(kind: K, surface: CommentSurface, at: Situation): CommentAnchor | null {
  const spec = specOf(kind)
  const slice = sliceOf(surface, kind)
  if (slice === undefined) return null
  const anchor = at.on === 'click' ? spec.fromClick?.(slice, at)
    : at.on === 'mouse' ? spec.fromMouse?.(slice, at)
      : spec.fromElsewhere?.(slice)
  return anchor ?? null
}

/** The anchor this situation points at: the first kind the surface turns on that resolves it. */
export function resolveAnchor(surface: CommentSurface, at: Situation): CommentAnchor | null {
  for (const kind of KINDS) {
    const anchor = resolveAs(kind, surface, at)
    if (anchor) return anchor
  }
  return null
}

/** The open comment moved by a click or a drag, through its own kind, or null when the kind ignores it. */
export function refineAnchor<K extends AnchorKind>(surface: CommentSurface, at: PointerAt, open: AnchorOf<K> & { kind: K }): CommentAnchor | null {
  const slice = sliceOf(surface, open.kind)
  return slice === undefined ? null : specOf(open.kind).fromClick?.(slice, at, open) ?? null
}

/** The one description of an anchor, for the comment box, the list row, and the agent text. */
export function describeAnchor<K extends AnchorKind>(anchor: AnchorOf<K> & { kind: K }): string {
  return specOf(anchor.kind).describe(anchor)
}

/** Where an anchor's markers go in the file. */
export function locateAnchor<K extends AnchorKind>(surface: CommentSurface, anchor: AnchorOf<K> & { kind: K }, isOpen: boolean): Site[] {
  const slice = sliceOf(surface, anchor.kind)
  return slice === undefined ? [] : specOf(anchor.kind).locate?.(slice, anchor, isOpen) ?? []
}

/** Runs the kind's step before its box opens, such as pausing the player. */
export function prepareAnchor<K extends AnchorKind>(surface: CommentSurface, anchor: AnchorOf<K> & { kind: K }): void {
  const slice = sliceOf(surface, anchor.kind)
  if (slice !== undefined) specOf(anchor.kind).prepare?.(slice)
}

export function markerOf<K extends AnchorKind>(kind: K, surface: CommentSurface) {
  const slice = sliceOf(surface, kind)
  const Marker = specOf(kind).Marker
  return slice === undefined || !Marker ? null : { Marker, slice }
}

export interface Placed {
  key: string
  site: Site
  anchor: CommentAnchor
  numbers: number[]
  isOpen: boolean
}

/** Every marker to draw: each comment's sites from its kind, numbered in file order. Kinds that group share a marker per site. */
export function placeMarkers(surface: CommentSurface, comments: CommentAnchor[], open: CommentAnchor | null): Placed[] {
  const all = comments.map((anchor, i) => ({ anchor, number: i + 1, isOpen: false }))
  if (open) all.push({ anchor: open, number: comments.length + 1, isOpen: true })
  const placed: Placed[] = []
  for (const { anchor, number, isOpen } of all) {
    locateAnchor(surface, anchor, isOpen).forEach((site, i) => {
      const shared = !isOpen && specOf(anchor.kind).group && placed.find(p => !p.isOpen && p.anchor.kind === anchor.kind
        && p.site.host === site.host && p.site.x === site.x && p.site.y === site.y)
      if (shared) shared.numbers.push(number)
      else placed.push({ key: `${number}-${i}`, site, anchor, numbers: [number], isOpen })
    })
  }
  return placed
}

/** What a viewer hands the comment box today, before viewers produce anchors themselves. */
export interface PendingSelection {
  text: string
  x?: number
  y?: number
  cell?: CellRef
  /** Playback position in seconds, set for audio/video comments. */
  timestamp?: number
}

/** The anchor a viewer's pending selection describes. */
export function selectionToAnchor({ text, x, y, cell, timestamp }: PendingSelection): CommentAnchor {
  if (cell) return { kind: 'cell', cell }
  if (text) return { kind: 'text', quote: text }
  const point = x != null && y != null ? { x, y } : undefined
  if (timestamp != null) return { kind: 'time', seconds: timestamp, point }
  if (point) return { kind: 'point', ...point }
  return { kind: 'file' }
}
