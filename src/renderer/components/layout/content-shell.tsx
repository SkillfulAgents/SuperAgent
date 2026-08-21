import { SidebarTrigger } from '@renderer/components/ui/sidebar'
import { Separator } from '@renderer/components/ui/separator'
import { isElectron } from '@renderer/lib/env'

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
  return (
    <div className="h-full flex flex-col" data-testid="main-content">
      <header
        className={`shrink-0 flex min-h-12 py-1.5 md:py-0 md:h-12 items-center gap-2 border-b bg-background pl-4 pr-2 ${isElectron() ? 'app-drag-region' : ''}`}
      >
        <SidebarTrigger className={`app-no-drag ${needsTrafficLightPadding ? 'ml-16' : '-ml-1'}`} />
        <Separator orientation="vertical" className="h-5 hidden md:block" />
        {headerContent}
      </header>
      {children}
    </div>
  )
}
