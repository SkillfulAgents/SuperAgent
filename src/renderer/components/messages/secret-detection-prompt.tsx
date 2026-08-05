import { useEffect, useId, useState } from 'react'
import { KeyRound, X } from 'lucide-react'
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
import { useCreateSecret } from '@renderer/hooks/use-secrets'
import { isReservedEnvVar } from '@shared/lib/container/reserved-env-vars'
import { keyToEnvVar } from '@shared/lib/utils/secrets'
import type { PotentialSecret } from '@renderer/lib/secret-detection'

interface SecretDetectionPromptProps {
  agentSlug: string
  candidate: PotentialSecret
  onDismiss: (candidate: PotentialSecret) => void
  onSecure: (candidate: PotentialSecret, secret: { key: string; envVar: string }) => void
}

export function SecretDetectionPrompt({
  agentSlug,
  candidate,
  onDismiss,
  onSecure,
}: SecretDetectionPromptProps) {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [value, setValue] = useState(candidate.value)
  const [error, setError] = useState('')
  const createSecret = useCreateSecret()
  const id = useId()
  const keyInputId = `${id}-key-name`
  const valueInputId = `${id}-secret-value`
  const envVar = keyToEnvVar(key.trim())
  const isReserved = !!envVar && isReservedEnvVar(envVar)

  useEffect(() => {
    if (!open) return
    setKey('')
    setValue(candidate.value)
    setError('')
  }, [candidate, open])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    // The dialog is portalled in the DOM but still bubbles through React's
    // component tree, which otherwise submits the surrounding chat composer.
    event.stopPropagation()
    if (!key.trim() || !value || isReserved) return
    setError('')

    try {
      const saved = await createSecret.mutateAsync({
        agentSlug,
        key: key.trim(),
        value,
        location: 'composer',
      })
      onSecure(candidate, { key: saved.key, envVar: saved.envVar })
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to save the key securely')
    }
  }

  return (
    <div
      data-testid="secret-detection-prompt"
      className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-dotted border-amber-500/70 bg-amber-500/5 px-2.5 py-2 text-xs"
    >
      <span className="flex items-center gap-1.5 font-medium">
        <KeyRound className="h-3.5 w-3.5 text-amber-600" />
        Is this a Key?
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <button type="button" className="font-medium text-primary underline-offset-2 hover:underline">
            Send securely to the agent
          </button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleSubmit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Send key securely</DialogTitle>
              <DialogDescription>
                Save this value to the agent&apos;s .env file. The message will contain only the environment variable name.
              </DialogDescription>
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
                  autoComplete="off"
                  className="font-mono"
                />
              </div>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={!key.trim() || !value || isReserved || createSecret.isPending}>
                {createSecret.isPending ? 'Saving...' : 'Save securely'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <span className="text-muted-foreground">or</span>
      <button
        type="button"
        aria-label="Dismiss key suggestion"
        onClick={() => onDismiss(candidate)}
        className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        dismiss
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
