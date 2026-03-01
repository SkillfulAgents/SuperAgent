import { useState } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { apiFetch } from '@renderer/lib/api'
import { AlertTriangle, Eye, EyeOff, Check, Loader2 } from 'lucide-react'
import type { ApiKeyStatus } from '@shared/lib/config/settings'

interface ComposioApiKeyInputProps {
  /** HTML id prefix for input elements */
  idPrefix?: string
  /** Whether to show the source indicator badge (e.g. "Using saved setting") */
  showSourceIndicator?: boolean
  /** Whether to show the help text below the input */
  showHelpText?: boolean
  /** Whether to show the "Remove Saved Key" button */
  showRemoveButton?: boolean
  /** Whether the input is disabled */
  disabled?: boolean
}

export function ComposioApiKeyInput({
  idPrefix = 'composio-api-key',
  showSourceIndicator = true,
  showHelpText = true,
  showRemoveButton = true,
  disabled = false,
}: ComposioApiKeyInputProps) {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()

  const [apiKeyInput, setApiKeyInput] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [isValidating, setIsValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<{ valid: boolean; error?: string } | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)

  const apiKeyStatus: ApiKeyStatus | undefined = settings?.apiKeyStatus?.composio

  const handleValidateAndSave = async () => {
    if (!apiKeyInput.trim()) return
    setIsValidating(true)
    setValidationResult(null)

    try {
      const res = await apiFetch('/api/settings/validate-composio-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKeyInput.trim() }),
      })
      const result = await res.json()
      setValidationResult(result)

      if (result.valid) {
        await updateSettings.mutateAsync({
          apiKeys: { composioApiKey: apiKeyInput.trim() },
        })
        setApiKeyInput('')
        setShowApiKey(false)
      }
    } catch {
      setValidationResult({ valid: false, error: 'Failed to validate API key' })
    } finally {
      setIsValidating(false)
    }
  }

  const handleRemoveApiKey = async () => {
    setIsRemoving(true)
    try {
      await updateSettings.mutateAsync({
        apiKeys: { composioApiKey: '' },
      })
      setValidationResult(null)
    } catch (error) {
      console.error('Failed to remove API key:', error)
    } finally {
      setIsRemoving(false)
    }
  }

  const isBusy = isValidating || isRemoving

  return (
    <div className="space-y-2">
      <Label htmlFor={idPrefix}>Composio API Key</Label>

      {/* Source indicator */}
      {showSourceIndicator && apiKeyStatus?.isConfigured && (
        <div className="flex items-center gap-2">
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${
              apiKeyStatus.source === 'settings'
                ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                : 'bg-blue-500/10 text-blue-700 dark:text-blue-400'
            }`}
          >
            {apiKeyStatus.source === 'settings'
              ? 'Using saved setting'
              : 'Using environment variable'}
          </span>
        </div>
      )}

      {/* Input with show/hide toggle */}
      <div className="relative">
        <Input
          id={idPrefix}
          type={showApiKey ? 'text' : 'password'}
          value={apiKeyInput}
          onChange={(e) => {
            setApiKeyInput(e.target.value)
            setValidationResult(null)
          }}
          placeholder={apiKeyStatus?.isConfigured ? '••••••••••••••••' : 'Enter Composio API key'}
          className="pr-10"
          disabled={disabled || isBusy}
        />
        <button
          type="button"
          onClick={() => setShowApiKey(!showApiKey)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          disabled={disabled || isBusy}
        >
          {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>

      {/* Validation result */}
      {validationResult && (
        <Alert variant={validationResult.valid ? 'default' : 'destructive'}>
          {validationResult.valid ? (
            <Check className="h-4 w-4" />
          ) : (
            <AlertTriangle className="h-4 w-4" />
          )}
          <AlertDescription>
            {validationResult.valid
              ? 'API key is valid and has been saved.'
              : validationResult.error || 'Invalid API key'}
          </AlertDescription>
        </Alert>
      )}

      {/* Help text */}
      {showHelpText && (
        <p className="text-xs text-muted-foreground">
          Get your API key from{' '}
          <a
            href="https://app.composio.dev/settings"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-4"
          >
            Composio Dashboard
          </a>
        </p>
      )}

      {/* Validate & Save / Remove buttons */}
      <div className="flex gap-2">
        {apiKeyInput.trim() && (
          <Button size="sm" onClick={handleValidateAndSave} disabled={isBusy}>
            {isValidating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Validating...
              </>
            ) : (
              'Validate & Save'
            )}
          </Button>
        )}
        {showRemoveButton && apiKeyStatus?.source === 'settings' && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleRemoveApiKey}
            disabled={isBusy}
          >
            {isRemoving ? 'Removing...' : 'Remove Saved Key'}
          </Button>
        )}
      </div>
    </div>
  )
}
