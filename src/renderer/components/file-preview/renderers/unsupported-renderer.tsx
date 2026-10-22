import { ArrowDownToLine } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { FileTypeIcon } from '@renderer/components/ui/file-type-icon'
import { getPathName } from '@shared/lib/utils/workspace-path'
import { describeWorkspaceFile } from '@renderer/lib/workspace-file'

export const NO_PREVIEW = 'Preview is not available for this file type'

interface UnsupportedRendererProps {
  filePath: string
  agentSlug: string
  downloadUrl?: string
  /** Why the drawer can't show this file, when it is not the file type. */
  reason?: string
}

export function UnsupportedRenderer({ filePath, agentSlug, downloadUrl, reason = NO_PREVIEW }: UnsupportedRendererProps) {
  const file = agentSlug ? describeWorkspaceFile(filePath, agentSlug) : { name: getPathName(filePath), downloadUrl }

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 px-8 text-center">
      <div className="space-y-1">
        <div className="flex items-center gap-2 justify-center">
          <FileTypeIcon filename={file.name} size="md" className="text-muted-foreground" />
          <span className="text-sm font-medium">{file.name}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          {reason}
        </p>
      </div>
      {file.downloadUrl && (
        <a href={file.downloadUrl} target="_blank" rel="noopener noreferrer">
          <Button variant="outline" size="sm">
            <ArrowDownToLine className="h-3.5 w-3.5 mr-1.5" />
            Download
          </Button>
        </a>
      )}
    </div>
  )
}
