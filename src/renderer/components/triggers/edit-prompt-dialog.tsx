import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'

interface EditPromptDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialPrompt: string
  title: string
  description: string
  isSaving: boolean
  errorMessage?: string | null
  onSave: (prompt: string) => void
}

export function EditPromptDialog({
  open,
  onOpenChange,
  initialPrompt,
  title,
  description,
  isSaving,
  errorMessage,
  onSave,
}: EditPromptDialogProps) {
  const [draft, setDraft] = useState(initialPrompt)

  useEffect(() => {
    if (open) setDraft(initialPrompt)
  }, [open, initialPrompt])

  const trimmed = draft.trim()
  const canSave = trimmed.length > 0 && trimmed !== initialPrompt.trim() && !isSaving

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={12}
            className="min-h-[220px] font-mono text-xs"
            disabled={isSaving}
            autoFocus
          />
          {errorMessage && (
            <p className="mt-2 text-sm text-destructive">{errorMessage}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={() => onSave(trimmed)} disabled={!canSave}>
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              'Save'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
