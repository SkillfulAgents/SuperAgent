import { useLayoutEffect, useState, type RefObject } from 'react'
import type { TeamBrainNode } from '@renderer/lib/team-brain/team-brain-structure'

/** What the home page's tree and sync summaries share. */

/** Open a page of the drive in the file drawer. */
export type OpenFile = (file: TeamBrainNode, at: { path: string; folder?: TeamBrainNode }) => void

/** A press that moves less than this many pixels is a click, not a drag. */
export const CLICK_SLOP = 4

export const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

/** The width of the box the tree sits in; its height is fixed. */
export function useFrameWidth(frame: RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = frame.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [frame])
  return width
}
