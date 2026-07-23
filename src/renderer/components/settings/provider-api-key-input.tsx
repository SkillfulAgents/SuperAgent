import { useState, type ReactNode } from 'react'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
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
import { cn } from '@shared/lib/utils/cn'
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
  /** Custom label for the validate button. Defaults to "Save" (validation
      happens implicitly; failures surface inline). */
  validateButtonLabel?: string
  disabled?: boolean
  /** 'rows' puts label + help text left, input right (settings card rows).
      'stacked' (default) keeps label-above-input for narrow containers. */
  layout?: 'stacked' | 'rows'
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
  validateButtonLabel = 'Save',
  disabled = false,
  layout = 'stacked',
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
      : 'Key saved locally, on-device'

  const rows = layout === 'rows'

  const labelBlock = (
    <div className={rows ? 'min-w-0 flex-1' : 'space-y-0.5'}>
      <div className="flex items-center gap-2">
        <Label htmlFor={idPrefix} className="text-xs font-medium text-foreground">{label}</Label>
        {showSourceIndicator && apiKeyStatus?.isConfigured && (
          <span
            className={`text-[11px] px-2 py-0.5 rounded-full ${
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
      {showHelpText && (
        <p className={cn('text-[11px] text-muted-foreground', rows && 'mt-0.5')}>
          {helpText ?? defaultHelpText}
        </p>
      )}
    </div>
  )

  const hasInput = !!apiKeyInput.trim()

  const inputRow = (
    // No gap here: the validate button animates its width from zero, and a flex
    // gap would leave a phantom 8px next to the collapsed button. Spacing lives
    // inside/on the buttons instead.
    <div className={cn('flex items-center', rows && 'shrink-0 w-full md:w-auto')}>
      <div className={rows ? 'min-w-0 w-full md:w-[340px]' : 'flex-1 min-w-0'}>
        <PasswordInput
          id={idPrefix}
          value={apiKeyInput}
          onChange={(e) => {
            setApiKeyInput(e.target.value)
            setValidationResult(null)
          }}
          placeholder={apiKeyStatus?.isConfigured ? '••••••••••••••••' : placeholder}
          disabled={disabled || isBusy}
          className={cn('bg-background', rows && 'h-8')}
        />
      </div>
      {/* Always mounted; slides in via the 0fr→1fr grid-columns trick so the
          input eases over instead of jumping when typing starts. */}
      <div
        className={cn(
          'grid transition-[grid-template-columns,opacity] duration-200 ease-in-out',
          hasInput
            ? 'grid-cols-[1fr] opacity-100'
            : 'grid-cols-[0fr] opacity-0 pointer-events-none',
        )}
        aria-hidden={hasInput ? undefined : true}
      >
        <div className="overflow-hidden min-w-0">
          <Button
            size="sm"
            onClick={handleValidateAndSave}
            disabled={isBusy || !hasInput}
            tabIndex={hasInput ? undefined : -1}
            className="ml-2 whitespace-nowrap"
          >
            {isValidating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Validating...
              </>
            ) : (
              validateButtonLabel
            )}
          </Button>
        </div>
      </div>
      {showRemoveButton && apiKeyStatus?.source === 'settings' && !hasInput && (
        <Button
          size="sm"
          variant="outline"
          onClick={showRemoveConfirm ? () => setShowRemoveDialog(true) : handleRemoveApiKey}
          disabled={isBusy}
          className="ml-2"
        >
          {isRemoving ? 'Removing...' : 'Remove Saved Key'}
        </Button>
      )}
    </div>
  )

  return (
    <div className="space-y-2">
      {rows ? (
        <div className="flex flex-col items-stretch gap-3 md:flex-row md:items-center">
          {labelBlock}
          {inputRow}
        </div>
      ) : (
        <>
          {labelBlock}
          {inputRow}
        </>
      )}

      {validationResult?.valid && (
        <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
          <Check className="h-3 w-3" />
          API key is valid and has been saved.
        </p>
      )}

      {validationResult && !validationResult.valid && (
        <RequestError
          message={validationResult.error || 'Invalid API key'}
          variant="compact"
        />
      )}

      {showNotConfiguredAlert && !apiKeyStatus?.isConfigured && (
        <div className="flex gap-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <p>
            No API key configured.{envVarName && <> Set <code className="bg-red-100 dark:bg-red-900/40 px-1 rounded">{envVarName}</code> environment variable or enter above.</>}
          </p>
        </div>
      )}

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
