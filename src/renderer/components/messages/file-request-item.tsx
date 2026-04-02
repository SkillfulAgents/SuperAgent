import { apiFetch } from '@renderer/lib/api'
import { useState, useRef, useCallback } from 'react'
import { CloudUpload, Loader2, FileIcon, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { DeclineButton } from './decline-button'
import { RequestTitleChip } from './request-title-chip'
import { cn } from '@shared/lib/utils/cn'

interface FileRequestItemProps {
  toolUseId: string
  description: string
  fileTypes?: string
  sessionId: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

type RequestStatus = 'pending' | 'submitting' | 'uploaded' | 'declined'

export function FileRequestItem({
  toolUseId,
  description,
  fileTypes,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
}: FileRequestItemProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [status, setStatus] = useState<RequestStatus>('pending')
  const [error, setError] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = useCallback((files: FileList | File[]) => {
    const file = Array.from(files)[0]
    if (file) {
      setSelectedFile(file)
      setError(null)
    }
  }, [])

  const handleUpload = async () => {
    if (!selectedFile) return

    setStatus('submitting')
    setError(null)

    try {
      // Upload the file
      const formData = new FormData()
      formData.append('file', selectedFile)
      const uploadResponse = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/upload-file`,
        { method: 'POST', body: formData }
      )

      if (!uploadResponse.ok) {
        throw new Error('Failed to upload file')
      }

      const { path } = await uploadResponse.json()

      // Resolve the pending input with the file path
      const provideResponse = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/provide-file`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolUseId, filePath: path }),
        }
      )

      if (!provideResponse.ok) {
        const data = await provideResponse.json()
        throw new Error(data.error || 'Failed to provide file')
      }

      setStatus('uploaded')
      onComplete()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to upload file'
      setError(message)
      setStatus('pending')
    }
  }

  const handleDecline = async (reason?: string) => {
    setStatus('submitting')
    setError(null)

    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/provide-file`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toolUseId,
            decline: true,
            declineReason: reason || 'User declined to provide the file',
          }),
        }
      )

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to decline request')
      }

      setStatus('declined')
      onComplete()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to decline request'
      setError(message)
      setStatus('pending')
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files)
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileSelect(e.target.files)
      e.target.value = ''
    }
  }

  // Completed state
  if (status === 'uploaded' || status === 'declined') {
    return (
      <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm">
        <div className="flex items-center gap-2 p-4">
          <FileIcon
            className={cn(
              'h-4 w-4 shrink-0',
              status === 'uploaded' ? 'text-green-500' : 'text-red-500'
            )}
          />
          <span className="text-sm truncate">{description}</span>
          <span
            className={cn(
              'ml-auto text-xs',
              status === 'uploaded' ? 'text-green-600' : 'text-red-600'
            )}
          >
            {status === 'uploaded' ? 'File uploaded' : 'Declined'}
          </span>
        </div>
      </div>
    )
  }

  // Read-only state for viewers
  if (readOnly) {
    return (
      <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm">
        <div className="flex items-start gap-3 p-4">
          <div className="flex-1 min-w-0">
            <RequestTitleChip className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" icon={<FileIcon />}>
              File Request
            </RequestTitleChip>
            <p className="mt-6 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{description}</p>
            {fileTypes && (
              <p className="mt-2 text-xs text-muted-foreground">
                Accepted file types: {fileTypes}
              </p>
            )}
          </div>
          <span className="text-xs text-blue-600 dark:text-blue-400 shrink-0">Waiting for response</span>
        </div>
      </div>
    )
  }

  // Pending/submitting state
  return (
    <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm">
      <div className="p-4">
        <div className="flex min-w-0 flex-col">
          {/* Header */}
          <div>
            <RequestTitleChip className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" icon={<FileIcon />}>
              File Request
            </RequestTitleChip>
            <p className="mt-6 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{description}</p>
            {fileTypes && (
              <p className="mt-2 text-xs text-muted-foreground">
                Accepted file types: {fileTypes}
              </p>
            )}
          </div>

          <div className="pt-3">
            {/* Drop zone / file picker */}
            <div
              className={cn(
                'group relative border rounded-md p-4 text-center cursor-pointer transition-colors',
                isDragOver
                  ? 'border-blue-400 dark:border-blue-500 bg-blue-100 dark:bg-blue-900'
                  : selectedFile
                    ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/50'
                    : 'border-border bg-white dark:bg-blue-950/30 hover:border-border'
              )}
              role="button"
              tabIndex={0}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  fileInputRef.current?.click()
                }
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={handleInputChange}
                accept={fileTypes || undefined}
              />
              {selectedFile ? (
                <>
                  <div className="flex items-center justify-center gap-2">
                    <FileIcon className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                    <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
                      {selectedFile.name}
                    </span>
                    <span className="text-xs text-blue-500 dark:text-blue-400">
                      ({(selectedFile.size / 1024).toFixed(1)} KB)
                    </span>
                    <button
                      type="button"
                      className="hidden h-6 w-6 items-center justify-center rounded-full border border-border bg-white text-foreground transition-colors group-hover:inline-flex hover:bg-muted focus-visible:bg-muted dark:bg-background"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setSelectedFile(null)
                        setError(null)
                      }}
                      aria-label="Remove selected file"
                      title="Remove selected file"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center gap-2 whitespace-pre-line text-sm text-foreground/80 dark:text-foreground/80">
                  <CloudUpload className="h-5 w-5" />
                  <div>
                    Click to browse, or
                    {'\n'}
                    drag & drop file here
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex justify-end gap-2 pt-8">
            <DeclineButton
              onDecline={handleDecline}
              disabled={status === 'submitting'}
              showIcon={false}
              className="border-border text-foreground hover:bg-muted"
            />

            <Button
              onClick={handleUpload}
              disabled={!selectedFile || status === 'submitting'}
              size="sm"
              className="min-w-28 bg-blue-600 text-white hover:bg-blue-700"
            >
              {status === 'submitting' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <span>Upload file</span>
              )}
              {status === 'submitting' ? <span>Upload file</span> : null}
            </Button>
          </div>

          {/* Error message */}
          {error && (
            <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:bg-red-950/30 dark:text-red-300">
              Error: {error}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
