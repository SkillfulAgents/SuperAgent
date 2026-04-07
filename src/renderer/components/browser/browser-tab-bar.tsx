import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
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
    <div className="flex items-center gap-0.5 px-1.5 py-1 bg-muted/30 border-b overflow-x-auto shrink-0" style={{ height: 30 }}>
      {tabs.map((tab) => {
        const isViewing = tab.targetId === viewingTargetId
        const isAgentActive = tab.active

        return (
          <ContextMenu key={tab.targetId}>
            <ContextMenuTrigger asChild>
              <button
                className={cn(
                  'relative flex items-center gap-1 px-2 py-1 rounded text-[11px] leading-tight max-w-[120px] truncate transition-colors',
                  isViewing ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                )}
                onClick={() => onTabClick(tab.targetId)}
                title={tab.title || tab.url}
              >
                <span className="truncate">{tab.title || tab.url || `Tab ${tab.index + 1}`}</span>
                {isAgentActive && (
                  <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                )}
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
      {loading && (
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0 ml-auto" />
      )}
      <button
        className={cn(
          loading ? '' : 'ml-auto',
          'p-0.5 rounded transition-colors shrink-0',
          autoFollow ? 'text-blue-500 hover:text-blue-600' : 'text-muted-foreground hover:text-foreground'
        )}
        onClick={onToggleAutoFollow}
        title={autoFollow ? 'Auto-following agent (click to pin)' : 'Not following agent (click to follow)'}
      >
        {autoFollow ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
      </button>
    </div>
  )
}
