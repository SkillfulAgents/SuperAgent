import { useState, type ReactNode } from 'react'
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
import { PasswordInput } from '@renderer/components/ui/password-input'
import { RequestError } from '@renderer/components/messages/request-error'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { apiFetch } from '@renderer/lib/api'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import type { ApiKeyStatus, LlmProviderId } from '@shared/lib/config/settings'

interface ProviderApiKeyInputProps {
  providerId: LlmProviderId | string
  label: string
  placeholder?: string
  envVarName?: string
  apiKeySettingsField: string
  /** Key in settings.apiKeyStatus to read status from. Defaults to providerId. */
  apiKeyStatusKey?: string
  /** POST endpoint for key validation. */
  validationEndpoint?: string
  /** Build the validation request body. Receives the trimmed key. Defaults to `{ provider, apiKey }`. */
  validationBody?: (apiKey: string) => Record<string, unknown>
  showSourceIndicator?: boolean
  showNotConfiguredAlert?: boolean
  showHelpText?: boolean
  showRemoveButton?: boolean
  /** Whether to show a confirmation dialog before removing. */
  showRemoveConfirm?: boolean
  /** Custom help text node. When provided, replaces the default help text. */
  helpText?: ReactNode
  /** Custom label for the validate button. Defaults to "Validate & Save". */
  validateButtonLabel?: string
  disabled?: boolean
}

export function ProviderApiKeyInput({
  providerId,
  label,
  placeholder = 'Enter API key...',
  envVarName,
  apiKeySettingsField,
  apiKeyStatusKey,
  validationEndpoint = '/api/settings/validate-llm-key',
  validationBody,
  showSourceIndicator = true,
  showNotConfiguredAlert = true,
  showHelpText = true,
  showRemoveButton = true,
  showRemoveConfirm = true,
  helpText,
  validateButtonLabel = 'Validate & Save',
  disabled = false,
}: ProviderApiKeyInputProps) {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()

  const [apiKeyInput, setApiKeyInput] = useState('')
  const [isValidating, setIsValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<{ valid: boolean; error?: string } | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)
  const [showRemoveDialog, setShowRemoveDialog] = useState(false)

  const statusMap = settings?.apiKeyStatus as Record<string, ApiKeyStatus> | undefined
  const apiKeyStatus: ApiKeyStatus | undefined = statusMap?.[apiKeyStatusKey ?? providerId]

  const handleValidateAndSave = async () => {
    if (!apiKeyInput.trim()) return
    setIsValidating(true)
    setValidationResult(null)

    try {
      const body = validationBody
        ? validationBody(apiKeyInput.trim())
        : { provider: providerId, apiKey: apiKeyInput.trim() }
      const res = await apiFetch(validationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = await res.json()
      setValidationResult(result)

      if (result.valid) {
        await updateSettings.mutateAsync({
          apiKeys: { [apiKeySettingsField]: apiKeyInput.trim() },
        })
        setApiKeyInput('')
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
      setShowRemoveDialog(false)
    } catch (error) {
      console.error('Failed to remove API key:', error)
    } finally {
      setIsRemoving(false)
    }
  }

  const isBusy = isValidating || isRemoving
  const idPrefix = `${providerId}-api-key`

  const defaultHelpText = apiKeyStatus?.source === 'settings'
    ? 'Your API key is saved locally. Enter a new key to replace it.'
    : apiKeyStatus?.source === 'env'
      ? 'Save a key here to override the environment variable.'
      : 'Your API key will be saved locally in ~/.superagent/settings.json'

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={idPrefix} className="font-normal text-muted-foreground">{label}</Label>
        {showSourceIndicator && apiKeyStatus?.isConfigured && (
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
        )}
      </div>

      {showNotConfiguredAlert && !apiKeyStatus?.isConfigured && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            No API key configured.{envVarName && <> Set <code className="bg-muted px-1 rounded">{envVarName}</code> environment variable or enter below.</>}
          </AlertDescription>
        </Alert>
      )}

      <PasswordInput
        id={idPrefix}
        value={apiKeyInput}
        onChange={(e) => {
          setApiKeyInput(e.target.value)
          setValidationResult(null)
        }}
        placeholder={apiKeyStatus?.isConfigured ? '••••••••••••••••' : placeholder}
        disabled={disabled || isBusy}
        className="bg-background"
      />

      {validationResult && !validationResult.valid && (
        <RequestError message={validationResult.error || 'Invalid API key'} />
      )}
      {validationResult?.valid && (
        <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
          <Check className="h-3 w-3" />
          API key is valid and has been saved.
        </p>
      )}

      {showHelpText && (
        <p className="text-xs text-muted-foreground">
          {helpText ?? defaultHelpText}
        </p>
      )}

      <div className="flex justify-end gap-2">
        {apiKeyInput.trim() && (
          <Button size="sm" onClick={handleValidateAndSave} disabled={isBusy}>
            {isValidating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Validating...
              </>
            ) : (
              validateButtonLabel
            )}
          </Button>
        )}
        {showRemoveButton && apiKeyStatus?.source === 'settings' && (
          <Button
            size="sm"
            variant="outline"
            onClick={showRemoveConfirm ? () => setShowRemoveDialog(true) : handleRemoveApiKey}
            disabled={isBusy}
          >
            {isRemoving ? 'Removing...' : 'Remove Saved Key'}
          </Button>
        )}
      </div>

      {showRemoveConfirm && (
        <AlertDialog open={showRemoveDialog} onOpenChange={setShowRemoveDialog}>
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
      )}
    </div>
  )
}
