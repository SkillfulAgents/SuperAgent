import { useEffect, useId, useState, type ReactNode } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@renderer/components/ui/dialog'
import { isReservedEnvVar } from '@shared/lib/container/reserved-env-vars'
import { keyToEnvVar } from '@shared/lib/utils/secrets'

interface SecretKeyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The control that opens the dialog, when it has one. */
  trigger?: ReactNode
  title: string
  description: string
  submitLabel: string
  initialKey?: string
  initialValue?: string
  /** A blank value keeps the one already saved. */
  keepsValue?: boolean
  /** Saves the key. A thrown error shows in the dialog. */
  onSave: (input: { key: string; value: string }) => Promise<void>
  onCloseAutoFocus?: (event: Event) => void
}

/** The form that names a key and its value for the agent's .env file. */
export function SecretKeyDialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  submitLabel,
  initialKey = '',
  initialValue = '',
  keepsValue = false,
  onSave,
  onCloseAutoFocus,
}: SecretKeyDialogProps) {
  const [key, setKey] = useState(initialKey)
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const id = useId()
  const keyInputId = `${id}-key-name`
  const valueInputId = `${id}-secret-value`
  const envVar = keyToEnvVar(key.trim())
  const isReserved = !!envVar && isReservedEnvVar(envVar)
  const canSave = !!key.trim() && (!!value || keepsValue) && !isReserved

  useEffect(() => {
    if (!open) return
    setKey(initialKey)
    setValue(initialValue)
    setError('')
  }, [initialKey, initialValue, open])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    // The dialog is portalled in the DOM but still bubbles through React's
    // component tree, which otherwise submits the surrounding chat composer.
    event.stopPropagation()
    if (!canSave) return
    setError('')
    setSaving(true)
    try {
      await onSave({ key: key.trim(), value })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to save the key securely')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={keyInputId}>Key name</Label>
              <Input
                id={keyInputId}
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="e.g., GitHub Token"
                autoFocus
              />
              {envVar && (
                <span className={isReserved ? 'text-xs font-mono text-destructive' : 'text-xs font-mono text-muted-foreground'}>
                  ENV: {envVar}{isReserved ? ' (reserved)' : ''}
                </span>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={valueInputId}>Secret value</Label>
              <Input
                id={valueInputId}
                type="password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={keepsValue ? 'Leave blank to keep the saved value' : undefined}
                autoComplete="off"
                className="font-mono"
              />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!canSave || saving}>
              {saving ? 'Saving...' : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
