import { useCallback, useState, type ReactNode } from 'react'
import { ArrowDownToLine } from 'lucide-react'
import type { FileBrowserTab } from '@renderer/hooks/use-file-preview-tabs'
import { CopyFileButton } from './copy-file-button'
import { FileTabBar } from './file-tab-bar'
import { isCopyableTextFile } from '@renderer/lib/file-types'
import { FileRenderer } from './renderers/file-renderer'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils/cn'
import { formatFileSize } from '@shared/lib/utils/format-file-size'

interface TabbedFilePreviewProps<T extends FileBrowserTab> {
  tabs: T[]
  getTabKey: (tab: T) => string
  activeTabIndex: number
  onSelectTab: (index: number) => void
  onCloseTab: (key: string) => void
  file?: { path: string; inlineUrl?: string | null; downloadUrl?: string | null; agentSlug?: string; size?: number | null } | null
  folderContent?: ReactNode
  folderActions?: ReactNode
  onPdfPageChange: (page: number) => void
  trailing?: ReactNode
  footer?: ReactNode
}

/** The same tab rail, title actions and preview card for agent and volume files. */
export function TabbedFilePreview<T extends FileBrowserTab>({
  tabs, getTabKey, activeTabIndex, onSelectTab, onCloseTab, file,
  folderContent, folderActions, onPdfPageChange, trailing, footer,
}: TabbedFilePreviewProps<T>) {
  const [leadingTabFlush, setLeadingTabFlush] = useState(false)
  const onLeadingTabFlush = useCallback((flush: boolean) => setLeadingTabFlush(flush), [])
  const activeTab = tabs[activeTabIndex]
  if (!activeTab) return null

  return (
    <>
      <FileTabBar
        tabs={tabs} getTabKey={getTabKey} activeIndex={activeTabIndex}
        onTabClick={onSelectTab} onCloseTab={onCloseTab}
        onLeadingTabFlush={onLeadingTabFlush} trailing={trailing}
      />
      {/* File content: a card inset 16px on every side, on the same gray as the tab rail. */}
      <div className="flex flex-1 min-h-0 flex-col bg-muted/60 px-4 pb-4">
        <div
          className={cn(
            'flex flex-1 min-h-0 flex-col overflow-hidden rounded-lg border border-black/5 bg-background dark:border-white/5',
            // Square only where a tab actually meets the corner. Under an inactive
            // tab — or a strip scrolled away from its first tab — the square edge
            // would be a corner cut for no one.
            leadingTabFlush && 'rounded-tl-none',
          )}
        >
          <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-2" data-testid="file-preview-title">
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <h2 className="truncate text-sm font-medium text-foreground">{activeTab.displayName}</h2>
              {file && typeof file.size === 'number' && (
                <span className="shrink-0 text-xs font-normal text-muted-foreground" data-testid="file-preview-size">
                  {formatFileSize(file.size)}
                </span>
              )}
            </div>
            {/* A tab's own actions live with its name, not in the panel header —
                the folder's host actions for the same reason as the file's. One
                provider for the row, so moving between them skips the second
                tooltip's open delay. */}
            <TooltipProvider delayDuration={300}>
              <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
                {activeTab.kind === 'folder' && folderActions}
                {file?.inlineUrl && isCopyableTextFile(file.path) && (
                  <CopyFileButton fileUrl={file.inlineUrl} displayName={activeTab.displayName} />
                )}
                {file?.downloadUrl && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <a
                        href={file.downloadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-0.5 rounded hover:bg-muted transition-colors"
                        aria-label="Download file"
                      >
                        <ArrowDownToLine className="h-4 w-4" />
                      </a>
                    </TooltipTrigger>
                    <TooltipContent>Download file</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </TooltipProvider>
          </div>
          <div
            className={cn(
              'flex-1 min-h-0',
              activeTab.kind === 'folder' ? 'overflow-hidden' : 'overflow-auto',
            )}
          >
            {activeTab.kind === 'folder' ? (
              folderContent
            ) : file?.inlineUrl ? (
              <FileRenderer
                key={getTabKey(activeTab)}
                filePath={file.path}
                fileUrl={file.inlineUrl}
                agentSlug={file.agentSlug}
                downloadUrl={file.downloadUrl ?? undefined}
                pdfPage={activeTab.pdfPage}
                onPdfPageChange={onPdfPageChange}
              />
            ) : null}
          </div>
        </div>
      </div>

      {footer}
    </>
  )
}
