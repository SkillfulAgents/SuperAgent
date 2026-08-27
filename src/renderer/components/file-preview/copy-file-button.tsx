import { useEffect, useRef, useState } from 'react'
import { Check, ClipboardCopy } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { copyLazyTextToClipboard, copyTextToClipboard } from '@renderer/lib/clipboard'
import { looksBinary } from './file-types'
import { MAX_CONTENT_CHARS, type FileContent } from './renderers/use-file-content'

const CONFIRMATION_MS = 2000

interface CopyFileButtonProps {
  fileUrl: string
  displayName: string
}

export function CopyFileButton({ fileUrl, displayName }: CopyFileButtonProps) {
  const queryClient = useQueryClient()
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(resetTimer.current), [])

  const handleCopy = async () => {
    // Text renderers load through the same ['file-content', url] query, so for
    // the file on screen the content is normally already here — writing it
    // without awaiting anything is the only shape browsers reliably accept from
    // a click handler.
    const cached = queryClient.getQueryData<FileContent>(['file-content', fileUrl])

    try {
      if (cached) {
        if (looksBinary(cached.text)) throw new Error(`“${displayName}” is not a text file`)
        await copyTextToClipboard(cached.text)
      } else {
        await copyLazyTextToClipboard(() => fetchText(fileUrl, displayName))
      }
    } catch (error) {
      toast.error('Could not copy file contents', {
        description: error instanceof Error ? error.message : undefined,
      })
      return
    }

    setCopied(true)
    clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setCopied(false), CONFIRMATION_MS)

    toast.success(cached?.truncated
      ? `Copied the first ${MAX_CONTENT_CHARS.toLocaleString()} characters of “${displayName}”`
      : `Copied contents of “${displayName}”`)
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="p-0.5 rounded hover:bg-muted transition-colors"
      title="Copy file contents"
      aria-label="Copy file contents"
      data-testid="file-preview-copy"
    >
      {copied
        ? <Check data-testid="file-preview-copied-icon" className="h-4 w-4 text-green-600 dark:text-green-400" />
        : <ClipboardCopy data-testid="file-preview-copy-icon" className="h-4 w-4" />}
    </button>
  )
}

async function fetchText(url: string, displayName: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to load file: ${response.status}`)

  const text = await response.text()
  if (looksBinary(text)) throw new Error(`“${displayName}” is not a text file`)
  return text
}
