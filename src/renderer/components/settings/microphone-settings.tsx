import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, Mic, RefreshCw, Square } from 'lucide-react'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { acquireMicStream } from '@renderer/lib/voice/shared/audio-capture'
import {
  getPreferredMicrophoneDeviceId,
  listMicrophoneDevices,
  setPreferredMicrophoneDeviceId,
  type MicrophoneDeviceOption,
} from '@renderer/lib/voice/shared/microphone-device'

const SYSTEM_DEFAULT = 'system-default'

type TestStatus = 'idle' | 'starting' | 'testing'

interface TestSession {
  stream: MediaStream
  context: AudioContext
  source: MediaStreamAudioSourceNode
  frame: number
}

function microphoneError(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was denied. Allow access in your browser or system settings and try again.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone is available.'
  }
  if (name === 'NotReadableError') {
    return 'The microphone is unavailable or already in use by another application.'
  }
  return error instanceof Error ? error.message : 'Could not start the microphone test.'
}

export function MicrophoneSettings() {
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  const [selectedDeviceId, setSelectedDeviceId] = useState(getPreferredMicrophoneDeviceId)
  const [devices, setDevices] = useState<MicrophoneDeviceOption[]>([])
  const [hasEnumerated, setHasEnumerated] = useState(false)
  const [status, setStatus] = useState<TestStatus>('idle')
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [usingFallback, setUsingFallback] = useState(false)
  const sessionRef = useRef<TestSession | null>(null)
  const testRunRef = useRef(0)

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await listMicrophoneDevices())
    } catch {
      setDevices([])
    } finally {
      setHasEnumerated(true)
    }
  }, [])

  const releaseTest = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    cancelAnimationFrame(session.frame)
    session.source.disconnect()
    void session.context.close()
    session.stream.getTracks().forEach((track) => track.stop())
    sessionRef.current = null
  }, [])

  const stopTest = useCallback(() => {
    testRunRef.current += 1
    releaseTest()
    setStatus('idle')
    setLevel(0)
    setUsingFallback(false)
  }, [releaseTest])

  useEffect(() => {
    if (!supported) {
      setHasEnumerated(true)
      return
    }

    void refreshDevices()
    const handleDeviceChange = () => { void refreshDevices() }
    navigator.mediaDevices.addEventListener?.('devicechange', handleDeviceChange)
    return () => navigator.mediaDevices.removeEventListener?.('devicechange', handleDeviceChange)
  }, [refreshDevices, supported])

  useEffect(() => () => {
    testRunRef.current += 1
    releaseTest()
  }, [releaseTest])

  const startTest = async () => {
    const run = ++testRunRef.current
    setStatus('starting')
    setError(null)
    setUsingFallback(false)
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    let source: MediaStreamAudioSourceNode | null = null

    try {
      stream = await acquireMicStream()
      if (testRunRef.current !== run) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      context = new AudioContext()
      if (context.state === 'suspended') await context.resume()
      if (testRunRef.current !== run) {
        void context.close()
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)

      const samples = new Uint8Array(analyser.fftSize)
      const updateLevel = () => {
        analyser.getByteTimeDomainData(samples)
        let energy = 0
        for (const sample of samples) {
          const normalized = (sample - 128) / 128
          energy += normalized * normalized
        }
        setLevel(Math.min(1, Math.sqrt(energy / samples.length) * 4))
        const session = sessionRef.current
        if (session) session.frame = requestAnimationFrame(updateLevel)
      }

      const frame = requestAnimationFrame(updateLevel)
      sessionRef.current = { stream, context, source, frame }
      const activeDeviceId = stream.getAudioTracks()[0]?.getSettings().deviceId
      setUsingFallback(!!selectedDeviceId && !!activeDeviceId && activeDeviceId !== selectedDeviceId)
      setStatus('testing')
      await refreshDevices()
    } catch (caught) {
      source?.disconnect()
      if (context) void context.close()
      stream?.getTracks().forEach((track) => track.stop())
      if (testRunRef.current !== run) return
      setStatus('idle')
      setError(microphoneError(caught))
    }
  }

  const unavailableSelection = hasEnumerated
    && !!selectedDeviceId
    && !devices.some((device) => device.deviceId === selectedDeviceId)

  return (
    <div className="space-y-4" data-testid="microphone-settings">
      <h3 className="text-sm font-medium">Microphone</h3>
      <div className="space-y-2">
        <Label htmlFor="microphone-device">Input device</Label>
        <div className="flex items-center gap-2">
          <Select
            value={selectedDeviceId ?? SYSTEM_DEFAULT}
            disabled={!supported || status !== 'idle'}
            onValueChange={(value) => {
              const deviceId = value === SYSTEM_DEFAULT ? null : value
              setPreferredMicrophoneDeviceId(deviceId)
              setSelectedDeviceId(deviceId)
              setError(null)
            }}
          >
            <SelectTrigger id="microphone-device" className="min-w-0 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SYSTEM_DEFAULT}>System default</SelectItem>
              {unavailableSelection && selectedDeviceId && (
                <SelectItem value={selectedDeviceId}>Saved microphone (not currently listed)</SelectItem>
              )}
              {devices.map((device) => (
                <SelectItem key={device.deviceId} value={device.deviceId}>{device.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label="Refresh microphones"
            disabled={!supported || status !== 'idle'}
            onClick={() => { void refreshDevices() }}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Used for dictation and voice mode on this device. Choose System default to follow your computer&apos;s input setting.
        </p>
        {unavailableSelection && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            The saved microphone is not currently listed. The system default will be used if it cannot be opened.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!supported || status === 'starting'}
            onClick={() => { if (status === 'testing') stopTest(); else void startTest() }}
          >
            {status === 'starting' ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : status === 'testing' ? (
              <Square className="h-4 w-4 mr-2 fill-current" />
            ) : (
              <Mic className="h-4 w-4 mr-2" />
            )}
            {status === 'starting' ? 'Starting test...' : status === 'testing' ? 'Stop test' : 'Test microphone'}
          </Button>
          {status === 'testing' && (
            <div
              className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="Microphone input level"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(level * 100)}
            >
              <div className="h-full bg-primary transition-[width] duration-75" style={{ width: `${Math.max(2, level * 100)}%` }} />
            </div>
          )}
        </div>
        {usingFallback && (
          <p className="text-xs text-amber-700 dark:text-amber-300">Testing the system default because the saved microphone is unavailable.</p>
        )}
        {!supported && (
          <p className="text-xs text-muted-foreground">Microphone access is not supported in this browser.</p>
        )}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
