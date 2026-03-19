import { useState } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
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
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { apiFetch } from '@renderer/lib/api'
import { AlertTriangle, Eye, EyeOff, Check, Loader2 } from 'lucide-react'
import type { ApiKeyStatus, LlmProviderId } from '@shared/lib/config/settings'

interface ProviderApiKeyInputProps {
  providerId: LlmProviderId
  label: string
  placeholder?: string
  envVarName?: string
  apiKeySettingsField: 'anthropicApiKey' | 'openrouterApiKey' | 'bedrockApiKey'
  showSourceIndicator?: boolean
  showNotConfiguredAlert?: boolean
  showHelpText?: boolean
  showRemoveButton?: boolean
  disabled?: boolean
}

export function ProviderApiKeyInput({
  providerId,
  label,
  placeholder = 'Enter API key...',
  envVarName,
  apiKeySettingsField,
  showSourceIndicator = true,
  showNotConfiguredAlert = true,
  showHelpText = true,
  showRemoveButton = true,
  disabled = false,
}: ProviderApiKeyInputProps) {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()

  const [apiKeyInput, setApiKeyInput] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [isValidating, setIsValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<{ valid: boolean; error?: string } | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false)

  const apiKeyStatus: ApiKeyStatus | undefined = settings?.apiKeyStatus?.[providerId]

  const handleValidateAndSave = async () => {
    if (!apiKeyInput.trim()) return
    setIsValidating(true)
    setValidationResult(null)

    try {
      const res = await apiFetch('/api/settings/validate-llm-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId, apiKey: apiKeyInput.trim() }),
      })
      const result = await res.json()
      setValidationResult(result)

      if (result.valid) {
        await updateSettings.mutateAsync({
          apiKeys: { [apiKeySettingsField]: apiKeyInput.trim() },
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
        apiKeys: { [apiKeySettingsField]: '' },
      })
      setValidationResult(null)
      setShowRemoveConfirm(false)
    } catch (error) {
      console.error('Failed to remove API key:', error)
    } finally {
      setIsRemoving(false)
    }
  }

  const isBusy = isValidating || isRemoving
  const idPrefix = `${providerId}-api-key`

  return (
    <div className="space-y-2">
      <Label htmlFor={idPrefix}>{label}</Label>

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

      {showNotConfiguredAlert && !apiKeyStatus?.isConfigured && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            No API key configured.{envVarName && <> Set <code className="bg-muted px-1 rounded">{envVarName}</code> environment variable or enter below.</>}
          </AlertDescription>
        </Alert>
      )}

      <div className="relative">
        <Input
          id={idPrefix}
          type={showApiKey ? 'text' : 'password'}
          value={apiKeyInput}
          onChange={(e) => {
            setApiKeyInput(e.target.value)
            setValidationResult(null)
          }}
          placeholder={apiKeyStatus?.isConfigured ? '••••••••••••••••' : placeholder}
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

      {showHelpText && (
        <p className="text-xs text-muted-foreground">
          {apiKeyStatus?.source === 'settings'
            ? 'Your API key is saved locally. Enter a new key to replace it.'
            : apiKeyStatus?.source === 'env'
              ? 'Save a key here to override the environment variable.'
              : 'Your API key will be saved locally in ~/.superagent/settings.json'}
        </p>
      )}

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
            onClick={() => setShowRemoveConfirm(true)}
            disabled={isBusy}
          >
            {isRemoving ? 'Removing...' : 'Remove Saved Key'}
          </Button>
        )}
      </div>

      <AlertDialog open={showRemoveConfirm} onOpenChange={setShowRemoveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Saved Key</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove the saved API key? This will disable agent features until a new key is configured.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRemoving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemoveApiKey}
              disabled={isRemoving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRemoving ? 'Removing...' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
