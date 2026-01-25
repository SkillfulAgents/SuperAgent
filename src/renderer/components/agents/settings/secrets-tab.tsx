
import * as React from 'react'
import { Plus, Trash2, Eye, EyeOff } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import {
  useAgentSecrets,
  useCreateSecret,
  useUpdateSecret,
  useDeleteSecret,
  type ApiSecretDisplay,
} from '@renderer/hooks/use-secrets'

// Convert a display key to an environment variable name (preview)
function keyToEnvVar(key: string): string {
  return key
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
}

interface SecretRowProps {
  secret: ApiSecretDisplay
  agentSlug: string
  onDelete: () => void
}

function SecretRow({ secret, agentSlug, onDelete }: SecretRowProps) {
  const [isEditing, setIsEditing] = React.useState(false)
  const [newValue, setNewValue] = React.useState('')
  const [showValue, setShowValue] = React.useState(false)
  const updateSecret = useUpdateSecret()
  const deleteSecret = useDeleteSecret()

  const handleSaveValue = async () => {
    if (!newValue) return
    await updateSecret.mutateAsync({
      agentSlug,
      secretId: secret.id,
      value: newValue,
    })
    setNewValue('')
    setIsEditing(false)
  }

  const handleDelete = async () => {
    await deleteSecret.mutateAsync({ agentSlug, secretId: secret.id })
    onDelete()
  }

  return (
    <div className="flex items-center gap-3 p-3 border rounded-lg">
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{secret.key}</div>
        <div className="text-xs text-muted-foreground font-mono">{secret.envVar}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {isEditing ? (
          <>
            <div className="relative">
              <Input
                type={showValue ? 'text' : 'password'}
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="New value"
                className="w-40 pr-8"
              />
              <button
                type="button"
                onClick={() => setShowValue(!showValue)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showValue ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            <Button
              size="sm"
              onClick={handleSaveValue}
              disabled={!newValue || updateSecret.isPending}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setIsEditing(false)
                setNewValue('')
              }}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <span className="text-sm text-muted-foreground">••••••••</span>
            <Button size="sm" variant="outline" onClick={() => setIsEditing(true)}>
              Update
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleDelete}
              disabled={deleteSecret.isPending}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

interface AddSecretFormProps {
  agentSlug: string
  existingEnvVars: string[]
  onAdd: () => void
}

function AddSecretForm({ agentSlug, existingEnvVars, onAdd }: AddSecretFormProps) {
  const [key, setKey] = React.useState('')
  const [value, setValue] = React.useState('')
  const [showValue, setShowValue] = React.useState(false)
  const [error, setError] = React.useState('')
  const createSecret = useCreateSecret()

  const envVarPreview = key ? keyToEnvVar(key) : ''
  const isDuplicate = envVarPreview && existingEnvVars.includes(envVarPreview)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!key.trim() || !value) {
      setError('Both key and value are required')
      return
    }

    if (isDuplicate) {
      setError(`A secret with env var name "${envVarPreview}" already exists`)
      return
    }

    try {
      await createSecret.mutateAsync({ agentSlug, key: key.trim(), value })
      setKey('')
      setValue('')
      onAdd()
    } catch (err: any) {
      setError(err.message || 'Failed to create secret')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 p-3 border rounded-lg bg-muted/30">
      <div className="text-sm font-medium">Add New Secret</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="secret-key" className="text-xs">
            Key Name
          </Label>
          <Input
            id="secret-key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="e.g., My API Key"
          />
          {envVarPreview && (
            <div className={`text-xs font-mono ${isDuplicate ? 'text-destructive' : 'text-muted-foreground'}`}>
              Env var: {envVarPreview}
              {isDuplicate && ' (duplicate)'}
            </div>
          )}
        </div>
        <div className="space-y-1">
          <Label htmlFor="secret-value" className="text-xs">
            Value
          </Label>
          <div className="relative">
            <Input
              id="secret-value"
              type={showValue ? 'text' : 'password'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Secret value"
              className="pr-8"
            />
            <button
              type="button"
              onClick={() => setShowValue(!showValue)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showValue ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </div>
      {error && <div className="text-sm text-destructive">{error}</div>}
      <Button
        type="submit"
        size="sm"
        disabled={!key.trim() || !value || isDuplicate || createSecret.isPending}
      >
        <Plus className="h-4 w-4 mr-1" />
        {createSecret.isPending ? 'Adding...' : 'Add Secret'}
      </Button>
    </form>
  )
}

interface SecretsTabProps {
  agentSlug: string
  isOpen: boolean
}

export function SecretsTab({ agentSlug, isOpen }: SecretsTabProps) {
  const { data: secrets = [], refetch: refetchSecrets } = useAgentSecrets(isOpen ? agentSlug : null)
  const existingEnvVars = secrets.map((s) => s.envVar)

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Secrets are passed as environment variables to the agent container.
        Keys are converted to uppercase with underscores (e.g., &quot;My API Key&quot; becomes &quot;MY_API_KEY&quot;).
      </p>
      <AddSecretForm
        agentSlug={agentSlug}
        existingEnvVars={existingEnvVars}
        onAdd={() => refetchSecrets()}
      />
      {secrets.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium">Existing Secrets</div>
          {secrets.map((secret) => (
            <SecretRow
              key={secret.id}
              secret={secret}
              agentSlug={agentSlug}
              onDelete={() => refetchSecrets()}
            />
          ))}
        </div>
      )}
      {secrets.length === 0 && (
        <div className="text-sm text-muted-foreground text-center py-4">
          No secrets configured yet.
        </div>
      )}
    </div>
  )
}
