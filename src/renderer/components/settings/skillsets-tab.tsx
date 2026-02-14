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
} from '@renderer/hooks/use-skillsets'
import { AlertTriangle, Loader2, Trash2, RefreshCw, Library } from 'lucide-react'

export function SkillsetsTab() {
  const { data: skillsets, isLoading } = useSkillsets()
  const validateSkillset = useValidateSkillset()
  const addSkillset = useAddSkillset()
  const removeSkillset = useRemoveSkillset()
  const refreshSkillset = useRefreshSkillset()

  const [urlInput, setUrlInput] = useState('')
  const [validationResult, setValidationResult] = useState<{
    valid: boolean
    error?: string
  } | null>(null)

  const handleValidateAndAdd = async () => {
    if (!urlInput.trim()) return
    setValidationResult(null)

    try {
      const result = await validateSkillset.mutateAsync(urlInput.trim())

      if (result.valid) {
        await addSkillset.mutateAsync(urlInput.trim())
        setUrlInput('')
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

        {validationResult && !validationResult.valid && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{validationResult.error}</AlertDescription>
          </Alert>
        )}

        <p className="text-xs text-muted-foreground">
          Enter a git repository URL containing an index.json file. Supports HTTPS and SSH URLs.
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
                </div>
                {ss.description && (
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                    {ss.description}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-1 font-mono truncate">
                  {ss.url}
                </p>
              </div>
              <div className="flex gap-1 shrink-0">
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
