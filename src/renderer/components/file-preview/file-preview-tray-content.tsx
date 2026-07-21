import { Download, FileText, Folder, PanelRightClose, X } from 'lucide-react'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { FileTabBar } from './file-tab-bar'
import { FileRenderer } from './renderers/file-renderer'
import { FolderBrowser } from './folder-browser'
import { CommentBar } from './comments/comment-bar'
import { getApiBaseUrl } from '@renderer/lib/env'
import { getAgentFileApiPath } from '@renderer/lib/workspace-file-url'
import { cn } from '@shared/lib/utils/cn'

interface FilePreviewTrayContentProps {
  sessionId: string
  onClose: () => void
}

export function FilePreviewTrayContent({ sessionId, onClose }: FilePreviewTrayContentProps) {
  const { openTabs, activeTabIndex, setActiveTab, closeTab, comments } = useFilePreview()

  const activeTab = openTabs[activeTabIndex]
  if (!activeTab) return null

  const baseUrl = getApiBaseUrl()
  const fileApiPath = activeTab.kind === 'file'
    ? getAgentFileApiPath(activeTab.agentSlug, activeTab.filePath)
    : null
  const versionParam = activeTab.kind === 'file' && activeTab.version > 0 ? `&v=${activeTab.version}` : ''
  const fileUrl = fileApiPath ? `${baseUrl}${fileApiPath}?inline=true${versionParam}` : null
  const downloadUrl = fileApiPath ? `${baseUrl}${fileApiPath}` : null
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
        ) : fileUrl ? (
          <FileRenderer
            filePath={activeTab.filePath}
            fileUrl={fileUrl}
            agentSlug={activeTab.agentSlug}
          />
        ) : null}
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
