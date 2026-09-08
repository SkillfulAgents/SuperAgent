import { useLayoutEffect, useRef, useState } from 'react'

function parseAspect(ratio: string): number {
  const [width, height] = ratio.split('/').map(Number)
  const aspect = width / height
  return Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9
}

/** Fit the whole browser card, including its toolbar and any input request, in the rail. */
export function useBrowserCardSize(fullScreen: boolean, aspectRatio: string) {
  const railRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ card: number; strip: number } | null>(null)
  const aspect = parseAspect(aspectRatio)

  useLayoutEffect(() => {
    if (!fullScreen) {
      setSize(null)
      return
    }
    const rail = railRef.current
    const card = cardRef.current
    const viewport = viewportRef.current
    if (!rail || !card || !viewport) return
    const measure = () => {
      const padding = getComputedStyle(rail)
      const pixels = (value: string) => parseFloat(value) || 0
      const chrome = card.offsetHeight - viewport.offsetHeight
      const available = rail.clientHeight - pixels(padding.paddingTop) - pixels(padding.paddingBottom) - chrome
      const cardWidth = Math.max(1, Math.floor(available * aspect))
      const stripWidth = cardWidth + pixels(padding.paddingLeft) + pixels(padding.paddingRight)
      setSize((previous) =>
        previous?.card === cardWidth && previous.strip === stripWidth
          ? previous
          : { card: cardWidth, strip: stripWidth },
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(rail)
    // Input-request messages and errors can change the toolbar/action area's height.
    observer.observe(card)
    return () => observer.disconnect()
  }, [fullScreen, aspect])

  return { railRef, cardRef, viewportRef, maxCardWidth: size?.card, maxStripWidth: size?.strip }
}
