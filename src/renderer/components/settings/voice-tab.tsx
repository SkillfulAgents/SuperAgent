import { useState, useRef, useCallback, useEffect } from 'react'
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
import { AlertTriangle, Eye, EyeOff, Check, Loader2, ExternalLink, Square, Volume2 } from 'lucide-react'
import { createSttAdapter } from '@renderer/lib/stt'
import type { ApiKeyStatus, SttProvider } from '@shared/lib/config/settings'

const STT_PROVIDERS = [
  { value: 'deepgram' as const, label: 'Deepgram', model: 'Nova 3' },
  { value: 'openai' as const, label: 'OpenAI', model: 'GPT-4o Mini Transcribe' },
]

const PROVIDER_CONFIG: Record<SttProvider, {
  envVar: string
  placeholder: string
  validateEndpoint: string
  apiKeyField: 'deepgramApiKey' | 'openaiApiKey'
  statusField: 'deepgram' | 'openai'
  dashboardUrl: string
  dashboardLabel: string
}> = {
  deepgram: {
    envVar: 'DEEPGRAM_API_KEY',
    placeholder: 'Enter your Deepgram API key',
    validateEndpoint: '/api/settings/validate-deepgram-key',
    apiKeyField: 'deepgramApiKey',
    statusField: 'deepgram',
    dashboardUrl: 'https://console.deepgram.com/',
    dashboardLabel: 'Deepgram Console',
  },
  openai: {
    envVar: 'OPENAI_API_KEY',
    placeholder: 'sk-...',
    validateEndpoint: '/api/settings/validate-openai-key',
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
      const res = await apiFetch(config.validateEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKeyInput.trim() }),
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

type TestState = 'idle' | 'connecting' | 'recording'

interface TranscriptSegment {
  id: number
  text: string
}

function WaveformCanvas({ analyserRef }: { analyserRef: React.RefObject<AnalyserNode | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animFrameRef = useRef<number>(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    ctx.scale(dpr, dpr)

    const LINE_COUNT = 48
    const smoothed = new Float32Array(LINE_COUNT).fill(0)
    const DECAY = 0.88
    const RISE = 0.35

    const style = getComputedStyle(canvas)
    const fg = style.getPropertyValue('--foreground').trim()

    function draw() {
      animFrameRef.current = requestAnimationFrame(draw)
      const analyser = analyserRef.current
      if (!canvas || !ctx) return

      const w = rect.width
      const h = rect.height
      const midY = h / 2

      ctx.clearRect(0, 0, w, h)

      if (!analyser) return
      const freqData = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteFrequencyData(freqData)

      const binSize = Math.floor(freqData.length / LINE_COUNT)
      for (let i = 0; i < LINE_COUNT; i++) {
        let sum = 0
        for (let j = 0; j < binSize; j++) {
          sum += freqData[i * binSize + j]
        }
        const target = (sum / binSize) / 255
        smoothed[i] = target > smoothed[i]
          ? smoothed[i] + (target - smoothed[i]) * RISE
          : smoothed[i] * DECAY
      }

      const gap = w / LINE_COUNT
      const lineW = Math.max(1.5, gap * 0.35)

      for (let i = 0; i < LINE_COUNT; i++) {
        const amp = smoothed[i]
        const barH = Math.max(2, amp * h * 0.8)
        const x = gap * (i + 0.5)

        const alpha = 0.15 + amp * 0.65
        ctx.strokeStyle = fg ? `hsl(${fg} / ${alpha})` : `rgba(128, 128, 128, ${alpha})`
        ctx.lineWidth = lineW
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(x, midY - barH / 2)
        ctx.lineTo(x, midY + barH / 2)
        ctx.stroke()
      }
    }

    draw()
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [analyserRef])

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-8"
      style={{ width: '100%', height: '32px' }}
    />
  )
}

function VoiceTest({ provider }: { provider: SttProvider }) {
  const [testState, setTestState] = useState<TestState>('idle')
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [interimText, setInterimText] = useState('')
  const [testError, setTestError] = useState<string | null>(null)
  const nextIdRef = useRef(0)

  const adapterRef = useRef<ReturnType<typeof createSttAdapter> | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)

  const stopTest = useCallback(() => {
    processorRef.current?.disconnect()
    processorRef.current = null
    analyserRef.current = null
    audioCtxRef.current?.close()
    audioCtxRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    adapterRef.current?.close()
    adapterRef.current = null
    setTestState('idle')
    setInterimText('')
    setSegments([])
  }, [])

  const startTest = useCallback(async () => {
    setTestState('connecting')
    setSegments([])
    setInterimText('')
    setTestError(null)
    nextIdRef.current = 0

    try {
      const credRes = await apiFetch(`/api/stt/token?provider=${provider}`)
      const credData = await credRes.json()
      if (!credRes.ok) {
        throw new Error(credData.error || 'Failed to get STT credentials')
      }

      const adapter = createSttAdapter(credData.provider)
      adapterRef.current = adapter
      const sampleRate = adapter.sampleRate ?? 16000

      adapter.onTranscript((event) => {
        if (event.type === 'interim') {
          setInterimText(event.text)
        } else if (event.type === 'final') {
          setInterimText('')
          setSegments(prev => [...prev, {
            id: nextIdRef.current++,
            text: event.text,
          }])
        }
      })

      adapter.onError((err) => {
        setTestError(err.message)
        processorRef.current?.disconnect()
        processorRef.current = null
        analyserRef.current = null
        audioCtxRef.current?.close()
        audioCtxRef.current = null
        streamRef.current?.getTracks().forEach(t => t.stop())
        streamRef.current = null
        adapterRef.current?.close()
        adapterRef.current = null
        setTestState('idle')
      })

      await adapter.connect(credData.token)

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate, echoCancellation: true, noiseSuppression: true },
      })
      streamRef.current = stream

      const audioContext = new AudioContext({ sampleRate })
      audioCtxRef.current = audioContext
      const source = audioContext.createMediaStreamSource(stream)

      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.6
      source.connect(analyser)
      analyserRef.current = analyser

      const processor = audioContext.createScriptProcessor(2048, 1, 1)
      processorRef.current = processor

      processor.onaudioprocess = (e) => {
        if (adapterRef.current) {
          const float32 = e.inputBuffer.getChannelData(0)
          const int16 = new Int16Array(float32.length)
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]))
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
          }
          adapterRef.current.sendAudio(int16.buffer)
        }
      }

      source.connect(processor)
      processor.connect(audioContext.destination)

      setTestState('recording')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Test failed'
      setTestError(message)
      stopTest()
    }
  }, [provider, stopTest])

  const hasContent = segments.length > 0 || interimText

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {testState === 'recording' ? (
          <Button size="sm" variant="destructive" onClick={stopTest}>
            <Square className="h-3 w-3 mr-2" />
            Stop Test
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={startTest}
            disabled={testState === 'connecting'}
          >
            {testState === 'connecting' ? (
              <>
                <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                Connecting...
              </>
            ) : (
              <>
                <Volume2 className="h-3 w-3 mr-2" />
                Test Voice Input
              </>
            )}
          </Button>
        )}
      </div>

      {testState === 'recording' && (
        <div className="rounded-md border bg-muted/30 p-3">
          <WaveformCanvas analyserRef={analyserRef} />
        </div>
      )}

      {(hasContent || testState === 'recording') && (
        <div className="rounded-md border bg-muted/50 p-3 text-sm min-h-[60px] relative overflow-hidden">
          {segments.length === 0 && !interimText && testState === 'recording' && (
            <span className="text-muted-foreground/60 italic animate-pulse">
              Listening... speak now
            </span>
          )}
          {segments.map((seg) => (
            <span
              key={seg.id}
              className="animate-in fade-in slide-in-from-bottom-1 duration-300 inline"
            >
              {seg.text}{' '}
            </span>
          ))}
          {interimText && (
            <span className="text-muted-foreground animate-in fade-in duration-150 inline">
              {interimText}
            </span>
          )}
        </div>
      )}

      {testError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{testError}</AlertDescription>
        </Alert>
      )}
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
            Choose which service to use for voice-to-text transcription. A microphone button will appear in the message input once configured.
          </p>
        </div>
      </div>

      {selectedProvider && (
        <div className="pt-4 border-t space-y-4">
          <h3 className="text-sm font-medium">API Key</h3>
          <SttApiKeyInput provider={selectedProvider} disabled={isLoading} />
        </div>
      )}

      {hasKeyConfigured && selectedProvider && (
        <div className="pt-4 border-t space-y-4">
          <h3 className="text-sm font-medium">Test</h3>
          <p className="text-xs text-muted-foreground">
            Verify your microphone and STT provider are working correctly.
          </p>
          <VoiceTest provider={selectedProvider} />
        </div>
      )}
    </div>
  )
}
