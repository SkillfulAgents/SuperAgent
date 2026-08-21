import { ArrowDownToLine, Download } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { FileTypeIcon } from '@renderer/components/ui/file-type-icon'
import { FileDownloadPill } from '@renderer/components/ui/file-download-pill'
import { useFilePreview } from '@renderer/context/file-preview-context'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps, CollapsedContentProps } from './types'
import { deliverFileDef, type DeliverFileInput } from '@shared/lib/tool-definitions/deliver-file'

function getFilename(filePath: string): string {
  return filePath.split('/').pop() || filePath
}

function ExpandedView({ input, result, isError, agentSlug }: ToolRendererProps) {
  const { filePath, description } = input as DeliverFileInput
  const filePreview = useFilePreview()

  const handlePreview = () => {
    if (!filePath || !agentSlug) return
    filePreview.openFile(filePath, agentSlug, description)
  }

  return (
    <div className="space-y-2">
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      {filePath && (
        <div className="flex items-center gap-2">
          <FileTypeIcon filename={getFilename(filePath)} size={20} />
          <code className="bg-background px-1.5 py-0.5 rounded text-xs">
            {getFilename(filePath)}
          </code>
          {!isError && agentSlug && (
            <Button
              onClick={handlePreview}
              size="sm"
              variant="outline"
              className="h-7"
            >
              <Download className="h-3 w-3 mr-1" />
              Preview
            </Button>
          )}
        </div>
      )}
      {result && (
        <div
          className={`bg-background text-xs rounded p-2 ${isError ? 'text-red-800 dark:text-red-200' : 'text-green-800 dark:text-green-200'}`}
        >
          {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
        </div>
      )}
    </div>
  )
}

function StreamingView({ partialInput }: StreamingToolRendererProps) {
  try {
    const partial = JSON.parse(partialInput)
    if (partial.filePath) {
      return (
        <div className="text-xs text-muted-foreground">
          Delivering: {getFilename(partial.filePath)}
        </div>
      )
    }
  } catch {
    // partial JSON, ignore
  }
  return <div className="text-xs text-muted-foreground">Preparing file...</div>
}

function CollapsedContent({ input, isError, agentSlug }: CollapsedContentProps) {
  const { filePath } = input as DeliverFileInput
  if (!filePath) return null

  // Failed delivery: surface an explicit error marker instead of returning null
  // (which would leave a dangling separator in the collapsed row).
  if (isError) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1 text-xs text-red-800 dark:text-red-200">
        <FileTypeIcon filename={getFilename(filePath)} size={14} />
        <span className="truncate">delivery failed</span>
      </span>
    )
  }

  if (!agentSlug) return null

  return (
    <FileDownloadPill
      filePath={filePath}
      agentSlug={agentSlug}
      onClick={(e) => e.stopPropagation()}
    />
  )
}

export const deliverFileRenderer: ToolRenderer = {
  displayName: 'Deliver File',
  icon: ArrowDownToLine,
  getSummary: (input: unknown) => deliverFileDef.getSummary(input),
  ExpandedView,
  StreamingView,
  CollapsedContent,
}
