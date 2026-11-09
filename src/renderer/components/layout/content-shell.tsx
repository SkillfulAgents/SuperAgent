import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { SidebarTrigger } from '@renderer/components/ui/sidebar'
import { Separator } from '@renderer/components/ui/separator'
import { isElectron } from '@renderer/lib/env'
import { cn } from '@shared/lib/utils/cn'
import { ScrollAwareTitleProvider } from './scroll-aware-title'

const BackdropSlot = createContext<{ slot: HTMLElement | null; mount: () => () => void } | null>(null)

/**
 * Paints its children behind the whole shell, header included, so the header's
 * glass picks them up: Agent Home's halftone background. Children fill the
 * slot (`absolute inset-0`). Nothing outside a ContentShell.
 */
export function ContentBackdrop({ children }: { children: React.ReactNode }) {
  const backdrop = useContext(BackdropSlot)
  const mount = backdrop?.mount
  useEffect(() => mount?.(), [mount])
  return backdrop?.slot ? createPortal(children, backdrop.slot) : null
}

/**
 * The header + body frame shared by the agent view and the notifications route.
 */
export function ContentShell({
  needsTrafficLightPadding,
  headerContent,
  children,
}: {
  needsTrafficLightPadding: boolean
  headerContent: React.ReactNode
  children: React.ReactNode
}) {
  const [backdropSlot, setBackdropSlot] = useState<HTMLElement | null>(null)
  const [backdrops, setBackdrops] = useState(0)
  const mount = useCallback(() => {
    setBackdrops(count => count + 1)
    return () => setBackdrops(count => count - 1)
  }, [])
  const backdrop = useMemo(() => ({ slot: backdropSlot, mount }), [backdropSlot, mount])
  // Glass only over a backdrop: over the plain canvas it shows nothing, yet a
  // backdrop-filter still re-samples whatever is behind it on every frame.
  const glass = backdrops > 0
  return (
    <ScrollAwareTitleProvider>
      {/* Its own stacking context, so the backdrop below the header and view stays above the page. */}
      <div className="relative isolate h-full flex flex-col" data-testid="main-content" data-backdrop={glass ? '' : undefined}>
        <div ref={setBackdropSlot} className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" />
        <header
          className={cn(
            'shrink-0 flex min-h-12 py-1.5 md:py-0 md:h-12 items-center gap-2 border-b pl-4 pr-2',
            glass ? 'bg-background/50 backdrop-blur-xl backdrop-saturate-150' : 'bg-background',
            isElectron() && 'app-drag-region',
          )}
        >
          <SidebarTrigger className={`app-no-drag ${needsTrafficLightPadding ? 'ml-16' : '-ml-1'}`} />
          <Separator orientation="vertical" className="h-5 hidden md:block" />
          {headerContent}
        </header>
        <BackdropSlot.Provider value={backdrop}>{children}</BackdropSlot.Provider>
      </div>
    </ScrollAwareTitleProvider>
  )
}
