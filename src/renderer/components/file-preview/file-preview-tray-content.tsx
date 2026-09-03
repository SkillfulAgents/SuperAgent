import { useEffect } from 'react'
import { AlertCircle, Download, FileText, Folder, Loader2, PanelRightClose, X } from 'lucide-react'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { CopyFileButton } from './copy-file-button'
import { FileTabBar } from './file-tab-bar'
import { isCopyableTextFile } from './file-types'
import { FileRenderer } from './renderers/file-renderer'
import { FolderBrowser } from './folder-browser'
import { CommentBar } from './comments/comment-bar'
import { usePreviewFileSource } from './use-preview-file-source'
import { cn } from '@shared/lib/utils/cn'

interface FilePreviewTrayContentProps {
  sessionId: string
  onClose: () => void
}

export function FilePreviewTrayContent({ sessionId, onClose }: FilePreviewTrayContentProps) {
  const { openTabs, activeTabIndex, setActiveTab, setPdfPage, closeTab, comments, adoptFilePath } = useFilePreview()

  const activeTab = openTabs[activeTabIndex]
  const preview = usePreviewFileSource(
    activeTab?.kind === 'file' ? activeTab.agentSlug : '',
    activeTab?.kind === 'file' ? activeTab.filePath : '',
    activeTab?.kind === 'file' ? activeTab.version : 0,
  )

  useEffect(() => {
    if (activeTab?.kind !== 'file' || preview.isResolving || !preview.fileUrl) return
    if (preview.filePath === activeTab.filePath) return
    adoptFilePath(activeTab.filePath, preview.filePath)
  }, [activeTab, preview.filePath, preview.fileUrl, preview.isResolving, adoptFilePath])

  if (!activeTab) return null

  const fileUrl = activeTab.kind === 'file' ? preview.fileUrl : null
  const downloadUrl = activeTab.kind === 'file' ? preview.downloadUrl : null
  const renderPath = activeTab.kind === 'file' ? preview.filePath : ''
  const activeComments = activeTab.kind === 'file' ? comments.get(activeTab.filePath) || [] : []

  return (
    <div className="contents" data-testid="file-preview-tray">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground select-none shrink-0" data-testid="file-preview-header">
        <button
          className="file-preview-compact-close -ml-1 hidden p-0.5 rounded hover:bg-muted transition-colors"
          onClick={onClose}
          title="Close file preview"
          aria-label="Close file preview"
        >
          <X className="h-4 w-4" />
        </button>
        {activeTab.kind === 'folder' ? (
          <Folder className="h-4 w-4 shrink-0" />
        ) : (
          <FileText className="h-4 w-4 shrink-0" />
        )}
        <span className="flex-1 text-xs truncate font-medium">Files</span>
        {fileUrl && activeTab.kind === 'file' && isCopyableTextFile(renderPath) && (
          <CopyFileButton fileUrl={fileUrl} displayName={activeTab.displayName} />
        )}
        {downloadUrl && (
          <a
            href={downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="p-0.5 rounded hover:bg-muted transition-colors"
            title="Download file"
          >
            <Download className="h-4 w-4" />
          </a>
        )}
        <button
          className="file-preview-wide-close inline-flex p-0.5 rounded hover:bg-muted transition-colors"
          onClick={onClose}
          title="Hide files panel"
          aria-label="Hide files panel"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      {/* File tabs */}
      <FileTabBar
        tabs={openTabs}
        activeIndex={activeTabIndex}
        onTabClick={setActiveTab}
        onCloseTab={closeTab}
      />

      {/* File content */}
      <div
        className={cn(
          'flex-1 min-h-0',
          activeTab.kind === 'folder' ? 'overflow-hidden' : 'overflow-auto',
        )}
      >
        {activeTab.kind === 'folder' ? (
          <FolderBrowser folder={activeTab} />
        ) : preview.isResolving ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : fileUrl ? (
          <FileRenderer
            filePath={renderPath}
            fileUrl={fileUrl}
            agentSlug={activeTab.agentSlug}
            pdfPage={activeTab.pdfPage}
            onPdfPageChange={(page) => setPdfPage(activeTab.filePath, page)}
          />
        ) : (
          <div className="flex items-center gap-2 p-4 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>Couldn&apos;t open this file</span>
          </div>
        )}
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
