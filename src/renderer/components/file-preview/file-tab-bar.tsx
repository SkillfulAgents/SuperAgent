import { Folder, X } from 'lucide-react'
import { FileTypeIcon } from '@renderer/components/ui/file-type-icon'
import { cn } from '@shared/lib/utils/cn'
import { getPreviewTabKey, type PreviewTab } from '@renderer/context/file-preview-context'

interface FileTabBarProps {
  tabs: PreviewTab[]
  activeIndex: number
  onTabClick: (index: number) => void
  onCloseTab: (tabKey: string) => void
}

export function FileTabBar({ tabs, activeIndex, onTabClick, onCloseTab }: FileTabBarProps) {
  if (tabs.length === 0) return null

  return (
    <div className="flex items-center gap-0 border-b border-border/40 shrink-0 overflow-x-auto scrollbar-none" data-testid="file-tab-bar">
      {tabs.map((tab, index) => (
        <button
          key={getPreviewTabKey(tab)}
          type="button"
          onClick={() => onTabClick(index)}
          data-testid="file-tab"
          data-tab-kind={tab.kind}
          data-file-name={tab.displayName}
          data-path={tab.kind === 'file' ? tab.filePath : tab.rootPath}
          className={cn(
            'group flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-border/30 shrink-0 max-w-[160px] transition-colors',
            index === activeIndex
              ? 'bg-background text-foreground border-b-2 border-b-primary'
              : 'bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground'
          )}
        >
          {tab.kind === 'folder' ? (
            <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <FileTypeIcon filename={tab.displayName} size={14} />
          )}
          <span className="truncate">{tab.displayName}</span>
          <span
            role="button"
            tabIndex={0}
            data-testid="file-tab-close"
            data-file-name={tab.displayName}
            data-path={tab.kind === 'file' ? tab.filePath : tab.rootPath}
            onClick={(e) => {
              e.stopPropagation()
              onCloseTab(getPreviewTabKey(tab))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                e.preventDefault()
                onCloseTab(getPreviewTabKey(tab))
              }
            }}
            className="ml-auto p-0.5 rounded hover:bg-muted-foreground/20 opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity"
          >
            <X className="h-3 w-3" />
          </span>
        </button>
      ))}
    </div>
  )
}
