import { Download, FileText, PanelRightClose, X } from 'lucide-react'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { FileTabBar } from './file-tab-bar'
import { FileRenderer } from './renderers/file-renderer'
import { CommentBar } from './comments/comment-bar'
import { getApiBaseUrl } from '@renderer/lib/env'

interface FilePreviewTrayContentProps {
  agentSlug: string
  sessionId: string
  onClose: () => void
}

function getRelativePath(filePath: string): string {
  return filePath.replace(/^\/workspace\//, '')
}

export function FilePreviewTrayContent({ agentSlug, sessionId, onClose }: FilePreviewTrayContentProps) {
  const { openFiles, activeFileIndex, setActiveFile, closeFile, comments } = useFilePreview()

  const activeFile = openFiles[activeFileIndex]
  if (!activeFile) return null

  const baseUrl = getApiBaseUrl()
  const relativePath = getRelativePath(activeFile.filePath)
  const versionParam = activeFile.version > 0 ? `&v=${activeFile.version}` : ''
  const fileUrl = `${baseUrl}/api/agents/${activeFile.agentSlug}/files/${relativePath}?inline=true${versionParam}`
  const downloadUrl = `${baseUrl}/api/agents/${activeFile.agentSlug}/files/${relativePath}`
  const activeComments = comments.get(activeFile.filePath) || []

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
        <FileText className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-xs truncate font-medium">Files</span>
        <a
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="p-0.5 rounded hover:bg-muted transition-colors"
          title="Download file"
        >
          <Download className="h-4 w-4" />
        </a>
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
        files={openFiles}
        activeIndex={activeFileIndex}
        onTabClick={setActiveFile}
        onCloseTab={closeFile}
      />

      {/* File content */}
      <div className="flex-1 min-h-0 overflow-auto">
        <FileRenderer
          filePath={activeFile.filePath}
          fileUrl={fileUrl}
          agentSlug={activeFile.agentSlug}
        />
      </div>

      {/* Comment bar */}
      <CommentBar
        comments={activeComments}
        filePath={activeFile.filePath}
        agentSlug={agentSlug}
        sessionId={sessionId}
      />
    </div>
  )
}
