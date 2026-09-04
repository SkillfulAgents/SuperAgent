import { useCallback, useState } from 'react'
import { ArrowDownToLine, PanelRight, X } from 'lucide-react'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { CopyFileButton } from './copy-file-button'
import { FileTabBar } from './file-tab-bar'
import { isCopyableTextFile } from './file-types'
import { FileRenderer } from './renderers/file-renderer'
import { FolderBrowser } from './folder-browser'
import { FolderHostActions } from './folder-host-actions'
import { CommentBar } from './comments/comment-bar'
import { getAgentFileApiPath, getAgentFileUrl } from '@renderer/lib/workspace-file-url'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils/cn'
import { formatFileSize } from '@shared/lib/utils/format-file-size'
import { useFileSize } from '@renderer/hooks/use-file-size'

interface FilePreviewTrayContentProps {
  sessionId: string
  onClose: () => void
}

export function FilePreviewTrayContent({ sessionId, onClose }: FilePreviewTrayContentProps) {
  const { openTabs, activeTabIndex, setActiveTab, setPdfPage, closeTab, comments } = useFilePreview()
  // The body card squares off its top-left corner only while the active tab sits
  // directly above it; the strip is the only thing that knows when that is.
  const [leadingTabFlush, setLeadingTabFlush] = useState(false)
  const onLeadingTabFlush = useCallback((flush: boolean) => setLeadingTabFlush(flush), [])

  const activeTab = openTabs[activeTabIndex]
  const activeFile = activeTab?.kind === 'file' ? activeTab : null
  // Hooks run before the early return so their order is stable across renders.
  const { data: fileSize } = useFileSize(
    activeFile ? getAgentFileApiPath(activeFile.agentSlug, activeFile.filePath) : null,
    activeFile?.version ?? 0,
  )
  if (!activeTab) return null

  const fileUrl = activeFile
    ? getAgentFileUrl(activeFile.agentSlug, activeFile.filePath, { inline: true, version: activeFile.version })
    : null
  const downloadUrl = activeFile
    ? getAgentFileUrl(activeFile.agentSlug, activeFile.filePath, { version: activeFile.version })
    : null
  const activeComments = activeFile ? comments.get(activeFile.filePath) || [] : []

  return (
    <div className="contents" data-testid="file-preview-tray">
      {/* File tabs */}
      <FileTabBar
        tabs={openTabs}
        activeIndex={activeTabIndex}
        onTabClick={setActiveTab}
        onCloseTab={closeTab}
        onLeadingTabFlush={onLeadingTabFlush}
        trailing={
          // The drawer's own controls. Compact layouts show the close button;
          // wide layouts show the panel-hide button (see globals.css).
          <div className="flex items-center gap-1" data-testid="file-preview-header">
            <button
              className="file-preview-compact-close hidden p-0.5 rounded hover:bg-muted transition-colors"
              onClick={onClose}
              title="Close file preview"
              aria-label="Close file preview"
            >
              <X className="h-4 w-4" />
            </button>
            <button
              className="file-preview-wide-close inline-flex p-0.5 rounded hover:bg-muted transition-colors"
              onClick={onClose}
              title="Hide files panel"
              aria-label="Hide files panel"
            >
              <PanelRight className="h-4 w-4" />
            </button>
          </div>
        }
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
            {activeFile && typeof fileSize === 'number' && (
              <span className="shrink-0 text-xs font-normal text-muted-foreground" data-testid="file-preview-size">
                {formatFileSize(fileSize)}
              </span>
            )}
          </div>
          {/* A tab's own actions live with its name, not in the panel header —
              the folder's host actions for the same reason as the file's. One
              provider for the row, so moving between them skips the second
              tooltip's open delay. */}
          <TooltipProvider delayDuration={300}>
          <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
            {activeTab.kind === 'folder' && <FolderHostActions folder={activeTab} />}
            {fileUrl && activeFile && isCopyableTextFile(activeFile.filePath) && (
              <CopyFileButton fileUrl={fileUrl} displayName={activeFile.displayName} />
            )}
            {downloadUrl && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <a
                    href={downloadUrl}
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
            <FolderBrowser folder={activeTab} />
          ) : fileUrl && activeFile ? (
            <FileRenderer
              filePath={activeFile.filePath}
              fileUrl={fileUrl}
              agentSlug={activeFile.agentSlug}
              pdfPage={activeFile.pdfPage}
              onPdfPageChange={(page) => setPdfPage(activeFile.filePath, page)}
            />
          ) : null}
        </div>
      </div>
      </div>

      {/* Comment bar */}
      {activeFile && (
        <CommentBar
          comments={activeComments}
          filePath={activeFile.filePath}
          sessionId={sessionId}
        />
      )}
    </div>
  )
}
