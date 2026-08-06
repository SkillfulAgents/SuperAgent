import { useState } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import {
  useSkillsets,
  useValidateSkillset,
  useAddSkillset,
  useRemoveSkillset,
  useRefreshSkillset,
  useUpdateSkillsetCredential,
} from '@renderer/hooks/use-skillsets'
import {
  AlertTriangle,
  ExternalLink,
  KeyRound,
  Loader2,
  Trash2,
  RefreshCw,
  Library,
  X,
} from 'lucide-react'

export function SkillsetsTab() {
  const { data: skillsets, isLoading } = useSkillsets()
  const validateSkillset = useValidateSkillset()
  const addSkillset = useAddSkillset()
  const removeSkillset = useRemoveSkillset()
  const refreshSkillset = useRefreshSkillset()
  const updateCredential = useUpdateSkillsetCredential()
  const [urlInput, setUrlInput] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [editingCredentialId, setEditingCredentialId] = useState<string | null>(null)
  const [replacementToken, setReplacementToken] = useState('')
  const [validationResult, setValidationResult] = useState<{
    valid: boolean
    error?: string
  } | null>(null)

  const handleValidateAndAdd = async () => {
    if (!urlInput.trim()) return
    setValidationResult(null)

    try {
      const input = { url: urlInput.trim(), token: tokenInput.trim() || undefined }
      const result = await validateSkillset.mutateAsync(input)

      if (result.valid) {
        await addSkillset.mutateAsync(input)
        setUrlInput('')
        setTokenInput('')
        setValidationResult(null)
      } else {
        setValidationResult({ valid: false, error: result.error })
      }
    } catch (error) {
      setValidationResult({
        valid: false,
        error: error instanceof Error ? error.message : 'Failed to add skillset',
      })
    }
  }

  const isBusy = validateSkillset.isPending || addSkillset.isPending

  const handleSaveCredential = async (id: string) => {
    if (!replacementToken.trim()) return
    setValidationResult(null)
    try {
      await updateCredential.mutateAsync({ id, token: replacementToken.trim() })
      setReplacementToken('')
      setEditingCredentialId(null)
    } catch (error) {
      setValidationResult({
        valid: false,
        error: error instanceof Error ? error.message : 'Failed to update repository token',
      })
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium mb-1">Skillsets</h3>
        <p className="text-xs text-muted-foreground">
          Add skillset repositories to discover and install skills for your agents.
        </p>
      </div>

      {/* Add Skillset Form */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <Input
            placeholder="https://github.com/org/skillset-repo"
            value={urlInput}
            onChange={(e) => {
              setUrlInput(e.target.value)
              setValidationResult(null)
            }}
            disabled={isBusy}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleValidateAndAdd()
              }
            }}
          />
          <Button
            onClick={handleValidateAndAdd}
            disabled={!urlInput.trim() || isBusy}
            size="sm"
          >
            {isBusy ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Validating...
              </>
            ) : (
              'Add'
            )}
          </Button>
        </div>

        <Input
          type="password"
          autoComplete="off"
          aria-label="Repository token (optional)"
          placeholder="Repository token (optional, for private GitHub repositories)"
          value={tokenInput}
          onChange={(e) => {
            setTokenInput(e.target.value)
            setValidationResult(null)
          }}
          disabled={isBusy}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleValidateAndAdd()
            }
          }}
        />

        <div className="rounded-md border bg-muted/30 p-3 text-xs">
          <p className="font-medium">Private GitHub repository token</p>
          <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-muted-foreground">
            <li>
              <a
                href="https://github.com/settings/personal-access-tokens/new"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                Create a fine-grained personal access token
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>{' '}
              and choose the repository owner.
            </li>
            <li>
              Under <span className="font-medium text-foreground">Repository access</span>, choose{' '}
              <span className="font-medium text-foreground">Only select repositories</span> and
              select this skillset repository.
            </li>
            <li>
              Under <span className="font-medium text-foreground">Repository permissions</span>,
              set <span className="font-medium text-foreground">Contents</span> to{' '}
              <span className="font-medium text-foreground">Read-only</span>. GitHub adds Metadata
              read access automatically.
            </li>
            <li>Generate the token and paste it above.</li>
          </ol>
          <p className="mt-2 text-muted-foreground">
            This minimum permission supports discovering, installing, and refreshing skills. A
            classic token also works with the broader{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-foreground">repo</code> scope, but a
            fine-grained token is recommended. Publishing pull requests requires additional write
            and fork permissions. If GitHub marks an organization token as pending, an organization
            owner must approve it before it can read private repositories.
          </p>
        </div>

        {validationResult && !validationResult.valid && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{validationResult.error}</AlertDescription>
          </Alert>
        )}

        <p className="text-xs text-muted-foreground">
          Enter a git repository URL containing an index.json file. Private GitHub repositories
          must use an HTTPS URL.
        </p>
      </div>

      {/* Skillset List */}
      <div className="space-y-3">
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !skillsets || skillsets.length === 0 ? (
          <div className="text-center py-6">
            <Library className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">No skillsets configured yet.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Add a skillset repository URL above to get started.
            </p>
          </div>
        ) : (
          skillsets.map((ss) => (
            <div
              key={ss.id}
              className="flex items-start gap-3 p-3 rounded-lg border bg-card"
            >
              <Library className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium truncate">{ss.name}</p>
                  <span className="text-xs text-muted-foreground">
                    {ss.skillCount} {ss.skillCount === 1 ? 'skill' : 'skills'}
                  </span>
                  {ss.badgeLabel && (
                    <span className="text-2xs px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                      {ss.badgeLabel}
                    </span>
                  )}
                  {ss.credential && (
                    <span className="text-2xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                      Private · {ss.credential.tokenPreview}
                    </span>
                  )}
                </div>
                {ss.description && (
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                    {ss.description}
                  </p>
                )}
                {ss.showUrl && (
                  <p className="text-xs text-muted-foreground mt-1 font-mono truncate">
                    {ss.url}
                  </p>
                )}
                {ss.error && (
                  <div className="flex items-start gap-1.5 mt-1.5">
                    <AlertTriangle className="h-3 w-3 mt-0.5 text-destructive shrink-0" />
                    <p className="text-xs text-destructive line-clamp-2">{ss.error}</p>
                  </div>
                )}
                {editingCredentialId === ss.id && (
                  <div className="flex items-center gap-2 mt-2">
                    <Input
                      type="password"
                      autoComplete="off"
                      aria-label={`Repository token for ${ss.name}`}
                      placeholder={ss.credential ? 'Replace repository token' : 'Add repository token'}
                      value={replacementToken}
                      onChange={(e) => setReplacementToken(e.target.value)}
                      className="h-8"
                      disabled={updateCredential.isPending}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          handleSaveCredential(ss.id)
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      className="h-8"
                      disabled={!replacementToken.trim() || updateCredential.isPending}
                      onClick={() => handleSaveCredential(ss.id)}
                    >
                      Save
                    </Button>
                    {ss.credential && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8"
                        disabled={updateCredential.isPending}
                        onClick={() => updateCredential.mutate({ id: ss.id, token: null })}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                )}
              </div>
              <div className="flex gap-1 shrink-0">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => {
                    const nextId = editingCredentialId === ss.id ? null : ss.id
                    setEditingCredentialId(nextId)
                    setReplacementToken('')
                    setValidationResult(null)
                  }}
                  disabled={updateCredential.isPending || (ss.provider ?? 'github') !== 'github'}
                  title={ss.credential ? 'Replace or remove repository token' : 'Add repository token'}
                >
                  {editingCredentialId === ss.id ? <X className="h-3.5 w-3.5" /> : <KeyRound className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => refreshSkillset.mutate(ss.id)}
                  disabled={refreshSkillset.isPending}
                  title="Refresh skillset"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${refreshSkillset.isPending ? 'animate-spin' : ''}`} />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  onClick={() => removeSkillset.mutate(ss.id)}
                  disabled={removeSkillset.isPending}
                  title="Remove skillset"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
