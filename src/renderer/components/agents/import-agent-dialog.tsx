import { useCallback, useRef, useState } from 'react'
import { Upload, FileArchive, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { useImportAgentTemplate, type ImportProgress } from '@renderer/hooks/use-agent-templates'
import { AGENT_PACKAGE_EXTENSION } from '@shared/lib/utils/package-extensions'
import type { ApiAgentTemplateInstallResult } from '@shared/lib/types/api'

/**
 * The "Import an Agent" upload dialog, extracted from AgentCreationAids so
 * surfaces without the aid chips (the wizard's template strip) can open it
 * too. Controlled: the caller owns `open`; file/progress state lives here and
 * resets whenever the dialog closes.
 */
export function ImportAgentDialog({
  open,
  onClose,
  onComplete,
}: {
  open: boolean
  onClose: () => void
  /** Called after a successful import (post-env-var prompt if any). */
  onComplete: (result: ApiAgentTemplateInstallResult) => void | Promise<void>
}) {
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importFull, setImportFull] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<ImportProgress | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importTemplate = useImportAgentTemplate()

  const acceptFile = useCallback((file: File | null | undefined) => {
    if (!file) return
    const name = file.name.toLowerCase()
    if (!name.endsWith(AGENT_PACKAGE_EXTENSION) && !name.endsWith('.zip')) {
      toast.error(`Only ${AGENT_PACKAGE_EXTENSION} or .zip template files are supported`)
      return
    }
    setImportFile(file)
  }, [])

  const resetImport = useCallback(() => {
    setImportFile(null)
    setImportFull(false)
    setUploadProgress(null)
    importTemplate.reset()
  }, [importTemplate])

  const closeDialog = useCallback(() => {
    onClose()
    resetImport()
  }, [onClose, resetImport])

  const handleImport = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!importFile) return

      try {
        setUploadProgress({ phase: 'uploading', percent: 0 })
        const result = await importTemplate.mutateAsync({
          file: importFile,
          mode: importFull ? 'full' : 'template',
          onProgress: setUploadProgress,
        })
        setUploadProgress(null)

        closeDialog()
        await onComplete(result)
      } catch (error) {
        setUploadProgress(null)
        console.error('Failed to import template:', error)
      }
    },
    [importFile, importFull, importTemplate, closeDialog, onComplete],
  )

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault()
    acceptFile(e.dataTransfer.files[0])
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) closeDialog() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-medium">Import an Agent</DialogTitle>
          <DialogDescription className="sr-only">
            Upload a .agent or .zip template to create a new agent.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleImport}>
          <div className="py-4 space-y-4">
            <div
              className={`border border-dashed rounded-lg p-6 text-center transition-colors bg-muted/50 ${
                importTemplate.isPending
                  ? 'opacity-50 pointer-events-none'
                  : 'cursor-pointer'
              }`}
              role="button"
              tabIndex={0}
              onClick={() => !importTemplate.isPending && fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !importTemplate.isPending) {
                  e.preventDefault()
                  fileInputRef.current?.click()
                }
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={importTemplate.isPending ? undefined : handleFileDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept={`${AGENT_PACKAGE_EXTENSION},.zip`}
                className="hidden"
                disabled={importTemplate.isPending}
                onChange={(e) => {
                  acceptFile(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
              {importFile ? (
                <div className="flex items-center justify-center gap-2">
                  <FileArchive className="h-5 w-5 text-primary" />
                  <span className="text-sm font-medium">{importFile.name}</span>
                  {!importTemplate.isPending && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs"
                      onClick={(e) => {
                        e.stopPropagation()
                        setImportFile(null)
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              ) : (
                <>
                  <Upload className="h-5 w-5 mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">
                    Drop a .agent or .zip template file here<br />
                    or click to browse
                  </p>
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="creation-aids-import-full"
                checked={importFull}
                onCheckedChange={(checked) => setImportFull(checked === true)}
                disabled={importTemplate.isPending}
              />
              <label
                htmlFor="creation-aids-import-full"
                className="text-sm text-muted-foreground cursor-pointer select-none"
              >
                Import includes env. variables and session data
              </label>
            </div>

            {uploadProgress && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    {uploadProgress.phase === 'processing' && (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    )}
                    {uploadProgress.phase === 'uploading' ? 'Uploading...' : 'Processing...'}
                  </span>
                  {uploadProgress.phase === 'uploading' && (
                    <span>{Math.round(uploadProgress.percent)}%</span>
                  )}
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{
                      width: uploadProgress.phase === 'processing'
                        ? '100%'
                        : `${uploadProgress.percent}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {importTemplate.error && (
              <p className="text-sm text-destructive">{importTemplate.error.message}</p>
            )}
          </div>

          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={closeDialog}
              disabled={importTemplate.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!importFile || importTemplate.isPending}>
              {importTemplate.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {uploadProgress?.phase === 'uploading' ? 'Uploading...' : 'Processing...'}
                </>
              ) : (
                'Import'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
