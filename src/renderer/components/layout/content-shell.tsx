import { createContext, useContext, useState } from 'react'
import { createPortal } from 'react-dom'
import { SidebarTrigger } from '@renderer/components/ui/sidebar'
import { Separator } from '@renderer/components/ui/separator'
import { isElectron } from '@renderer/lib/env'
import { cn } from '@shared/lib/utils/cn'
import { ScrollAwareTitleProvider } from './scroll-aware-title'

const BackdropSlot = createContext<HTMLElement | null>(null)

/**
 * Paints its children behind the whole shell, header included, so the header's
 * glass picks them up: Agent Home's and a session's halftone background. Children fill the
 * slot (`absolute inset-0`). Nothing outside a ContentShell.
 */
export function ContentBackdrop({ children }: { children: React.ReactNode }) {
  const slot = useContext(BackdropSlot)
  return slot ? createPortal(children, slot) : null
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
  return (
    <ScrollAwareTitleProvider>
      {/* Its own stacking context, so the backdrop below the header and view stays above the page. */}
      <div className="relative isolate h-full flex flex-col" data-testid="main-content">
        <div ref={setBackdropSlot} className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" />
        <header
          className={cn(
            // Glass on the page canvas: over a backdrop it lets the colour through, elsewhere it reads as the canvas.
            'shrink-0 flex min-h-12 py-1.5 md:py-0 md:h-12 items-center gap-2 border-b bg-background/50 backdrop-blur-xl backdrop-saturate-150 pl-4 pr-2',
            isElectron() && 'app-drag-region',
          )}
        >
          <SidebarTrigger className={`app-no-drag ${needsTrafficLightPadding ? 'ml-16' : '-ml-1'}`} />
          <Separator orientation="vertical" className="h-5 hidden md:block" />
          {headerContent}
        </header>
        <BackdropSlot.Provider value={backdropSlot}>{children}</BackdropSlot.Provider>
      </div>
    </ScrollAwareTitleProvider>
  )
}
