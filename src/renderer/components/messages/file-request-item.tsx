import { apiFetch } from '@renderer/lib/api'
import { useState, useRef, useCallback } from 'react'
import { Upload, Check, Loader2, FileIcon } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { DeclineButton } from './decline-button'
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
      <div className="border rounded-md bg-muted/30 text-sm">
        <div className="flex items-center gap-2 px-3 py-2">
          <Upload
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
      <div className="border rounded-md bg-blue-50 dark:bg-blue-950/50 border-blue-200 dark:border-blue-800 text-sm">
        <div className="flex items-center gap-3 p-3">
          <div className="h-8 w-8 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center shrink-0">
            <Upload className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-blue-900 dark:text-blue-100">File Requested</div>
            <p className="text-sm text-blue-700 dark:text-blue-300 mt-1 whitespace-pre-line">{description}</p>
          </div>
          <span className="text-xs text-blue-600 dark:text-blue-400 shrink-0">Waiting for response</span>
        </div>
      </div>
    )
  }

  // Pending/submitting state
  return (
    <div className="border rounded-md bg-blue-50 dark:bg-blue-950/50 border-blue-200 dark:border-blue-800 text-sm">
      <div className="flex items-start gap-3 p-3">
        {/* Icon */}
        <div className="h-8 w-8 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center shrink-0">
          <Upload className="h-4 w-4 text-blue-600 dark:text-blue-400" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-3">
          {/* Header */}
          <div>
            <div className="font-medium text-blue-900 dark:text-blue-100">File Requested</div>
            <p className="text-sm text-blue-700 dark:text-blue-300 mt-1 whitespace-pre-line">{description}</p>
            {fileTypes && (
              <p className="text-xs text-blue-500 dark:text-blue-400 mt-0.5">
                Suggested types: {fileTypes}
              </p>
            )}
          </div>

          {/* Drop zone / file picker */}
          <div
            className={cn(
              'border-2 border-dashed rounded-md p-4 text-center cursor-pointer transition-colors',
              isDragOver
                ? 'border-blue-400 dark:border-blue-500 bg-blue-100 dark:bg-blue-900'
                : selectedFile
                  ? 'border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950/50'
                  : 'border-blue-200 dark:border-blue-700 bg-white dark:bg-blue-950/30 hover:border-blue-300 dark:hover:border-blue-600'
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
              <div className="flex items-center justify-center gap-2">
                <FileIcon className="h-4 w-4 text-green-600 dark:text-green-400" />
                <span className="text-sm text-green-700 dark:text-green-300 font-medium">
                  {selectedFile.name}
                </span>
                <span className="text-xs text-green-500 dark:text-green-400">
                  ({(selectedFile.size / 1024).toFixed(1)} KB)
                </span>
              </div>
            ) : (
              <div className="text-sm text-blue-500 dark:text-blue-400">
                Drop a file here or click to browse
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex gap-2">
            <Button
              onClick={handleUpload}
              disabled={!selectedFile || status === 'submitting'}
              size="sm"
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {status === 'submitting' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              <span className="ml-1">Upload</span>
            </Button>

            <DeclineButton
              onDecline={handleDecline}
              disabled={status === 'submitting'}
              className="border-blue-200 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900"
            />
          </div>

          {/* Error message */}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </div>
    </div>
  )
}
