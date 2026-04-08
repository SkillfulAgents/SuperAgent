import { Eye, EyeOff, Loader2, Lock } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'

// Protocol: see agent-container/src/server.ts
export interface BrowserTabInfo {
  targetId: string
  index: number
  url: string
  title: string
  active: boolean // true = agent's active tab
}

interface BrowserTabBarProps {
  tabs: BrowserTabInfo[]
  viewingTargetId: string | null
  autoFollow: boolean
  loading?: boolean
  onTabClick: (targetId: string) => void
  onCloseTab?: (targetId: string) => void
  onToggleAutoFollow: () => void
}

export function BrowserTabBar({ tabs, viewingTargetId, autoFollow, loading, onTabClick, onCloseTab, onToggleAutoFollow }: BrowserTabBarProps) {
  return (
    <>
    <div className="flex items-center gap-1 px-1 pt-1.5 pb-0.5 overflow-x-auto shrink-0 bg-white dark:bg-muted" style={{ height: 30 }}>
      {tabs.map((tab) => {
        const isViewing = tab.targetId === viewingTargetId
        const isAgentActive = tab.active

        return (
          <ContextMenu key={tab.targetId}>
            <ContextMenuTrigger asChild>
              <button
                className={cn(
                  'relative flex items-center gap-1 px-2 py-1 text-[11px] leading-tight max-w-[200px] truncate transition-colors',
                  isViewing
                    ? 'bg-background text-foreground font-medium rounded-full shadow-sm border border-border/60'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-full',
                )}
                onClick={() => onTabClick(tab.targetId)}
                title={tab.title || tab.url}
              >
                {isAgentActive && (
                  <span className="relative flex items-center justify-center h-3 w-3 shrink-0">
                    {loading && (
                      <span className="absolute inset-0 dual-arc-spinner" />
                    )}
                    <span className={cn(
                      'rounded-full h-1.5 w-1.5 bg-blue-500',
                      !loading && 'animate-pulse'
                    )} />
                  </span>
                )}
                <span className="truncate">{tab.title || tab.url || `Tab ${tab.index + 1}`}</span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                disabled={isAgentActive}
                onClick={() => onCloseTab?.(tab.targetId)}
              >
                Close tab
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
    </div>
    {/* URL bar */}
    {(() => {
      const viewingTab = tabs.find(t => t.targetId === viewingTargetId) ?? tabs.find(t => t.active)
      const url = viewingTab?.url || ''
      const isHttps = url.startsWith('https://')
      return (
        <div className="flex items-center gap-1.5 px-1 mt-0.5 pb-1 bg-background shrink-0" style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
          <div className="flex items-center gap-1.5 flex-1 min-w-0 rounded-full bg-muted/50 px-3 py-0.5" style={{ border: '1px solid rgba(0,0,0,0.06)' }}>
            {isHttps && <Lock className="h-2.5 w-2.5 text-muted-foreground shrink-0" />}
            <span className="text-[11px] text-muted-foreground truncate">{url}</span>
          </div>
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="p-1 rounded-md shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  onClick={onToggleAutoFollow}
                >
                  {autoFollow ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{autoFollow ? 'Auto-follow on' : 'Auto-follow off'}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )
    })()}
    </>
  )
}
