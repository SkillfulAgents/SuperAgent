import { readLevel, smoothLevel } from './dot-orb'

/**
 * A voice split into log-spaced frequency bands, for voice mode's sound bars:
 * the same reading as the iOS call screen's (`VoiceSpectrumMeter`). Each band
 * is the voice's overall level scaled by how strong that band is against the
 * loudest one, so the bars stand as tall as the voice is loud, in the shape
 * of what it is saying.
 */

export const BAND_COUNT = 16
const LOWEST_HZ = 150
const HIGHEST_HZ = 6000
/** How far below the loudest band a band still shows. */
const RANGE_DB = 30
const SHAPE_ATTACK_S = 0.03
const SHAPE_RELEASE_S = 0.12

/**
 * Each band's strength against the loudest, 0..1, from an analyser's
 * per-bin decibels. Power is tilted up 3 dB an octave so a voice's naturally
 * quieter upper bands still move.
 */
export function spectrumShape(decibels: ArrayLike<number>, binHz: number, out: number[] = new Array<number>(BAND_COUNT)): number[] {
  const count = out.length
  const highestBin = decibels.length - 1
  const ratio = HIGHEST_HZ / LOWEST_HZ
  let top = -Infinity
  for (let band = 0; band < count; band++) {
    const low = LOWEST_HZ * ratio ** (band / count)
    const high = LOWEST_HZ * ratio ** ((band + 1) / count)
    const center = Math.sqrt(low * high)
    let first = Math.ceil(low / binHz)
    let last = Math.ceil(high / binHz) - 1
    if (first > last) {
      // Narrower than a bin: the bin nearest its centre.
      first = Math.round(center / binHz)
      last = first
    }
    first = Math.min(Math.max(1, first), highestBin)
    last = Math.min(Math.max(first, last), highestBin)
    let power = 0
    for (let bin = first; bin <= last; bin++) power += 10 ** (decibels[bin] / 10)
    power /= last - first + 1
    const db = 10 * Math.log10(power * (center / 1000) + 1e-12)
    out[band] = db
    if (db > top) top = db
  }
  for (let band = 0; band < count; band++) out[band] = Math.min(1, Math.max(0, (out[band] - (top - RANGE_DB)) / RANGE_DB))
  return out
}

/**
 * One voice's level and band shape, eased frame by frame: quick to rise,
 * slower to fall. Without an analyser it has a level alone (handed in), and
 * no bands.
 */
export class VoiceSpectrumMeter {
  level = 0
  private readonly shape = new Array<number>(BAND_COUNT).fill(0)
  private readonly target = new Array<number>(BAND_COUNT).fill(0)
  private readonly out = new Array<number>(BAND_COUNT).fill(0)
  private samples: Uint8Array<ArrayBuffer> | null = null
  private decibels: Float32Array<ArrayBuffer> | null = null
  private metered = false

  /** Reads `analyser` when there is one, else eases toward `fallbackLevel`. */
  advance(analyser: AnalyserNode | null, fallbackLevel: number, dt: number): void {
    if (!analyser) {
      this.metered = false
      this.level = smoothLevel(this.level, fallbackLevel, dt)
      return
    }
    if (this.samples?.length !== analyser.fftSize) this.samples = new Uint8Array(analyser.fftSize)
    if (this.decibels?.length !== analyser.frequencyBinCount) this.decibels = new Float32Array(analyser.frequencyBinCount)
    this.metered = true
    this.level = smoothLevel(this.level, readLevel(analyser, this.samples), dt)
    analyser.getFloatFrequencyData(this.decibels)
    spectrumShape(this.decibels, analyser.context.sampleRate / analyser.fftSize, this.target)
    for (let i = 0; i < BAND_COUNT; i++) {
      const tau = this.target[i] > this.shape[i] ? SHAPE_ATTACK_S : SHAPE_RELEASE_S
      this.shape[i] += (this.target[i] - this.shape[i]) * (1 - Math.exp(-dt / tau))
    }
  }

  /** 0..1 each, lowest band first; null while there is only a level. */
  get bands(): readonly number[] | null {
    if (!this.metered) return null
    for (let i = 0; i < BAND_COUNT; i++) this.out[i] = this.shape[i] * this.level
    return this.out
  }
}
