import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { DisplacedDotField } from '@renderer/components/ui/displaced-dot-field'
import { FOLDER_FADE_SHARE, TeamBrainDiagram } from './team-brain-diagram'

/**
 * The website hero's fade for the dot grid: in from nothing at the top, full
 * strength through the middle, then out again over the same stretch as the
 * folder block's fade, so both are gone together just above the headline.
 */
function dotFade(fadeStart: number, end: number) {
  const solid = Math.min(end * 0.45, fadeStart)
  return `linear-gradient(to bottom, transparent 0px, rgba(0,0,0,0.35) ${end * 0.18}px, #000 ${solid}px, #000 ${fadeStart}px, transparent ${end}px)`
}

/**
 * The page before anyone has opted in. One calm screen: the picture, a line
 * on what it is, one button. Someone arriving from the sidebar should get it
 * at a glance and know what they are turning on. Without `onStart` (a
 * member, not an admin) it says to ask an admin.
 */
export function TeamBrainIntro({ onStart }: { onStart?: () => void }) {
  // Where the picture ends and its folder fade begins, in the scrolling page's coordinates.
  const pictureRef = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState<{ start: number; end: number } | null>(null)
  useLayoutEffect(() => {
    const picture = pictureRef.current
    const section = picture?.parentElement
    if (!picture || !section) return
    const measure = () => {
      const end = section.offsetTop + picture.offsetTop + picture.offsetHeight
      const next = { start: end - picture.offsetHeight * FOLDER_FADE_SHARE, end }
      setFade((previous) => (previous?.start === next.start && previous.end === next.end ? previous : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(section)
    return () => observer.disconnect()
  }, [])
  const mask = fade ? dotFade(fade.start, fade.end) : undefined

  return (
    <div className="relative flex-1 overflow-auto bg-[#fbfbfb] dark:bg-background">
      {/* The website hero's dot grid: the cursor pushes through it, a click on the background ripples it. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0"
        style={{ height: fade?.end ?? '100%', maskImage: mask, WebkitMaskImage: mask }}
      >
        <DisplacedDotField intro />
      </div>
      <section
        className="relative mx-auto flex min-h-full w-full max-w-[960px] flex-col items-center justify-center px-6 py-12 text-center"
        data-testid="team-brain-intro"
      >
        <div ref={pictureRef} className="w-full">
          <TeamBrainDiagram />
        </div>

        {/* Tucked up into the folder block's faded tail, just clear of its last row. */}
        <h1 className="-mt-1 text-[26px] font-normal leading-[1.15] tracking-tight md:text-[30px]">
          <span className="block">One source of truth for every agent.</span>
          <span className="block text-muted-foreground">Organized and maintained autonomously.</span>
        </h1>
        <p className="mt-5 max-w-xl text-sm text-muted-foreground md:text-base">
          Team Brain syncs essential context from your tools and agents into a shared file system. Your agents do better
          work, faster, with less input from you.
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          {onStart ? (
            <Button size="lg" onClick={onStart} data-testid="team-brain-start" className="bg-brand text-white shadow-md hover:bg-brand/90">
              Set up Team Brain
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="team-brain-ask-admin">Ask an admin to set up Team Brain.</p>
          )}
        </div>
      </section>
    </div>
  )
}
