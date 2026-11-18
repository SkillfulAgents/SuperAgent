import { useRef, useEffect } from 'react'

interface MiniWaveformProps {
  analyserRef: React.RefObject<AnalyserNode | null>
  /** Number of vertical bars. Default 16. */
  bars?: number
  /** Canvas width in CSS px. Default 64. */
  width?: number
  /** Canvas height in CSS px. Default 20. */
  height?: number
  /** Bar color. Default "white". */
  color?: string
}

/**
 * Tiny canvas-based waveform driven by a Web Audio AnalyserNode.
 * Renders vertical bars whose height tracks the frequency spectrum.
 */
export function MiniWaveform({
  analyserRef,
  bars = 16,
  width = 64,
  height = 20,
  color = 'white',
}: MiniWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animFrameRef = useRef<number>(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    ctx.scale(dpr, dpr)

    const smoothed = new Float32Array(bars).fill(0)
    const DECAY = 0.85
    const RISE = 0.4

    function draw() {
      animFrameRef.current = requestAnimationFrame(draw)
      if (!canvas || !ctx) return

      ctx.clearRect(0, 0, width, height)

      const analyser = analyserRef.current
      if (!analyser) return

      const freqData = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteFrequencyData(freqData)

      const binSize = Math.floor(freqData.length / bars)
      for (let i = 0; i < bars; i++) {
        let sum = 0
        for (let j = 0; j < binSize; j++) {
          sum += freqData[i * binSize + j]
        }
        const target = (sum / binSize) / 255
        smoothed[i] = target > smoothed[i]
          ? smoothed[i] + (target - smoothed[i]) * RISE
          : smoothed[i] * DECAY
      }

      const gap = width / bars
      const lineW = Math.max(1.5, gap * 0.4)
      const midY = height / 2

      ctx.strokeStyle = color
      ctx.lineWidth = lineW
      ctx.lineCap = 'round'

      for (let i = 0; i < bars; i++) {
        const amp = smoothed[i]
        const barH = Math.max(2, amp * height * 0.85)
        const x = gap * (i + 0.5)
        const alpha = 0.3 + amp * 0.7

        ctx.globalAlpha = alpha
        ctx.beginPath()
        ctx.moveTo(x, midY - barH / 2)
        ctx.lineTo(x, midY + barH / 2)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }

    draw()
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [analyserRef, bars, width, height, color])

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, display: 'block' }}
    />
  )
}
