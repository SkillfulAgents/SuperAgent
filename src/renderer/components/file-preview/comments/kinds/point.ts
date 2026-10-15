import type { RefObject } from 'react'
import { percentIn, type AnchorKindSpec, type PointerAt } from './types'

/** A position as percentages of the image or frame. */
export interface Point {
  x: number
  y: number
}
export type PointAnchor = { kind: 'point' } & Point
/** The element a point is measured against, and its pins sit inside. */
export type PointSurface = RefObject<HTMLElement | null>

export function describePoint({ x, y }: Point): string {
  return `position (${Math.round(x)}%, ${Math.round(y)}%)`
}

function pointUnder(el: PointSurface, at: PointerAt): PointAnchor | null {
  const host = el.current
  if (!host?.contains(at.target)) return null
  return { kind: 'point', ...percentIn(host.getBoundingClientRect(), at.clientX, at.clientY) }
}

export const pointKind: AnchorKindSpec<PointAnchor, PointSurface> = {
  fromClick: pointUnder,
  fromMouse: pointUnder,
  fromElsewhere: () => ({ kind: 'point', x: 50, y: 50 }),
  describe: (anchor) => `At ${describePoint(anchor)}`,
  locate: (el, { x, y }) => (el.current ? [{ host: el.current, x, y }] : []),
}
