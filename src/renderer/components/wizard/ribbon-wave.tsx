import { useRef, useEffect } from 'react'

const STRIPE_COLORS = [
  '#c0392b', '#e74c3c', '#e67e22', '#f39c12', '#d4ac0d', '#8b6914',
  '#f1c40f', '#2980b9', '#3498db', '#8e44ad', '#9b59b6', '#1a5276',
  '#154360', '#c0392b', '#cb4335', '#f0b27a', '#f8c471', '#f9e79f',
  '#fdfefe', '#d5d8dc', '#aab7b8', '#808b96', '#1c2833', '#212f3d',
  '#e74c3c', '#e91e63', '#ff5722', '#ff9800', '#ffc107', '#cddc39',
  '#8bc34a', '#4caf50', '#009688', '#00bcd4', '#03a9f4', '#2196f3',
  '#3f51b5', '#673ab7', '#9c27b0', '#795548', '#607d8b', '#ff6f61',
  '#c0392b', '#e74c3c', '#e67e22', '#d4ac0d', '#2980b9', '#8e44ad',
  '#f1c40f', '#3498db', '#9b59b6', '#1a5276', '#c0392b', '#f0b27a',
  '#fdfefe', '#aab7b8', '#1c2833', '#e74c3c', '#ff5722', '#2196f3',
  '#4caf50', '#ff9800',
]

const CFG = {
  stripeCount: 91,
  stripeSize: 8,
  waveAmplitude: 67,
  waveFrequency: 4,
  ribbonWidth: 343,
  cornerRadius: 80,
  waveSpeed: 1.49,
  scrollSpeed: 3,
  morphSpeed: 0,
  mouseInfluence: 200,
  bgColor: '#000000',
  colorShift: 0,
  shadowDepth: 0,
}

function hueShift(hex: string, deg: number): string {
  if (deg === 0) return hex
  let r = parseInt(hex.slice(1, 3), 16) / 255
  let g = parseInt(hex.slice(3, 5), 16) / 255
  let b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break
      case g: h = ((b - r) / d + 2) / 6; break
      case b: h = ((r - g) / d + 4) / 6; break
    }
  }
  h = ((h * 360 + deg) % 360 + 360) % 360 / 360
  function hue2rgb(p: number, q: number, t: number) {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q2 = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p2 = 2 * l - q2
  r = hue2rgb(p2, q2, h + 1 / 3)
  g = hue2rgb(p2, q2, h)
  b = hue2rgb(p2, q2, h - 1 / 3)
  return '#' + [r, g, b].map(v => ('0' + Math.round(v * 255).toString(16)).slice(-2)).join('')
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

interface RibbonWaveProps {
  className?: string
}

export function RibbonWave({ className }: RibbonWaveProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let W = 0
    let H = 0
    let mx = -9999
    let my = -9999
    let smoothMx = -9999
    let smoothMy = -9999
    let t = 0
    let stripeOffset = 0
    let animId = 0

    function resize() {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas!.getBoundingClientRect()
      W = rect.width
      H = rect.height
      canvas!.width = W * dpr
      canvas!.height = H * dpr
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      draw()
    }

    function getWaveX(y: number, time: number) {
      const norm = y / H
      let wave = Math.sin(norm * Math.PI * CFG.waveFrequency * 2 + time) * CFG.waveAmplitude * 0.5
      wave += Math.sin(norm * Math.PI * CFG.waveFrequency + time * 0.7) * CFG.waveAmplitude * 0.3
      if (smoothMx > -999 && CFG.mouseInfluence > 0) {
        const dist = Math.abs(y - smoothMy)
        const radius = H * 0.25
        if (dist < radius) {
          const strength = (1 - dist / radius) * CFG.mouseInfluence
          wave += (smoothMx - W / 2) * strength * 0.008
        }
      }
      return W * 0.5 + wave
    }

    function draw() {
      ctx!.fillStyle = CFG.bgColor
      ctx!.fillRect(0, 0, W, H)

      const count = CFG.stripeCount
      const stripeH = CFG.stripeSize
      const totalH = count * stripeH
      const startY = (H - totalH) / 2

      for (let i = 0; i < count; i++) {
        let fi = (i + stripeOffset) % count
        if (fi < 0) fi += count

        const y = startY + i * stripeH
        const cx = getWaveX(y + stripeH * 0.5, t * CFG.waveSpeed)
        const x = cx - CFG.ribbonWidth * 0.5

        let colorIdx = Math.floor(fi + t * CFG.morphSpeed * 10) % STRIPE_COLORS.length
        if (colorIdx < 0) colorIdx += STRIPE_COLORS.length
        const col = hueShift(STRIPE_COLORS[colorIdx], CFG.colorShift)

        if (CFG.shadowDepth > 0) {
          ctx!.save()
          ctx!.shadowColor = 'rgba(0,0,0,0.18)'
          ctx!.shadowBlur = CFG.shadowDepth
          ctx!.shadowOffsetY = CFG.shadowDepth * 0.4
        }

        ctx!.fillStyle = col
        const gap = stripeH > 3 ? 1 : 0
        drawRoundedRect(ctx!, x, y + gap * 0.5, CFG.ribbonWidth, stripeH - gap, CFG.cornerRadius)
        ctx!.fill()

        if (CFG.shadowDepth > 0) ctx!.restore()
      }
    }

    const LERP = 0.08
    // Spring physics for bounce-back
    let velX = 0
    let velY = 0
    const SPRING = 0.05
    const DAMPING = 0.82

    function loop() {
      t += 0.016
      stripeOffset = (stripeOffset + CFG.scrollSpeed * 0.05) % CFG.stripeCount

      // Ease mouse influence toward cursor, spring back with overshoot on leave
      if (mx > -999) {
        if (smoothMx < -999) { smoothMx = mx; smoothMy = my; velX = 0; velY = 0 }
        else { smoothMx += (mx - smoothMx) * LERP; smoothMy += (my - smoothMy) * LERP; velX = 0; velY = 0 }
      } else if (smoothMx > -999) {
        velX += (W / 2 - smoothMx) * SPRING
        velY += (H / 2 - smoothMy) * SPRING
        velX *= DAMPING
        velY *= DAMPING
        smoothMx += velX
        smoothMy += velY
        if (Math.abs(smoothMx - W / 2) < 0.3 && Math.abs(velX) < 0.1) {
          smoothMx = -9999; smoothMy = -9999; velX = 0; velY = 0
        }
      }

      draw()
      animId = requestAnimationFrame(loop)
    }

    function onMouseMove(e: MouseEvent) {
      const rect = canvas!.getBoundingClientRect()
      mx = e.clientX - rect.left
      my = e.clientY - rect.top
    }

    function onMouseLeave() {
      mx = -9999
      my = -9999
    }

    const resizeObserver = new ResizeObserver(() => {
      resize()
    })
    resizeObserver.observe(canvas)

    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mouseleave', onMouseLeave)

    resize()
    animId = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(animId)
      resizeObserver.disconnect()
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  )
}
