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
          <p className="text-xs">{description}</p>
        </div>
      )}
      {fileTypes && (
        <div>
          <div className="text-xs font-medium text-muted-foreground">File types</div>
          <p className="text-xs">{fileTypes}</p>
        </div>
      )}
      {result && (
        <div
          className={`bg-background text-xs rounded p-2 ${isError ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}`}
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
        <div className="text-xs text-muted-foreground">
          Requesting: {partial.description}
        </div>
      )
    }
  } catch {
    // partial JSON, ignore
  }
  return <div className="text-xs text-muted-foreground">Requesting file...</div>
}

export const requestFileRenderer: ToolRenderer = {
  displayName: 'Request File',
  icon: Upload,
  getSummary: (input: unknown) => requestFileDef.getSummary(input),
  ExpandedView,
  StreamingView,
}
