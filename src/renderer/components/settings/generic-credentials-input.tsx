import { useState } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { PasswordInput } from '@renderer/components/ui/password-input'
import { RequestError } from '@renderer/components/messages/request-error'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { apiFetch } from '@renderer/lib/api'
import { Check, Loader2 } from 'lucide-react'
import type { ApiKeyStatus } from '@shared/lib/config/settings'

interface GenericCredentialsInputProps {
  disabled?: boolean
}

/**
 * Credentials for the generic provider: a user-supplied Anthropic-wire endpoint
 * (baseURL) plus an API key. Both are validated together via the shared
 * validate-llm-key endpoint before being saved.
 */
export function GenericCredentialsInput({ disabled = false }: GenericCredentialsInputProps) {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()

  const [baseUrl, setBaseUrl] = useState('')
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [isValidating, setIsValidating] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)
  const [validationResult, setValidationResult] = useState<{ valid: boolean; error?: string } | null>(null)

  const apiKeyStatus: ApiKeyStatus | undefined = settings?.apiKeyStatus?.generic
  const isBusy = isValidating || isRemoving

  const handleValidateAndSave = async () => {
    const trimmedUrl = baseUrl.trim()
    const trimmedKey = apiKeyInput.trim()
    if (!trimmedUrl || !trimmedKey) return
    setIsValidating(true)
    setValidationResult(null)
    try {
      const res = await apiFetch('/api/settings/validate-llm-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'generic', apiKey: trimmedKey, baseUrl: trimmedUrl }),
      })
      const result = await res.json()
      setValidationResult(result)
      if (result.valid) {
        await updateSettings.mutateAsync({
          apiKeys: { genericBaseUrl: trimmedUrl, genericApiKey: trimmedKey },
        })
        setApiKeyInput('')
      }
    } catch {
      setValidationResult({ valid: false, error: 'Failed to validate' })
    } finally {
      setIsValidating(false)
    }
  }

  const handleRemove = async () => {
    setIsRemoving(true)
    try {
      await updateSettings.mutateAsync({
        apiKeys: { genericBaseUrl: '', genericApiKey: '' },
      })
      setBaseUrl('')
      setApiKeyInput('')
      setValidationResult(null)
    } catch (error) {
      console.error('Failed to remove credentials:', error)
    } finally {
      setIsRemoving(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Label>Custom endpoint</Label>
        {apiKeyStatus?.isConfigured && (
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${
              apiKeyStatus.source === 'settings'
                ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                : 'bg-blue-500/10 text-blue-700 dark:text-blue-400'
            }`}
          >
            {apiKeyStatus.source === 'settings' ? 'Using saved setting' : 'Using environment variable'}
          </span>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Point at any Anthropic-compatible endpoint (a self-hosted gateway or a LiteLLM/proxy in
        Anthropic mode). Add your models below in the catalog editor. ollama&apos;s native API is
        OpenAI-compatible, so front it with an Anthropic-compatible proxy.
      </p>

      <div className="space-y-1">
        <Label htmlFor="generic-base-url" className="font-normal text-muted-foreground">Base URL</Label>
        <Input
          id="generic-base-url"
          value={baseUrl}
          onChange={(e) => { setBaseUrl(e.target.value); setValidationResult(null) }}
          placeholder="http://localhost:4000"
          disabled={disabled || isBusy}
          className="bg-background"
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="generic-api-key" className="font-normal text-muted-foreground">API Key</Label>
        <PasswordInput
          id="generic-api-key"
          value={apiKeyInput}
          onChange={(e) => { setApiKeyInput(e.target.value); setValidationResult(null) }}
          placeholder={apiKeyStatus?.isConfigured ? '••••••••••••••••' : 'Enter API key...'}
          disabled={disabled || isBusy}
          className="bg-background"
        />
      </div>

      <div className="flex gap-2">
        {baseUrl.trim() && apiKeyInput.trim() && (
          <Button size="sm" onClick={handleValidateAndSave} disabled={isBusy}>
            {isValidating ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Validating...</> : 'Validate & Save'}
          </Button>
        )}
        {apiKeyStatus?.source === 'settings' && (
          <Button size="sm" variant="outline" onClick={handleRemove} disabled={isBusy}>
            {isRemoving ? 'Removing...' : 'Remove Saved Credentials'}
          </Button>
        )}
      </div>

      {validationResult && !validationResult.valid && (
        <RequestError message={validationResult.error || 'Invalid credentials'} variant="compact" />
      )}
      {validationResult?.valid && (
        <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
          <Check className="h-3 w-3" />
          Credentials are valid and have been saved.
        </p>
      )}
    </div>
  )
}
