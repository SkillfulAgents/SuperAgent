import * as React from 'react'
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Eye, EyeOff, KeyRound, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
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
} from '@renderer/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { PageTitle, SettingsPageContainer } from '@renderer/components/layout/settings-page'
import { isReservedEnvVar } from '@shared/lib/container/reserved-env-vars'
import {
  useAgentSecrets,
  useCreateSecret,
  useUpdateSecret,
  useDeleteSecret,
  useRevealSecretValue,
  type ApiSecretDisplay,
} from '@renderer/hooks/use-secrets'
import { useRenderTracker } from '@renderer/lib/perf'

function keyToEnvVar(key: string): string {
  return key
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
}

interface AgentSecretsViewProps {
  agentSlug: string
}

export function AgentSecretsView({ agentSlug }: AgentSecretsViewProps) {
  useRenderTracker('AgentSecretsView')
  const navigate = useNavigate()
  const { data: secrets = [], isLoading } = useAgentSecrets(agentSlug)
  const [addOpen, setAddOpen] = useState(false)

  return (
    <SettingsPageContainer>
      <PageTitle
        title="Agent Secrets"
        back={{
          onClick: () => {
            void navigate({ to: '/agents/$slug', params: { slug: agentSlug } })
          },
          testId: 'secrets-back-button',
        }}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAddOpen(true)}
            data-testid="secrets-add-button"
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Add Secret
          </Button>
        }
      />

      <div className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading secrets...</p>
        ) : secrets.length === 0 ? (
          <EmptyState onAdd={() => setAddOpen(true)} />
        ) : (
          <SecretsTable secrets={secrets} agentSlug={agentSlug} />
        )}

        {secrets.length > 0 && (
          <p className="text-xs text-muted-foreground pt-2">
            Store API keys, tokens etc. securely. Secrets are passed as environment variables to
            the agent container. (Formatting:{' '}
            <code className="font-mono">`My API Key` becomes `MY_API_KEY`</code>).
          </p>
        )}
      </div>

      <SecretDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        agentSlug={agentSlug}
        existingEnvVars={secrets.map((s) => s.envVar)}
      />
    </SettingsPageContainer>
  )
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-xl border border-dashed bg-background px-6 py-10 text-center">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
        <KeyRound className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
      </div>
      <p className="text-sm font-medium">No secrets yet</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
        Store API keys, tokens etc. securely. Secrets are passed as environment variables to
        the agent container. (Formatting:{' '}
        <code className="font-mono">`My API Key` becomes `MY_API_KEY`</code>).
      </p>
      <Button size="sm" className="mt-4" onClick={onAdd}>
        <Plus className="h-4 w-4 mr-1.5" />
        Add Secret
      </Button>
    </div>
  )
}

interface SecretsTableProps {
  secrets: ApiSecretDisplay[]
  agentSlug: string
}

function SecretsTable({ secrets, agentSlug }: SecretsTableProps) {
  const existingEnvVars = secrets.map((s) => s.envVar)
  return (
    <div className="rounded-xl border bg-background overflow-hidden">
      <div className="divide-y divide-border/50">
        {secrets.map((secret) => (
          <SecretRow
            key={secret.id}
            secret={secret}
            agentSlug={agentSlug}
            existingEnvVars={existingEnvVars}
          />
        ))}
      </div>
    </div>
  )
}

interface SecretRowProps {
  secret: ApiSecretDisplay
  agentSlug: string
  existingEnvVars: string[]
}

function SecretRow({ secret, agentSlug, existingEnvVars }: SecretRowProps) {
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [revealedValue, setRevealedValue] = useState<string | null>(null)
  const revealSecret = useRevealSecretValue()

  const isRevealed = revealedValue !== null
  const handleToggleReveal = async () => {
    if (isRevealed) {
      setRevealedValue(null)
      return
    }
    try {
      const value = await revealSecret.mutateAsync({ agentSlug, secretId: secret.id })
      setRevealedValue(value)
    } catch {
      // Swallow — the mutation surfaces its own error state if needed.
    }
  }

  return (
    <>
      <div
        className="flex items-center gap-3 px-4 py-3"
        data-testid={`secret-row-${secret.envVar}`}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate">{secret.key}</div>
          <div className="text-xs text-muted-foreground font-mono truncate">{secret.envVar}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className="text-sm text-muted-foreground font-mono select-text max-w-[260px] truncate"
            aria-label={isRevealed ? 'Secret value' : 'Hidden value'}
            title={isRevealed ? revealedValue ?? undefined : undefined}
          >
            {isRevealed ? revealedValue : '••••••••••••'}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={() => { void handleToggleReveal() }}
            disabled={revealSecret.isPending}
            aria-label={isRevealed ? 'Hide value' : 'Show value'}
            data-testid={`secret-reveal-${secret.envVar}`}
          >
            {isRevealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          <SecretRowMenu
            onEdit={() => setEditOpen(true)}
            onDelete={() => setDeleteOpen(true)}
            envVar={secret.envVar}
          />
        </div>
      </div>

      <SecretDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        agentSlug={agentSlug}
        existingEnvVars={existingEnvVars}
        secret={secret}
        initialValue={revealedValue}
      />
      <DeleteSecretDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        agentSlug={agentSlug}
        secret={secret}
      />
    </>
  )
}

function SecretRowMenu({
  onEdit,
  onDelete,
  envVar,
}: {
  onEdit: () => void
  onDelete: () => void
  envVar: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          aria-label="More actions"
          data-testid={`secret-menu-${envVar}`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-40 p-1">
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            onEdit()
          }}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted text-left"
        >
          <Pencil className="h-4 w-4" />
          Edit
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            onDelete()
          }}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted text-left text-destructive"
          data-testid={`delete-secret-${envVar}`}
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </button>
      </PopoverContent>
    </Popover>
  )
}

interface SecretDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentSlug: string
  /** Existing env vars on the agent — used for collision detection. */
  existingEnvVars: string[]
  /** When provided, the dialog is in edit mode for this secret. */
  secret?: ApiSecretDisplay
  /** Pre-filled value when editing (e.g. already revealed in the row). */
  initialValue?: string | null
}

function SecretDialog({
  open,
  onOpenChange,
  agentSlug,
  existingEnvVars,
  secret,
  initialValue = null,
}: SecretDialogProps) {
  const isEdit = !!secret
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [valueTouched, setValueTouched] = useState(false)
  const [showValue, setShowValue] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const createSecret = useCreateSecret()
  const updateSecret = useUpdateSecret()
  const revealSecret = useRevealSecretValue()
  const submitting = isEdit ? updateSecret.isPending : createSecret.isPending

  // Initialize / reset fields when the dialog opens. In edit mode also fetch
  // the current value (unless the row already revealed it).
  React.useEffect(() => {
    if (!open) return
    setError(null)
    setShowValue(false)
    setValueTouched(false)
    setKey(secret?.key ?? '')
    if (!isEdit) {
      setValue('')
      return
    }
    if (initialValue !== null) {
      setValue(initialValue)
      return
    }
    setValue('')
    revealSecret
      .mutateAsync({ agentSlug, secretId: secret!.id })
      .then((v) => {
        setValue((current) => (current ? current : v))
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, secret?.id])

  const envVarPreview = key ? keyToEnvVar(key) : ''
  const isRename = isEdit && envVarPreview && envVarPreview !== secret!.envVar
  const isDuplicate =
    !!envVarPreview &&
    existingEnvVars.includes(envVarPreview) &&
    (!isEdit || envVarPreview !== secret!.envVar)
  // A secret is injected as an env var, so reserved runtime vars are blocked
  // here too — the server rejects them, this gives instant feedback (SUP-239).
  const isReserved = !!envVarPreview && isReservedEnvVar(envVarPreview)

  const isLoadingValue = isEdit && revealSecret.isPending && !valueTouched && !value

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!key.trim()) {
      setError('Key is required')
      return
    }
    if (!value) {
      setError('Value is required')
      return
    }
    if (isDuplicate) {
      setError(`A secret with env var "${envVarPreview}" already exists`)
      return
    }
    if (isReserved) {
      setError(`"${envVarPreview}" is a reserved runtime variable and cannot be used as a secret`)
      return
    }
    try {
      if (isEdit) {
        await updateSecret.mutateAsync({
          agentSlug,
          secretId: secret!.id,
          key: key.trim(),
          value,
        })
      } else {
        await createSecret.mutateAsync({ agentSlug, key: key.trim(), value })
      }
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save secret')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{isEdit ? 'Edit Secret' : 'Add Secret'}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? 'Update the key or value for this secret.'
                : 'Secrets are exposed to the agent as environment variables.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="secret-dialog-key">Key</Label>
              <Input
                id="secret-dialog-key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="e.g. My API Key"
                autoFocus
                data-testid="secret-dialog-key"
              />
              {envVarPreview && (
                <p
                  className={`text-xs font-mono ${
                    isDuplicate || isReserved ? 'text-destructive' : 'text-muted-foreground'
                  }`}
                >
                  Env var: {envVarPreview}
                  {isRename && !isDuplicate && !isReserved && ` (was ${secret!.envVar})`}
                  {isDuplicate && ' (duplicate)'}
                  {isReserved && ' (reserved)'}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="secret-dialog-value">Value</Label>
              <div className="relative">
                <Input
                  id="secret-dialog-value"
                  type={showValue ? 'text' : 'password'}
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value)
                    setValueTouched(true)
                  }}
                  placeholder={isLoadingValue ? 'Loading current value...' : 'Secret value'}
                  className="pr-9"
                  disabled={isLoadingValue}
                  data-testid="secret-dialog-value"
                />
                <button
                  type="button"
                  onClick={() => setShowValue((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showValue ? 'Hide value' : 'Show value'}
                >
                  {showValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!key.trim() || !value || isDuplicate || isReserved || submitting || isLoadingValue}
              data-testid="secret-dialog-submit"
            >
              {submitting ? (isEdit ? 'Saving...' : 'Adding...') : isEdit ? 'Save' : 'Add Secret'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface DeleteSecretDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentSlug: string
  secret: ApiSecretDisplay
}

function DeleteSecretDialog({ open, onOpenChange, agentSlug, secret }: DeleteSecretDialogProps) {
  const deleteSecret = useDeleteSecret()

  const handleDelete = async () => {
    await deleteSecret.mutateAsync({ agentSlug, secretId: secret.id })
    onOpenChange(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete secret?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono">{secret.envVar}</span> will no longer be available to this
            agent. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteSecret.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault()
              void handleDelete()
            }}
            disabled={deleteSecret.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleteSecret.isPending ? 'Deleting...' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
