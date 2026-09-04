import { ArrowDownToLine } from 'lucide-react'
import { FileTypeIcon } from '@renderer/components/ui/file-type-icon'
import { FileDeliveryRow } from '@renderer/components/ui/file-delivery-row'
import { FileDownloadPill } from '@renderer/components/ui/file-download-pill'
import { parseToolResult } from '@renderer/lib/parse-tool-result'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps, CollapsedContentProps } from './types'
import { deliverFileDef, getDeliveredFileSize, type DeliverFileInput } from '@shared/lib/tool-definitions/deliver-file'
import { getPathName } from '@shared/lib/utils/workspace-path'

function ExpandedView({ input, result, isError, agentSlug }: ToolRendererProps) {
  const { filePath, description } = input as DeliverFileInput
  const deliverable = !!filePath && !isError && !!agentSlug

  return (
    <div className="space-y-2">
      {/* The same row the turn shows below the answer, so one delivery reads the
          same way in both places instead of offering a different affordance in
          each. It carries the description, so no separate blurb line here. */}
      {deliverable && (
        <FileDeliveryRow
          filePath={filePath}
          agentSlug={agentSlug}
          description={description}
          sizeBytes={getDeliveredFileSize(parseToolResult(result).text)}
        />
      )}
      {filePath && !deliverable && (
        <>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
          <div className="flex items-center gap-2">
            <FileTypeIcon filename={getPathName(filePath)} size="lg" className="text-muted-foreground" />
            <code className="bg-background px-1.5 py-0.5 rounded text-xs">
              {getPathName(filePath)}
            </code>
          </div>
        </>
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
          Delivering: {getPathName(partial.filePath)}
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
        <FileTypeIcon filename={getPathName(filePath)} size="sm" />
        <span className="truncate">delivery failed</span>
      </span>
    )
  }

  if (!agentSlug) return null

  // The collapsed row is a one-line summary beside the tool name, so it keeps
  // the inline pill; the full row belongs to the expanded view.
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
