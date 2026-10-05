import type { Page, WebSocketRoute } from '@playwright/test'

/**
 * Speech mocked at the edges the browser talks to: the voice endpoints are
 * answered by page routes, the Deepgram transcription and speech sockets by
 * routeWebSocket mocks the test drives, and the microphone is a silent
 * MediaStream so no real device is asked for.
 */
export interface SpeechMocks {
  /** The open transcription socket, once the page has connected. */
  listen: () => WebSocketRoute | null
  /** Every JSON message the page sent to the speech socket. */
  speakMessages: string[]
  /** Text the reader has asked the synthesizer to say. */
  spokenText: () => string
  /** Feed a transcript result to the page. */
  hear: (transcript: string, options?: { final?: boolean }) => void
  /** The server's silence detection. */
  pause: () => void
  /** Words the server flushes when dictation closes the stream. */
  hearOnClose: (transcript: string) => void
  /** Whether the last microphone the page opened is still capturing. */
  micLive: () => Promise<boolean>
  /** Device id requested for the last microphone capture, or null for system default. */
  micDeviceId: () => Promise<string | null>
}

export async function mockSpeech(page: Page, { supportsTts = true } = {}): Promise<SpeechMocks> {
  await page.route('**/api/voice/configured', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        supportsTts,
        voices: supportsTts ? [{ id: 'aura-2-thalia-en', label: 'Thalia', description: 'Clear, confident, energetic' }] : [],
        defaultVoice: supportsTts ? 'aura-2-thalia-en' : undefined,
      }),
    }),
  )
  await page.route('**/api/voice/token', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ provider: 'deepgram', protocol: 'deepgram', token: 'listen-token' }) }),
  )
  await page.route('**/api/voice/tts-session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'deepgram', connection: { transport: 'websocket', token: 'speak-token' }, voice: 'aura-2-thalia-en', speed: 1 }),
    }),
  )

  // Silent microphones: real capture wiring, no device prompt.
  await page.addInitScript(() => {
    const mediaDevices = navigator.mediaDevices ?? ({} as MediaDevices)
    Object.defineProperty(navigator, 'mediaDevices', { value: mediaDevices, configurable: true })
    mediaDevices.enumerateDevices = async () => [
      { kind: 'audioinput', deviceId: 'built-in-mic', groupId: 'built-in', label: 'Built-in Microphone', toJSON: () => ({}) },
      { kind: 'audioinput', deviceId: 'studio-mic', groupId: 'studio', label: 'Studio Mic', toJSON: () => ({}) },
    ]
    mediaDevices.getUserMedia = async (constraints) => {
      const audio = typeof constraints?.audio === 'object' ? constraints.audio : undefined
      const requestedDeviceId = typeof audio?.deviceId === 'object' && 'exact' in audio.deviceId
        ? String(audio.deviceId.exact)
        : null
      const ctx = new AudioContext()
      const destination = ctx.createMediaStreamDestination()
      const track = destination.stream.getAudioTracks()[0]
      if (track) {
        const getSettings = track.getSettings.bind(track)
        track.getSettings = () => ({ ...getSettings(), deviceId: requestedDeviceId ?? 'built-in-mic' })
      }
      Reflect.set(window, 'lastMicStream', destination.stream)
      Reflect.set(window, 'lastMicDeviceId', requestedDeviceId)
      return destination.stream
    }
  })

  let listen: WebSocketRoute | null = null
  let closingWords = ''
  await page.routeWebSocket(/api\.deepgram\.com\/v1\/listen/, (ws) => {
    listen = ws
    ws.onMessage((message) => {
      if (typeof message !== 'string') return // audio
      const data = JSON.parse(message) as { type?: string }
      if (data.type === 'Finalize') {
        ws.send(JSON.stringify({ type: 'Results', is_final: true, from_finalize: true, channel: { alternatives: [{ transcript: '' }] } }))
      }
      if (data.type === 'CloseStream') {
        if (closingWords) ws.send(JSON.stringify({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: closingWords }] } }))
        closingWords = ''
        void ws.close()
      }
    })
    ws.onClose(() => {
      if (listen === ws) listen = null
    })
  })

  const speakMessages: string[] = []
  await page.routeWebSocket(/api\.deepgram\.com\/v1\/speak/, (ws) => {
    let sequence = 0
    ws.onMessage((message) => {
      if (typeof message !== 'string') return
      speakMessages.push(message)
      const data = JSON.parse(message) as { type?: string }
      // No audio comes back: the reader finishes as each batch is reported flushed.
      if (data.type === 'Flush') ws.send(JSON.stringify({ type: 'Flushed', sequence_id: sequence++ }))
    })
  })

  const send = (payload: unknown) => {
    if (!listen) throw new Error('The page has not opened the transcription socket')
    listen.send(JSON.stringify(payload))
  }
  return {
    listen: () => listen,
    speakMessages,
    spokenText: () =>
      speakMessages
        .map((m) => JSON.parse(m) as { type?: string; text?: string })
        .filter((m) => m.type === 'Speak')
        .map((m) => m.text)
        .join(' '),
    hear: (transcript, { final = false } = {}) =>
      send({ type: 'Results', is_final: final, speech_final: final, channel: { alternatives: [{ transcript }] } }),
    pause: () => send({ type: 'UtteranceEnd' }),
    hearOnClose: (transcript) => { closingWords = transcript },
    micLive: () => page.evaluate(() => {
      const stream: unknown = Reflect.get(window, 'lastMicStream')
      return stream instanceof MediaStream && stream.getTracks().some((track) => track.readyState === 'live')
    }),
    micDeviceId: () => page.evaluate(() => {
      const deviceId: unknown = Reflect.get(window, 'lastMicDeviceId')
      return typeof deviceId === 'string' ? deviceId : null
    }),
  }
}
