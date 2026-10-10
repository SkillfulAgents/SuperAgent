import type { ComponentType } from 'react'

export interface PointerAt {
  on: 'click' | 'mouse'
  target: Element
  clientX: number
  clientY: number
}

/** What just happened: a click, a key over the file, or a key with the mouse elsewhere. */
export type Situation = PointerAt | { on: 'elsewhere' }

/** Where a marker goes: a position inside `host`, in percent. */
export interface Site {
  host: Element
  x: number
  y: number
}

export interface MarkerProps<A, S> {
  slice: S
  anchor: A
  site: Site
  /** 1-based numbers of the comments drawn at this site. */
  numbers: number[]
  isOpen: boolean
  /** Moves the open comment, keeping its typed text. */
  refine: (at: PointerAt) => void
}

/**
 * Everything one kind of anchor owns. `S` is the piece of the viewer's surface this
 * kind reads, declared by the viewer under the kind's name. Shared code reads kinds
 * only through this.
 */
export interface AnchorKindSpec<A, S = undefined> {
  /** The slice used when the viewer declares none. Set for kinds that are always on. */
  defaultSurface?: S
  /** Receives the open comment's anchor when refining it, and keeps what it locked. */
  fromClick?: (slice: S, at: PointerAt, open?: A) => A | null
  fromMouse?: (slice: S, at: PointerAt) => A | null
  fromElsewhere?: (slice: S) => A | null
  /** Runs once, right before a box opens on this kind. */
  prepare?: (slice: S) => void
  describe: (anchor: A) => string
  locate?: (slice: S, anchor: A, isOpen: boolean) => Site[]
  /** Saved comments on the same site share one marker. */
  group?: boolean
  /** Draws this kind's markers. Default: the shared numbered pin. */
  Marker?: ComponentType<MarkerProps<A, S>>
}

/** A pointer position as percentages of `rect`, clamped to it. */
export function percentIn(rect: DOMRect, clientX: number, clientY: number): { x: number; y: number } {
  const clamp = (v: number) => Math.min(100, Math.max(0, v))
  return {
    x: rect.width > 0 ? clamp(((clientX - rect.left) / rect.width) * 100) : 50,
    y: rect.height > 0 ? clamp(((clientY - rect.top) / rect.height) * 100) : 50,
  }
}
