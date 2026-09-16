export interface SpeechAudioOutput {
  destination: AudioNode
  ready: Promise<void>
  pause(): void
  resume(): Promise<void>
}

const outputs = new WeakMap<AudioContext, SpeechAudioOutput>()

/**
 * Safari can advance a Web Audio clock without audible device output. Route
 * its PCM graph through the same media-element output used by Live calls.
 * https://bugs.webkit.org/show_bug.cgi?id=291892
 * Prepare this inside the play gesture, before awaiting speech credentials.
 */
export function prepareSpeechAudioOutput(ctx: AudioContext): SpeechAudioOutput {
  const existing = outputs.get(ctx)
  if (existing) return existing
  const safari = typeof navigator !== 'undefined' && /Version\/[\d.]+.*Safari\//.test(navigator.userAgent)
  if (!safari) {
    const output: SpeechAudioOutput = {
      destination: ctx.destination, ready: Promise.resolve(),
      pause: () => {}, resume: () => Promise.resolve(),
    }
    outputs.set(ctx, output)
    return output
  }

  const destination = ctx.createMediaStreamDestination()
  const audio = new Audio()
  audio.autoplay = true
  audio.setAttribute('playsinline', '')
  audio.srcObject = destination.stream
  // Keep the element attached for Safari's media lifecycle, but it has no UI.
  audio.hidden = true
  document.body.append(audio)
  let disposed = false
  let playGeneration = 0
  const pause = () => {
    ++playGeneration
    // Silence the media sink before freezing its upstream Web Audio clock.
    audio.muted = true
    audio.pause()
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    ctx.removeEventListener('statechange', onStateChange)
    pause()
    audio.srcObject = null
    destination.stream.getTracks().forEach(track => track.stop())
    audio.remove()
    outputs.delete(ctx)
  }
  const onStateChange = () => { if (ctx.state === 'closed') dispose() }
  ctx.addEventListener('statechange', onStateChange)
  const resume = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    const generation = ++playGeneration
    audio.muted = false
    let playing: Promise<void>
    try { playing = audio.play() } catch (error) { playing = Promise.reject(error) }
    return playing.catch(() => {
      // Pausing/closing can abort a pending play; it is not an autoplay denial.
      if (disposed || generation !== playGeneration) return
      throw new Error('Audio playback was blocked by Safari. Allow audio for this site, then try Read aloud again.')
    })
  }
  const ready = resume()
  // Credentials may still be loading; the player observes this same rejection
  // when it adopts the context. Avoid an unhandled rejection in the meantime.
  void ready.catch(() => {})
  const output = { destination, ready, pause, resume }
  outputs.set(ctx, output)
  return output
}
