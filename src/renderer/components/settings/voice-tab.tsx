import { useState, useCallback } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { apiFetch } from '@renderer/lib/api'
import { AlertTriangle, Eye, EyeOff, Check, Loader2, ExternalLink } from 'lucide-react'
import { useVoiceInput } from '@renderer/hooks/use-voice-input'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import type { ApiKeyStatus, SttProvider } from '@shared/lib/config/settings'

const STT_PROVIDERS = [
  {
    value: 'deepgram' as const,
    label: 'Deepgram',
    model: 'Nova 3',
    docsUrl: 'https://developers.deepgram.com/docs/models-languages-overview',
    note: 'Lowest latency (~200ms). 47 languages supported.',
  },
  {
    value: 'openai' as const,
    label: 'OpenAI',
    model: 'GPT-4o Mini Transcribe',
    docsUrl: 'https://platform.openai.com/docs/guides/speech-to-text#supported-languages',
    note: 'Most accurate & affordable. 57 languages supported.',
  },
]

const PROVIDER_CONFIG: Record<SttProvider, {
  envVar: string
  placeholder: string
  apiKeyField: 'deepgramApiKey' | 'openaiApiKey'
  statusField: 'deepgram' | 'openai'
  dashboardUrl: string
  dashboardLabel: string
}> = {
  deepgram: {
    envVar: 'DEEPGRAM_API_KEY',
    placeholder: 'Enter your Deepgram API key',
    apiKeyField: 'deepgramApiKey',
    statusField: 'deepgram',
    dashboardUrl: 'https://console.deepgram.com/',
    dashboardLabel: 'Deepgram Console',
  },
  openai: {
    envVar: 'OPENAI_API_KEY',
    placeholder: 'sk-...',
    apiKeyField: 'openaiApiKey',
    statusField: 'openai',
    dashboardUrl: 'https://platform.openai.com/api-keys',
    dashboardLabel: 'OpenAI Dashboard',
  },
}

function SttApiKeyInput({ provider, disabled }: { provider: SttProvider; disabled: boolean }) {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()
  const config = PROVIDER_CONFIG[provider]

  const [apiKeyInput, setApiKeyInput] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [isValidating, setIsValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<{ valid: boolean; error?: string } | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)

  const apiKeyStatus: ApiKeyStatus | undefined = settings?.apiKeyStatus?.[config.statusField]
  const isBusy = isValidating || isRemoving

  const handleValidateAndSave = async () => {
    if (!apiKeyInput.trim()) return
    setIsValidating(true)
    setValidationResult(null)

    try {
      const res = await apiFetch('/api/settings/validate-stt-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey: apiKeyInput.trim() }),
      })
      const result = await res.json()
      setValidationResult(result)

      if (result.valid) {
        await updateSettings.mutateAsync({
          apiKeys: { [config.apiKeyField]: apiKeyInput.trim() },
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
        apiKeys: { [config.apiKeyField]: '' },
      })
      setValidationResult(null)
    } catch (error) {
      console.error('Failed to remove API key:', error)
    } finally {
      setIsRemoving(false)
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={`${provider}-api-key`}>
        {STT_PROVIDERS.find(p => p.value === provider)?.label} API Key
      </Label>

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

      <div className="relative">
        <Input
          id={`${provider}-api-key`}
          type={showApiKey ? 'text' : 'password'}
          value={apiKeyInput}
          onChange={(e) => {
            setApiKeyInput(e.target.value)
            setValidationResult(null)
          }}
          placeholder={apiKeyStatus?.isConfigured ? '••••••••••••••••' : config.placeholder}
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

      <p className="text-xs text-muted-foreground">
        {apiKeyStatus?.source === 'settings'
          ? 'Your API key is saved locally. Enter a new key to replace it.'
          : apiKeyStatus?.source === 'env'
            ? `Save a key here to override the ${config.envVar} environment variable.`
            : (
              <>
                Get your API key from the{' '}
                <a
                  href={config.dashboardUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  {config.dashboardLabel}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
      </p>

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
        {apiKeyStatus?.source === 'settings' && (
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

function VoiceTest() {
  const [transcript, setTranscript] = useState('')

  const voiceInput = useVoiceInput({
    onTranscriptUpdate: useCallback((text: string) => {
      setTranscript(text)
    }, []),
  })

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <VoiceInputButton voiceInput={voiceInput} message="" size="sm" />
        <span className="text-sm text-muted-foreground">
          {voiceInput.isConnecting
            ? 'Connecting...'
            : voiceInput.isRecording
              ? 'Listening — speak now'
              : 'Click to test voice input'}
        </span>
      </div>

      {(transcript || voiceInput.isRecording) && (
        <div className="rounded-md border bg-muted/50 p-3 text-sm min-h-[60px]">
          {!transcript && voiceInput.isRecording && (
            <span className="text-muted-foreground/60 italic animate-pulse">
              Listening... speak now
            </span>
          )}
          {transcript}
        </div>
      )}

      <VoiceInputError error={voiceInput.error} onDismiss={voiceInput.clearError} />
    </div>
  )
}

const VALID_PROVIDERS = new Set(STT_PROVIDERS.map(p => p.value))

export function VoiceTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const rawProvider = settings?.voice?.sttProvider
  const selectedProvider = rawProvider && VALID_PROVIDERS.has(rawProvider) ? rawProvider : undefined

  const hasKeyConfigured = selectedProvider && (
    (selectedProvider === 'deepgram' && settings?.apiKeyStatus?.deepgram?.isConfigured) ||
    (selectedProvider === 'openai' && settings?.apiKeyStatus?.openai?.isConfigured)
  )

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <h3 className="text-sm font-medium">Speech-to-Text Provider</h3>
        <div className="space-y-2">
          <Label htmlFor="stt-provider">Provider</Label>
          <Select
            value={selectedProvider ?? ''}
            onValueChange={(value) => {
              updateSettings.mutate({ voice: { sttProvider: value as SttProvider } })
            }}
            disabled={isLoading}
          >
            <SelectTrigger id="stt-provider">
              <SelectValue placeholder="Select a provider" />
            </SelectTrigger>
            <SelectContent>
              {STT_PROVIDERS.map((provider) => (
                <SelectItem key={provider.value} value={provider.value}>
                  {provider.label}
                  <span className="text-muted-foreground ml-2">({provider.model})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Choose which service to use for voice-to-text transcription.
          </p>
          {selectedProvider && (() => {
            const info = STT_PROVIDERS.find(p => p.value === selectedProvider)
            if (!info) return null
            return (
              <p className="text-xs text-muted-foreground">
                {info.note}{' '}
                <a
                  href={info.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-0.5"
                >
                  View details
                  <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            )
          })()}
        </div>
      </div>

      {selectedProvider && (
        <div className="pt-4 border-t space-y-4">
          <h3 className="text-sm font-medium">API Key</h3>
          <SttApiKeyInput key={selectedProvider} provider={selectedProvider} disabled={isLoading} />
        </div>
      )}

      {hasKeyConfigured && selectedProvider && (
        <div className="pt-4 border-t space-y-4">
          <h3 className="text-sm font-medium">Test</h3>
          <p className="text-xs text-muted-foreground">
            Verify your microphone and STT provider are working correctly.
          </p>
          <VoiceTest />
        </div>
      )}
    </div>
  )
}
