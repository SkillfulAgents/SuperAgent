import { X } from 'lucide-react'
import { FileTypeIcon } from '@renderer/components/ui/file-type-icon'
import { cn } from '@shared/lib/utils/cn'
import type { FileTab } from '@renderer/context/file-preview-context'

interface FileTabBarProps {
  files: FileTab[]
  activeIndex: number
  onTabClick: (index: number) => void
  onCloseTab: (filePath: string) => void
}

export function FileTabBar({ files, activeIndex, onTabClick, onCloseTab }: FileTabBarProps) {
  if (files.length === 0) return null

  return (
    <div className="flex items-center gap-0 border-b border-border/40 shrink-0 overflow-x-auto scrollbar-none" data-testid="file-tab-bar">
      {files.map((file, index) => (
        <button
          key={file.filePath}
          onClick={() => onTabClick(index)}
          data-testid="file-tab"
          data-file-name={file.displayName}
          data-file-path={file.filePath}
          className={cn(
            'group flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-border/30 shrink-0 max-w-[160px] transition-colors',
            index === activeIndex
              ? 'bg-background text-foreground border-b-2 border-b-primary'
              : 'bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground'
          )}
        >
          <FileTypeIcon filename={file.displayName} size={14} />
          <span className="truncate">{file.displayName}</span>
          <span
            role="button"
            tabIndex={0}
            data-testid="file-tab-close"
            data-file-name={file.displayName}
            data-file-path={file.filePath}
            onClick={(e) => {
              e.stopPropagation()
              onCloseTab(file.filePath)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                e.preventDefault()
                onCloseTab(file.filePath)
              }
            }}
            className="ml-auto p-0.5 rounded hover:bg-muted-foreground/20 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <X className="h-3 w-3" />
          </span>
        </button>
      ))}
    </div>
  )
}
