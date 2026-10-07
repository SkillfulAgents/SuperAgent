import { defineToolRenderer } from '../renderer-types'
import { ArrowUpToLine } from 'lucide-react'
import type { ToolRendererProps, StreamingToolRendererProps } from '../renderer-types'
import { requestFileDef, type RequestFileInput } from './definition'

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { description, fileTypes } = input as RequestFileInput

  return (
    <div className="space-y-2">
      {description && (
        <div>
          <div className="text-xs font-medium tracking-wider text-muted-foreground">Description</div>
          <p className="text-xs">{description}</p>
        </div>
      )}
      {fileTypes && (
        <div>
          <div className="text-xs font-medium tracking-wider text-muted-foreground">File types</div>
          <p className="text-xs">{fileTypes}</p>
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

export const requestFileRenderer = defineToolRenderer(requestFileDef, {
  icon: ArrowUpToLine,
  ExpandedView,
  StreamingView,
})
