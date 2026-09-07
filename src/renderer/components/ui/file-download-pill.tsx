import { FileTypeIcon } from './file-type-icon'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { openableProps } from '@renderer/lib/openable'
import { describeWorkspaceFile } from '@renderer/lib/workspace-file'

interface FileDownloadPillProps {
  filePath: string
  agentSlug: string
}

const PILL_CLASS = 'file-pill inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer'

export function FileDownloadPill({ filePath, agentSlug }: FileDownloadPillProps) {
  const { openFile } = useFilePreview()
  const file = describeWorkspaceFile(filePath, agentSlug)

  const identity = {
    className: PILL_CLASS,
    'data-testid': 'file-pill',
    'data-file-name': file.name,
    'data-file-path': file.path,
  }

  // A delivered folder is named here, not opened: this pill is the one-line
  // summary beside a collapsed tool call, and the folder browser wants the
  // whole drawer.
  if (file.isFolder) {
    return (
      <span {...identity}>
        <FileTypeIcon filename={file.name} size="sm" folder />
        {file.name}
      </span>
    )
  }

  return (
    <span
      {...identity}
      // The pill sits inside a collapsed tool row that expands on click, so
      // opening the file must not also expand the call.
      {...openableProps(() => openFile(file.path, file.agentSlug), { stopPropagation: true })}
    >
      <FileTypeIcon filename={file.name} size="sm" />
      {file.name}
    </span>
  )
}
