import { ArrowDownToLine, PanelRight, X } from 'lucide-react'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { CopyFileButton } from './copy-file-button'
import { FileTabBar } from './file-tab-bar'
import { isCopyableTextFile } from './file-types'
import { FileRenderer } from './renderers/file-renderer'
import { FolderBrowser } from './folder-browser'
import { FolderHostActions } from './folder-host-actions'
import { CommentBar } from './comments/comment-bar'
import { getApiBaseUrl } from '@renderer/lib/env'
import { getAgentFileApiPath } from '@renderer/lib/workspace-file-url'
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

  const activeTab = openTabs[activeTabIndex]
  // Hooks run before the early return so their order is stable across renders.
  const { data: fileSize } = useFileSize(
    activeTab?.kind === 'file' ? getAgentFileApiPath(activeTab.agentSlug, activeTab.filePath) : null,
    activeTab?.kind === 'file' ? activeTab.version : 0,
  )
  if (!activeTab) return null

  const baseUrl = getApiBaseUrl()
  const fileApiPath = activeTab.kind === 'file'
    ? getAgentFileApiPath(activeTab.agentSlug, activeTab.filePath)
    : null
  // `v` is a cache buster, not a server-read param: the route ignores it, but it
  // keeps a redelivered file from resolving to a URL that a browser or CDN still
  // holds the previous body for.
  const versionQuery = activeTab.kind === 'file' && activeTab.version > 0 ? `v=${activeTab.version}` : ''
  const fileUrl = fileApiPath ? `${baseUrl}${fileApiPath}?inline=true${versionQuery ? `&${versionQuery}` : ''}` : null
  const downloadUrl = fileApiPath ? `${baseUrl}${fileApiPath}${versionQuery ? `?${versionQuery}` : ''}` : null
  const activeComments = activeTab.kind === 'file' ? comments.get(activeTab.filePath) || [] : []

  return (
    <div className="contents" data-testid="file-preview-tray">
      {/* File tabs */}
      <FileTabBar
        tabs={openTabs}
        activeIndex={activeTabIndex}
        onTabClick={setActiveTab}
        onCloseTab={closeTab}
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
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-lg rounded-tl-none border border-black/5 bg-background dark:border-white/5">
        <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-2" data-testid="file-preview-title">
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <h2 className="truncate text-sm font-medium text-foreground">{activeTab.displayName}</h2>
            {activeTab.kind === 'file' && typeof fileSize === 'number' && (
              <span className="shrink-0 text-xs font-normal text-muted-foreground" data-testid="file-preview-size">
                {formatFileSize(fileSize)}
              </span>
            )}
          </div>
          {/* A tab's own actions live with its name, not in the panel header —
              the folder's host actions for the same reason as the file's. */}
          <TooltipProvider delayDuration={300}>
          <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
            {activeTab.kind === 'folder' && <FolderHostActions folder={activeTab} />}
            {fileUrl && activeTab.kind === 'file' && isCopyableTextFile(activeTab.filePath) && (
              <CopyFileButton fileUrl={fileUrl} displayName={activeTab.displayName} />
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
          ) : fileUrl ? (
            <FileRenderer
              filePath={activeTab.filePath}
              fileUrl={fileUrl}
              agentSlug={activeTab.agentSlug}
              pdfPage={activeTab.pdfPage}
              onPdfPageChange={(page) => setPdfPage(activeTab.filePath, page)}
            />
          ) : null}
        </div>
      </div>
      </div>

      {/* Comment bar */}
      {activeTab.kind === 'file' && (
        <CommentBar
          comments={activeComments}
          filePath={activeTab.filePath}
          sessionId={sessionId}
        />
      )}
    </div>
  )
}
