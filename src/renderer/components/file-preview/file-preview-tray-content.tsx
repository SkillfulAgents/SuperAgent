import { FileDiff, PanelRight, X } from 'lucide-react'
import { getPreviewTabKey, useFilePreview } from '@renderer/context/file-preview-context'
import { TabbedFilePreview } from './tabbed-file-preview'
import { visibleBefore } from './file-edits'
import { FolderBrowser } from './folder-browser'
import { FolderHostActions } from './folder-host-actions'
import { CommentBar } from './comments/comment-bar'
import { describeWorkspaceFile } from '@renderer/lib/workspace-file'
import { withPreviewVersion } from '@renderer/lib/file-preview-url'
import { useFileSize } from '@renderer/hooks/use-file-size'
import { useReloadWhenChanged } from './use-reload-when-changed'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils/cn'

interface FilePreviewTrayContentProps {
  sessionId: string
  onClose: () => void
}

export function FilePreviewTrayContent({ sessionId, onClose }: FilePreviewTrayContentProps) {
  const { openTabs, activeTabIndex, setActiveTab, setPdfPage, setShowEdits, closeTab, commentsFor } = useFilePreview()
  const activeTab = openTabs[activeTabIndex]
  const activeFile = activeTab?.kind === 'file' ? activeTab : null
  // A tab with its own source (a file outside the agent's workspace) is shown from there, as no agent's file: nothing in
  // it resolves against a workspace, and it takes no comments.
  const file = activeFile
    ? activeFile.source
      ? {
        path: activeFile.filePath, apiPath: null,
        inlineUrl: withPreviewVersion(activeFile.source.inlineUrl, activeFile.version),
        downloadUrl: activeFile.source.downloadUrl === undefined ? undefined : withPreviewVersion(activeFile.source.downloadUrl, activeFile.version),
      }
      : describeWorkspaceFile(activeFile.filePath, activeFile.agentSlug, { version: activeFile.version })
    : null
  const { data: fileSize } = useFileSize(file?.apiPath ?? null, activeFile?.version ?? 0)
  useReloadWhenChanged(file && 'agentSlug' in file ? file : null)
  if (!activeTab) return null

  const activeComments = file && 'agentSlug' in file ? commentsFor(file.path, file.agentSlug) : []

  return (
    <div className="contents" data-testid="file-preview-tray">
      <TabbedFilePreview
        tabs={openTabs} getTabKey={getPreviewTabKey} activeTabIndex={activeTabIndex}
        onSelectTab={setActiveTab} onCloseTab={closeTab}
        file={file ? { ...file, size: fileSize } : null}
        folderContent={activeTab.kind === 'folder' && <FolderBrowser folder={activeTab} />}
        folderActions={activeTab.kind === 'folder' && <FolderHostActions folder={activeTab} />}
        fileActions={file && 'agentSlug' in file && file.preview === 'markdown' && activeFile?.edits && visibleBefore(activeFile.edits) !== null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setShowEdits(file.path, file.agentSlug, !activeFile.edits?.show)}
                className={cn(
                  'p-0.5 rounded-icon hover:bg-muted transition-colors',
                  activeFile.edits.show && 'bg-amber-500/10 text-amber-600 hover:bg-amber-500/15 dark:text-amber-400',
                )}
                aria-label="Show changes"
                aria-pressed={activeFile.edits.show}
                data-testid="file-preview-show-edits"
              >
                <FileDiff className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{activeFile.edits.show ? 'Hide changes' : 'Show changes'}</TooltipContent>
          </Tooltip>
        )}
        onPdfPageChange={page => { if (activeFile) setPdfPage(activeFile.filePath, activeFile.agentSlug, page) }}
        trailing={
          // The drawer's own controls. Compact layouts show the close button;
          // wide layouts show the panel-hide button (see globals.css).
          <div className="flex items-center gap-1" data-testid="file-preview-header">
            <button
              className="file-preview-compact-close hidden p-0.5 rounded-icon hover:bg-muted transition-colors"
              onClick={onClose}
              title="Close file preview"
              aria-label="Close file preview"
            >
              <X className="h-4 w-4" />
            </button>
            <button
              className="file-preview-wide-close inline-flex p-0.5 rounded-icon hover:bg-muted transition-colors"
              onClick={onClose}
              title="Hide files panel"
              aria-label="Hide files panel"
            >
              <PanelRight className="h-4 w-4" />
            </button>
          </div>
        }
        footer={activeFile && !activeFile.source && (
          <CommentBar
            comments={activeComments}
            filePath={activeFile.filePath}
            agentSlug={activeFile.agentSlug}
            sessionId={sessionId}
          />
        )}
      />
    </div>
  )
}
