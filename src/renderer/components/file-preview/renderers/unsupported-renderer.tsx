import { Download, FileQuestion } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { FileTypeIcon } from '@renderer/components/ui/file-type-icon'
import { getApiBaseUrl } from '@renderer/lib/env'
import { getAgentFileApiPath } from '@renderer/lib/workspace-file-url'

interface UnsupportedRendererProps {
  filePath: string
  agentSlug: string
}

function getFilename(filePath: string): string {
  return filePath.split('/').pop() || filePath
}

export function UnsupportedRenderer({ filePath, agentSlug }: UnsupportedRendererProps) {
  const filename = getFilename(filePath)
  const baseUrl = getApiBaseUrl()
  const downloadUrl = `${baseUrl}${getAgentFileApiPath(agentSlug, filePath)}`

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 px-8 text-center">
      <div className="p-4 rounded-full bg-muted/50">
        <FileQuestion className="h-10 w-10 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-2 justify-center">
          <FileTypeIcon filename={filename} size={16} />
          <span className="text-sm font-medium">{filename}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Preview is not available for this file type
        </p>
      </div>
      <a href={downloadUrl} target="_blank" rel="noopener noreferrer">
        <Button variant="outline" size="sm">
          <Download className="h-3.5 w-3.5 mr-1.5" />
          Download
        </Button>
      </a>
    </div>
  )
}
