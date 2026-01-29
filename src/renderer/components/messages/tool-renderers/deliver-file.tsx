import { Download } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { getApiBaseUrl } from '@renderer/lib/env'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from './types'

interface DeliverFileInput {
  filePath?: string
  description?: string
}

function getRelativePath(filePath: string): string {
  // Strip /workspace/ prefix if present
  return filePath.replace(/^\/workspace\//, '')
}

function getFilename(filePath: string): string {
  return filePath.split('/').pop() || filePath
}

function ExpandedView({ input, result, isError, agentSlug }: ToolRendererProps) {
  const { filePath, description } = input as DeliverFileInput

  const handleDownload = () => {
    if (!filePath || !agentSlug) return
    const relativePath = getRelativePath(filePath)
    const baseUrl = getApiBaseUrl()
    window.open(`${baseUrl}/api/agents/${agentSlug}/files/${relativePath}`, '_blank')
  }

  return (
    <div className="space-y-2">
      {description && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
      {filePath && (
        <div className="flex items-center gap-2">
          <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
            {getFilename(filePath)}
          </code>
          {!isError && agentSlug && (
            <Button
              onClick={handleDownload}
              size="sm"
              variant="outline"
              className="h-7"
            >
              <Download className="h-3 w-3 mr-1" />
              Download
            </Button>
          )}
        </div>
      )}
      {result && (
        <div
          className={`text-xs rounded p-2 ${isError ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}
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
        <div className="text-sm text-muted-foreground">
          Delivering: {getFilename(partial.filePath)}
        </div>
      )
    }
  } catch {
    // partial JSON, ignore
  }
  return <div className="text-sm text-muted-foreground">Preparing file...</div>
}

export const deliverFileRenderer: ToolRenderer = {
  displayName: 'Deliver File',
  icon: Download,
  getSummary: (input: unknown) => {
    const { filePath } = input as DeliverFileInput
    return filePath ? getFilename(filePath) : null
  },
  ExpandedView,
  StreamingView,
}
