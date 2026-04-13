import { Upload } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from './types'
import { requestFileDef, type RequestFileInput } from '@shared/lib/tool-definitions/request-file'

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { description, fileTypes } = input as RequestFileInput

  return (
    <div className="space-y-2">
      {description && (
        <div>
          <div className="text-xs font-medium text-muted-foreground">Description</div>
          <p className="text-sm">{description}</p>
        </div>
      )}
      {fileTypes && (
        <div>
          <div className="text-xs font-medium text-muted-foreground">File types</div>
          <p className="text-sm">{fileTypes}</p>
        </div>
      )}
      {result && (
        <div
          className={`text-xs rounded p-2 ${isError ? 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300' : 'bg-green-50 dark:bg-green-950/50 text-green-700 dark:text-green-300'}`}
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
    if (partial.description) {
      return (
        <div className="text-sm text-muted-foreground">
          Requesting: {partial.description}
        </div>
      )
    }
  } catch {
    // partial JSON, ignore
  }
  return <div className="text-sm text-muted-foreground">Requesting file...</div>
}

export const requestFileRenderer: ToolRenderer = {
  displayName: 'Request File',
  icon: Upload,
  getSummary: (input: unknown) => requestFileDef.getSummary(input),
  ExpandedView,
  StreamingView,
}
