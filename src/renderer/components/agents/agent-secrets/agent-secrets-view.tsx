import { useEffect, useRef, useState, type FormEvent } from 'react'
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
import { keyToEnvVar } from '@shared/lib/utils/secrets'
import { cn } from '@shared/lib/utils/cn'
import { useUser } from '@renderer/context/user-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import {
  useAgentSecrets,
  useCreateSecret,
  useUpdateSecret,
  useDeleteSecret,
  useRevealSecretValue,
  type ApiSecretDisplay,
} from '@renderer/hooks/use-secrets'
import { useRenderTracker } from '@renderer/lib/perf'

interface AgentSecretsViewProps {
  agentSlug: string
}

export function AgentSecretsView({ agentSlug }: AgentSecretsViewProps) {
  useRenderTracker('AgentSecretsView')
  const navigate = useNavigate()
  const { track } = useAnalyticsTracking()
  const { isAuthMode, rolesReady, canAdminAgent } = useUser()
  const canManage = !isAuthMode || (rolesReady && canAdminAgent(agentSlug))
  const {
    data: secrets = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useAgentSecrets(canManage ? agentSlug : null)
  const [secretDialog, setSecretDialog] = useState<{
    open: boolean
    secret?: ApiSecretDisplay
  }>({ open: false })
  const [deletingSecret, setDeletingSecret] = useState<ApiSecretDisplay | null>(null)
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({})
  const [revealingSecretIds, setRevealingSecretIds] = useState<Set<string>>(() => new Set())
  const [revealErrors, setRevealErrors] = useState<Record<string, string>>({})
  const revealSecret = useRevealSecretValue()
  const activeAgentRef = useRef(agentSlug)

  useEffect(() => {
    track('secrets_viewed', { agentSlug })
  }, [track, agentSlug])

  useEffect(() => {
    activeAgentRef.current = agentSlug
    setSecretDialog({ open: false })
    setDeletingSecret(null)
    setRevealedValues({})
    setRevealingSecretIds(new Set())
    setRevealErrors({})
    revealSecret.reset()
    // The mutation object is intentionally excluded: resetting it changes its
    // observer state and must not retrigger this agent-change cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentSlug])

  const toggleReveal = async (secret: ApiSecretDisplay) => {
    if (Object.prototype.hasOwnProperty.call(revealedValues, secret.id)) {
      setRevealedValues((values) => {
        const next = { ...values }
        delete next[secret.id]
        return next
      })
      setRevealErrors((errors) => {
        if (!Object.prototype.hasOwnProperty.call(errors, secret.id)) return errors
        const next = { ...errors }
        delete next[secret.id]
        return next
      })
      revealSecret.reset()
      return
    }

    const requestedAgent = agentSlug
    setRevealErrors((errors) => {
      if (!Object.prototype.hasOwnProperty.call(errors, secret.id)) return errors
      const next = { ...errors }
      delete next[secret.id]
      return next
    })
    setRevealingSecretIds((ids) => new Set(ids).add(secret.id))
    try {
      const value = await revealSecret.mutateAsync({ agentSlug, secretId: secret.id })
      if (activeAgentRef.current === requestedAgent) {
        setRevealedValues((values) => ({ ...values, [secret.id]: value }))
      }
    } catch (error) {
      if (activeAgentRef.current === requestedAgent) {
        setRevealErrors((errors) => ({
          ...errors,
          [secret.id]: error instanceof Error ? error.message : 'Failed to reveal secret',
        }))
      }
    } finally {
      revealSecret.reset()
      if (activeAgentRef.current === requestedAgent) {
        setRevealingSecretIds((ids) => {
          const next = new Set(ids)
          next.delete(secret.id)
          return next
        })
      }
    }
  }

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
            onClick={() => setSecretDialog({ open: true })}
            disabled={!canManage || isLoading || isError}
            data-testid="secrets-add-button"
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Add Secret
          </Button>
        }
      />

      <div className="space-y-4">
        {isAuthMode && !rolesReady ? (
          <p className="text-sm text-muted-foreground">Checking permissions...</p>
        ) : !canManage ? (
          <div className="rounded-xl border bg-background px-6 py-10 text-center">
            <p className="text-sm font-medium">Owner access required</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
              Only agent owners can view and manage saved secrets.
            </p>
          </div>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading secrets...</p>
        ) : isError ? (
          <div className="rounded-xl border bg-background px-6 py-10 text-center" role="alert">
            <p className="text-sm font-medium">Couldn&apos;t load secrets</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
              {error instanceof Error ? error.message : 'Please try again.'}
            </p>
            <Button size="sm" variant="outline" className="mt-4" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        ) : secrets.length === 0 ? (
          <EmptyState onAdd={() => setSecretDialog({ open: true })} />
        ) : (
          <SecretsTable
            secrets={secrets}
            revealedValues={revealedValues}
            revealingSecretIds={revealingSecretIds}
            revealErrors={revealErrors}
            onToggleReveal={(secret) => void toggleReveal(secret)}
            onEdit={(secret) => setSecretDialog({ open: true, secret })}
            onDelete={setDeletingSecret}
          />
        )}

        {canManage && !isError && secrets.length > 0 && (
          <SecretsHelpText className="pt-2" />
        )}
      </div>

      {canManage && (
        <SecretDialog
          open={secretDialog.open}
          onOpenChange={(open) =>
            setSecretDialog((current) => ({ ...current, open }))
          }
          agentSlug={agentSlug}
          existingEnvVars={secrets.map((s) => s.envVar)}
          secret={secretDialog.secret}
          onSaved={(value, updated) => {
            const previous = secretDialog.secret
            if (!previous) return
            setRevealErrors((errors) => {
              if (!Object.prototype.hasOwnProperty.call(errors, previous.id)) return errors
              const next = { ...errors }
              delete next[previous.id]
              return next
            })
            setRevealedValues((values) => {
              if (!Object.prototype.hasOwnProperty.call(values, previous.id)) return values
              const next = { ...values }
              const previousValue = next[previous.id]
              delete next[previous.id]
              next[updated.id] = value ?? previousValue
              return next
            })
          }}
        />
      )}
      {deletingSecret && (
        <DeleteSecretDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeletingSecret(null)
          }}
          agentSlug={agentSlug}
          secret={deletingSecret}
          onDeleted={() => {
            setRevealErrors((errors) => {
              if (!Object.prototype.hasOwnProperty.call(errors, deletingSecret.id)) return errors
              const next = { ...errors }
              delete next[deletingSecret.id]
              return next
            })
            setRevealedValues((values) => {
              const next = { ...values }
              delete next[deletingSecret.id]
              return next
            })
            setDeletingSecret(null)
          }}
        />
      )}
    </SettingsPageContainer>
  )
}

function SecretsHelpText({ className = '' }: { className?: string }) {
  return (
    <p className={`text-xs text-muted-foreground ${className}`}>
      Store API keys, tokens etc. securely. Secrets are passed as environment variables to the
      agent container. (Formatting:{' '}
      <code className="font-mono">`My API Key` becomes `MY_API_KEY`</code>).
    </p>
  )
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-xl border border-dashed bg-background px-6 py-10 text-center">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
        <KeyRound className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
      </div>
      <p className="text-sm font-medium">No secrets yet</p>
      <SecretsHelpText className="mx-auto mt-1 max-w-md" />
      <Button size="sm" className="mt-4" onClick={onAdd}>
        <Plus className="h-4 w-4 mr-1.5" />
        Add Secret
      </Button>
    </div>
  )
}

interface SecretsTableProps {
  secrets: ApiSecretDisplay[]
  revealedValues: Record<string, string>
  revealingSecretIds: Set<string>
  revealErrors: Record<string, string>
  onToggleReveal: (secret: ApiSecretDisplay) => void
  onEdit: (secret: ApiSecretDisplay) => void
  onDelete: (secret: ApiSecretDisplay) => void
}

function SecretsTable({
  secrets,
  revealedValues,
  revealingSecretIds,
  revealErrors,
  onToggleReveal,
  onEdit,
  onDelete,
}: SecretsTableProps) {
  return (
    <div className="rounded-xl border bg-background overflow-hidden">
      <div className="divide-y divide-border/50">
        {secrets.map((secret) => (
          <SecretRow
            key={secret.id}
            secret={secret}
            revealedValue={revealedValues[secret.id]}
            isRevealing={revealingSecretIds.has(secret.id)}
            revealError={revealErrors[secret.id]}
            onToggleReveal={() => onToggleReveal(secret)}
            onEdit={() => onEdit(secret)}
            onDelete={() => onDelete(secret)}
          />
        ))}
      </div>
    </div>
  )
}

interface SecretRowProps {
  secret: ApiSecretDisplay
  revealedValue?: string
  isRevealing: boolean
  revealError?: string
  onToggleReveal: () => void
  onEdit: () => void
  onDelete: () => void
}

function SecretRow({
  secret,
  revealedValue,
  isRevealing,
  revealError,
  onToggleReveal,
  onEdit,
  onDelete,
}: SecretRowProps) {
  const isRevealed = revealedValue !== undefined
  return (
    <div data-testid={`secret-row-${secret.envVar}`}>
      <div className="flex items-center gap-3 px-4 py-3">
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
            title={isRevealed ? revealedValue : undefined}
          >
            {isRevealed ? revealedValue : '••••••••••••'}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={onToggleReveal}
            disabled={isRevealing}
            aria-label={isRevealed ? 'Hide value' : 'Show value'}
            data-testid={`secret-reveal-${secret.envVar}`}
          >
            {isRevealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          <SecretRowMenu onEdit={onEdit} onDelete={onDelete} envVar={secret.envVar} />
        </div>
      </div>
      {revealError && (
        <p
          className="px-4 pb-3 text-xs text-destructive"
          role="alert"
          data-testid={`secret-reveal-error-${secret.envVar}`}
        >
          Couldn&apos;t reveal {secret.key}: {revealError}
        </p>
      )}
    </div>
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
  /** Keep an already-revealed row synchronized after a successful edit. */
  onSaved?: (value: string | undefined, secret: ApiSecretDisplay) => void
}

function SecretDialog({
  open,
  onOpenChange,
  agentSlug,
  existingEnvVars,
  secret,
  onSaved,
}: SecretDialogProps) {
  const isEdit = !!secret
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [valueTouched, setValueTouched] = useState(false)
  const [showValue, setShowValue] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const createSecret = useCreateSecret()
  const updateSecret = useUpdateSecret()
  const submitting = isEdit ? updateSecret.isPending : createSecret.isPending

  // Keep the edit target in the parent after close so the title does not flip
  // during the exit animation, while clearing any typed plaintext immediately.
  useEffect(() => {
    if (!open) {
      setKey('')
      setValue('')
      setValueTouched(false)
      setShowValue(false)
      setError(null)
      return
    }
    setError(null)
    setShowValue(false)
    setValueTouched(false)
    setKey(secret?.key ?? '')
    setValue('')
  }, [open, agentSlug, secret?.id, secret?.key])

  const envVarPreview = key ? keyToEnvVar(key) : ''
  const isInvalidKey = !!key.trim() && !envVarPreview
  const isRename = isEdit && envVarPreview && envVarPreview !== secret!.envVar
  const isKeyChanged = isEdit && key.trim() !== secret!.key
  const isDuplicate =
    !!envVarPreview &&
    existingEnvVars.includes(envVarPreview) &&
    (!isEdit || envVarPreview !== secret!.envVar)
  // A secret is injected as an env var, so reserved runtime vars are blocked
  // here too — the server rejects them, this gives instant feedback (SUP-239).
  const isReserved = !!envVarPreview && isReservedEnvVar(envVarPreview)
  const valueChanged = valueTouched && value.length > 0
  const hasChanges = !isEdit || isKeyChanged || valueChanged

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!key.trim()) {
      setError('Key is required')
      return
    }
    if (isInvalidKey) {
      setError('Key must contain at least one letter or number')
      return
    }
    if (!isEdit && !value) {
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
        const updated = await updateSecret.mutateAsync({
          agentSlug,
          secretId: secret!.id,
          ...(isKeyChanged ? { key: key.trim() } : {}),
          ...(valueChanged ? { value } : {}),
        })
        onSaved?.(valueChanged ? value : undefined, updated)
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
      <DialogContent data-testid="secret-dialog">
        <form onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
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
                autoComplete="off"
                data-testid="secret-dialog-key"
              />
              {!!key.trim() && (
                <p
                  className={`text-xs font-mono ${
                    isInvalidKey || isDuplicate || isReserved
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                  }`}
                >
                  Env var: {envVarPreview || '(invalid)'}
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
                  type="text"
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value)
                    setValueTouched(true)
                  }}
                  placeholder={isEdit ? 'Leave blank to keep current value' : 'Secret value'}
                  className={cn('pr-9', !showValue && '[-webkit-text-security:disc]')}
                  autoComplete="off"
                  data-1p-ignore="true"
                  data-bwignore="true"
                  data-form-type="other"
                  data-lpignore="true"
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
              disabled={
                !key.trim() ||
                isInvalidKey ||
                (!isEdit && !value) ||
                !hasChanges ||
                isDuplicate ||
                isReserved ||
                submitting
              }
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
  onDeleted: () => void
}

function DeleteSecretDialog({ open, onOpenChange, agentSlug, secret, onDeleted }: DeleteSecretDialogProps) {
  const deleteSecret = useDeleteSecret()

  const handleDelete = async () => {
    try {
      await deleteSecret.mutateAsync({ agentSlug, secretId: secret.id })
      onDeleted()
    } catch {
      // The global mutation handler presents the error and the dialog remains open.
    }
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
