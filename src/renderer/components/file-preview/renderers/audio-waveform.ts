const MIN_BAR_HEIGHT = 0.12

/**
 * Reduce decoded PCM channels to a small, normalized set of waveform bars.
 * Sampling each bucket keeps the work bounded even for long recordings.
 */
export function createWaveformPeaks(channels: Float32Array[], barCount: number): number[] {
  if (barCount <= 0) return []

  const sampleCount = channels.reduce((max, channel) => Math.max(max, channel.length), 0)
  if (sampleCount === 0) return Array.from({ length: barCount }, () => MIN_BAR_HEIGHT)

  const peaks = Array.from({ length: barCount }, (_, barIndex) => {
    const start = Math.floor((barIndex / barCount) * sampleCount)
    const end = Math.max(start + 1, Math.floor(((barIndex + 1) / barCount) * sampleCount))
    const stride = Math.max(1, Math.floor((end - start) / 64))
    let sumOfSquares = 0
    let sampled = 0

    for (const channel of channels) {
      const channelEnd = Math.min(end, channel.length)
      for (let sampleIndex = start; sampleIndex < channelEnd; sampleIndex += stride) {
        const value = channel[sampleIndex]
        sumOfSquares += value * value
        sampled += 1
      }
    }

    return sampled > 0 ? Math.sqrt(sumOfSquares / sampled) : 0
  })

  const maxPeak = Math.max(...peaks)
  if (maxPeak === 0) return peaks.map(() => MIN_BAR_HEIGHT)

  return peaks.map(peak => MIN_BAR_HEIGHT + (peak / maxPeak) * (1 - MIN_BAR_HEIGHT))
}

/** A visually useful fallback while the source is loading or cannot be decoded. */
export function createFallbackWaveform(barCount: number): number[] {
  return Array.from({ length: barCount }, (_, index) => {
    const position = index / Math.max(1, barCount - 1)
    const envelope = 0.45 + Math.sin(position * Math.PI) * 0.45
    const texture = 0.52 + Math.abs(Math.sin(index * 1.73) * Math.cos(index * 0.41)) * 0.48
    return Math.max(MIN_BAR_HEIGHT, Math.min(1, envelope * texture))
  })
}
