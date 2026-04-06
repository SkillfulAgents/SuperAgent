import { useState } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { PasswordInput } from '@renderer/components/ui/password-input'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { apiFetch } from '@renderer/lib/api'
import { AlertTriangle, Check, Loader2, ChevronRight } from 'lucide-react'
import type { ApiKeyStatus } from '@shared/lib/config/settings'

interface BedrockCredentialsInputProps {
  showNotConfiguredAlert?: boolean
  disabled?: boolean
}

export function BedrockCredentialsInput({
  showNotConfiguredAlert = true,
  disabled = false,
}: BedrockCredentialsInputProps) {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()

  const [showAdvanced, setShowAdvanced] = useState(false)
  const [isValidating, setIsValidating] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)
  const [validationResult, setValidationResult] = useState<{ valid: boolean; error?: string } | null>(null)

  // Simple auth fields
  const [apiKeyInput, setApiKeyInput] = useState('')

  // Advanced auth fields
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')

  // Region (shared)
  const [region, setRegion] = useState('')

  const apiKeyStatus: ApiKeyStatus | undefined = settings?.apiKeyStatus?.bedrock
  const isBusy = isValidating || isRemoving

  const handleValidateSimple = async () => {
    if (!apiKeyInput.trim()) return
    setIsValidating(true)
    setValidationResult(null)
    try {
      const res = await apiFetch('/api/settings/validate-llm-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'bedrock', apiKey: apiKeyInput.trim() }),
      })
      const result = await res.json()
      setValidationResult(result)
      if (result.valid) {
        await updateSettings.mutateAsync({
          apiKeys: {
            bedrockApiKey: apiKeyInput.trim(),
            ...(region.trim() && { bedrockRegion: region.trim() }),
          },
        })
        setApiKeyInput('')
      }
    } catch {
      setValidationResult({ valid: false, error: 'Failed to validate' })
    } finally {
      setIsValidating(false)
    }
  }

  const handleValidateAdvanced = async () => {
    if (!accessKeyId.trim() || !secretAccessKey.trim()) return
    setIsValidating(true)
    setValidationResult(null)
    try {
      const res = await apiFetch('/api/settings/validate-bedrock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessKeyId: accessKeyId.trim(),
          secretAccessKey: secretAccessKey.trim(),
          region: region.trim() || 'us-east-1',
        }),
      })
      const result = await res.json()
      setValidationResult(result)
      if (result.valid) {
        await updateSettings.mutateAsync({
          apiKeys: {
            bedrockAccessKeyId: accessKeyId.trim(),
            bedrockSecretAccessKey: secretAccessKey.trim(),
            bedrockRegion: region.trim() || 'us-east-1',
          },
        })
        setAccessKeyId('')
        setSecretAccessKey('')
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
        apiKeys: {
          bedrockApiKey: '',
          bedrockAccessKeyId: '',
          bedrockSecretAccessKey: '',
          bedrockRegion: '',
        },
      })
      setValidationResult(null)
    } catch (error) {
      console.error('Failed to remove credentials:', error)
    } finally {
      setIsRemoving(false)
    }
  }

  return (
    <div className="space-y-3">
      <Label>AWS Bedrock Credentials</Label>

      {apiKeyStatus?.isConfigured && (
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
            No Bedrock credentials configured. Enter a Bedrock API Key or AWS credentials below.
          </AlertDescription>
        </Alert>
      )}

      {/* Region (always shown) */}
      <div className="space-y-1">
        <Label htmlFor="bedrock-region" className="text-xs">AWS Region</Label>
        <Input
          id="bedrock-region"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          placeholder="us-east-1"
          disabled={disabled || isBusy}
        />
      </div>

      {!showAdvanced ? (
        <>
          {/* Simple: Bedrock API Key */}
          <div className="space-y-1">
            <Label htmlFor="bedrock-api-key" className="text-xs">Bedrock API Key</Label>
            <PasswordInput
              id="bedrock-api-key"
              value={apiKeyInput}
              onChange={(e) => { setApiKeyInput(e.target.value); setValidationResult(null) }}
              placeholder={apiKeyStatus?.isConfigured ? '••••••••••••••••' : 'Enter Bedrock API key...'}
              disabled={disabled || isBusy}
            />
          </div>

          <button
            type="button"
            onClick={() => setShowAdvanced(true)}
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            <ChevronRight className="h-3 w-3" />
            Use AWS Access Key credentials instead
          </button>

          <div className="flex gap-2">
            {apiKeyInput.trim() && (
              <Button size="sm" onClick={handleValidateSimple} disabled={isBusy}>
                {isValidating ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Validating...</> : 'Validate & Save'}
              </Button>
            )}
            {apiKeyStatus?.source === 'settings' && (
              <Button size="sm" variant="outline" onClick={handleRemove} disabled={isBusy}>
                {isRemoving ? 'Removing...' : 'Remove Saved Credentials'}
              </Button>
            )}
          </div>
        </>
      ) : (
        <>
          {/* Advanced: AWS Access Key + Secret */}
          <div className="space-y-1">
            <Label htmlFor="bedrock-access-key" className="text-xs">AWS Access Key ID</Label>
            <Input
              id="bedrock-access-key"
              value={accessKeyId}
              onChange={(e) => { setAccessKeyId(e.target.value); setValidationResult(null) }}
              placeholder={apiKeyStatus?.isConfigured ? '••••••••••••••••' : 'AKIA...'}
              disabled={disabled || isBusy}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bedrock-secret-key" className="text-xs">AWS Secret Access Key</Label>
            <PasswordInput
              id="bedrock-secret-key"
              value={secretAccessKey}
              onChange={(e) => { setSecretAccessKey(e.target.value); setValidationResult(null) }}
              placeholder={apiKeyStatus?.isConfigured ? '••••••••••••••••' : 'Enter secret key...'}
              disabled={disabled || isBusy}
            />
          </div>

          <button
            type="button"
            onClick={() => setShowAdvanced(false)}
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            <ChevronRight className="h-3 w-3 rotate-180" />
            Use Bedrock API Key instead
          </button>

          <div className="flex gap-2">
            {accessKeyId.trim() && secretAccessKey.trim() && (
              <Button size="sm" onClick={handleValidateAdvanced} disabled={isBusy}>
                {isValidating ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Validating...</> : 'Validate & Save'}
              </Button>
            )}
            {apiKeyStatus?.source === 'settings' && (
              <Button size="sm" variant="outline" onClick={handleRemove} disabled={isBusy}>
                {isRemoving ? 'Removing...' : 'Remove Saved Credentials'}
              </Button>
            )}
          </div>
        </>
      )}

      {validationResult && (
        <Alert variant={validationResult.valid ? 'default' : 'destructive'}>
          {validationResult.valid ? <Check className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          <AlertDescription>
            {validationResult.valid
              ? 'Credentials are valid and have been saved.'
              : validationResult.error || 'Invalid credentials'}
          </AlertDescription>
        </Alert>
      )}

      <p className="text-xs text-muted-foreground">
        {apiKeyStatus?.source === 'settings'
          ? 'Your credentials are saved locally. Enter new ones to replace them.'
          : apiKeyStatus?.source === 'env'
            ? 'Save credentials here to override the environment variables.'
            : 'Credentials will be saved locally in ~/.superagent/settings.json'}
      </p>
    </div>
  )
}
