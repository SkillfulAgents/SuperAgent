export const HALFTONE_ALPHA_BANDS = 32
export const HALFTONE_MAX_ALPHA_ERROR = 1 / (HALFTONE_ALPHA_BANDS * 2)

const TAU = Math.PI * 2
const CURSOR_INFLUENCE = 90
const CURSOR_ATTACK = 0.18
const CURSOR_RELEASE = 0.04
const CURSOR_R = 1.6
const CURSOR_A = 0.75

// Light: slightly upper-left, tilted toward the viewer.
const LIGHT_X = 0.32
const LIGHT_Y = -0.55
const LIGHT_Z = 0.78
const LIGHT_LENGTH = Math.sqrt(LIGHT_X * LIGHT_X + LIGHT_Y * LIGHT_Y + LIGHT_Z * LIGHT_Z)
const NORMALIZED_LIGHT_X = LIGHT_X / LIGHT_LENGTH
const NORMALIZED_LIGHT_Y = LIGHT_Y / LIGHT_LENGTH
const NORMALIZED_LIGHT_Z = LIGHT_Z / LIGHT_LENGTH

export type HalftoneState = 'working' | 'idle' | 'alert'
export type HalftoneDrawStrategy = 'per-dot' | 'alpha-buckets'

interface DensitySample {
  alpha: number
  radius: number
}

interface PulseFrame {
  radius0: number
  radius1: number
  weight0: number
  weight1: number
}

export interface HalftoneDotScratch {
  readonly capacity: number
  readonly bandCount: number
  readonly x: Float32Array
  readonly y: Float32Array
  readonly radius: Float32Array
  readonly alpha: Float32Array
  readonly band: Uint8Array
  readonly sortedIndices: Uint32Array
  readonly bandCounts: Uint32Array
  readonly bandOffsets: Uint32Array
  readonly bandWriteOffsets: Uint32Array
  readonly influence: Float32Array
}

export interface HalftoneRendererOptions {
  motif: string
  state?: HalftoneState
  color: string
  spacing?: number
  maxRadius?: number
  vignette?: number
  contrast?: number
  dim?: number
  seed?: number
  alphaBands?: number
}

export function createHalftoneDotScratch(
  capacity: number,
  bandCount = HALFTONE_ALPHA_BANDS
): HalftoneDotScratch {
  if (!Number.isInteger(capacity) || capacity < 0) {
    throw new RangeError(`Halftone scratch capacity must be a non-negative integer: ${capacity}`)
  }
  if (!Number.isInteger(bandCount) || bandCount < 1 || bandCount > 256) {
    throw new RangeError(`Halftone alpha band count must be an integer from 1 to 256: ${bandCount}`)
  }

  return {
    capacity,
    bandCount,
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    radius: new Float32Array(capacity),
    alpha: new Float32Array(capacity),
    band: new Uint8Array(capacity),
    sortedIndices: new Uint32Array(capacity),
    bandCounts: new Uint32Array(bandCount),
    bandOffsets: new Uint32Array(bandCount),
    bandWriteOffsets: new Uint32Array(bandCount),
    influence: new Float32Array(capacity),
  }
}

export function alphaToBand(alpha: number, bandCount = HALFTONE_ALPHA_BANDS): number {
  const clamped = Math.max(0, Math.min(1, alpha))
  return Math.min(bandCount - 1, Math.floor(clamped * bandCount))
}

export function alphaBandMidpoint(
  band: number,
  bandCount = HALFTONE_ALPHA_BANDS
): number {
  return (band + 0.5) / bandCount
}

/**
 * Stable counting sort of visible-dot indices by alpha band.
 *
 * Every buffer is allocated by setup/resize. The steady-state path is
 * O(dots + bands) and does not allocate arrays or per-dot objects.
 */
export function countingSortDotIndices(scratch: HalftoneDotScratch, dotCount: number): void {
  if (dotCount < 0 || dotCount > scratch.capacity) {
    throw new RangeError(`Halftone dot count ${dotCount} exceeds capacity ${scratch.capacity}`)
  }

  const counts = scratch.bandCounts
  const offsets = scratch.bandOffsets
  const writes = scratch.bandWriteOffsets
  counts.fill(0)

  for (let dot = 0; dot < dotCount; dot++) {
    counts[scratch.band[dot]]++
  }

  let offset = 0
  for (let band = 0; band < scratch.bandCount; band++) {
    offsets[band] = offset
    writes[band] = offset
    offset += counts[band]
  }

  for (let dot = 0; dot < dotCount; dot++) {
    const band = scratch.band[dot]
    scratch.sortedIndices[writes[band]++] = dot
  }
}

export function drawPerDot(
  ctx: CanvasRenderingContext2D,
  scratch: HalftoneDotScratch,
  dotCount: number
): void {
  for (let dot = 0; dot < dotCount; dot++) {
    ctx.globalAlpha = scratch.alpha[dot]
    ctx.beginPath()
    ctx.arc(scratch.x[dot], scratch.y[dot], scratch.radius[dot], 0, TAU)
    ctx.fill()
  }
}

export function drawAlphaBuckets(
  ctx: CanvasRenderingContext2D,
  scratch: HalftoneDotScratch,
  dotCount: number
): void {
  countingSortDotIndices(scratch, dotCount)

  for (let band = 0; band < scratch.bandCount; band++) {
    const count = scratch.bandCounts[band]
    if (count === 0) continue

    ctx.globalAlpha = alphaBandMidpoint(band, scratch.bandCount)
    ctx.beginPath()
    const start = scratch.bandOffsets[band]
    const end = start + count
    for (let sorted = start; sorted < end; sorted++) {
      const dot = scratch.sortedIndices[sorted]
      const x = scratch.x[dot]
      const y = scratch.y[dot]
      const radius = scratch.radius[dot]
      // Canvas joins a new arc to the previous subpath's endpoint unless the
      // current point is first moved to the new circle's starting point.
      ctx.moveTo(x + radius, y)
      ctx.arc(x, y, radius, 0, TAU)
    }
    ctx.fill()
  }
}

function flowHeight(u: number, v: number, time: number): number {
  return (
    0.3 * Math.sin(u * 7 - time * 0.04) +
    0.2 * Math.sin(u * 13 + v * 6 - time * 0.05) +
    0.15 * Math.sin(u * 4 + v * 11 + time * 0.03)
  )
}

function rotatedFlowHeight(
  u: number,
  v: number,
  time: number,
  rotationCos: number,
  rotationSin: number
): number {
  const du = u - 0.5
  const dv = v - 0.5
  return flowHeight(
    0.5 + du * rotationCos - dv * rotationSin,
    0.5 + du * rotationSin + dv * rotationCos,
    time
  )
}

function updatePulseFrame(time: number, frame: PulseFrame): void {
  const phase = (time * 0.0024) % 1
  const age0 = phase
  const age1 = (phase + 0.5) % 1
  frame.radius0 = age0 * 0.8
  frame.radius1 = age1 * 0.8
  frame.weight0 = 1 - age0
  frame.weight1 = 1 - age1
}

function pulseHeight(u: number, v: number, frame: PulseFrame): number {
  const dx = u - 0.5
  const dy = v - 0.5
  const distance = Math.sqrt(dx * dx + dy * dy)
  const band0 = Math.exp(-Math.pow((distance - frame.radius0) * 5.5, 2))
  const band1 = Math.exp(-Math.pow((distance - frame.radius1) * 5.5, 2))
  return band0 * frame.weight0 + band1 * frame.weight1
}

function shadeInto(
  height: number,
  heightX: number,
  heightY: number,
  epsilon: number,
  baseAlpha: number,
  litAlpha: number,
  baseRadius: number,
  heightRadius: number,
  sample: DensitySample
): void {
  const normalX = -(heightX - height) / epsilon
  const normalY = -(heightY - height) / epsilon
  const normalLength = Math.sqrt(normalX * normalX + normalY * normalY + 1)
  const lit = Math.max(
    0,
    (normalX * NORMALIZED_LIGHT_X +
      normalY * NORMALIZED_LIGHT_Y +
      NORMALIZED_LIGHT_Z) /
      normalLength
  )
  sample.alpha = Math.min(1, baseAlpha + lit * litAlpha)
  sample.radius = Math.max(0.2, baseRadius + Math.max(0, height) * heightRadius)
}

function flowSampleInto(
  u: number,
  v: number,
  epsilon: number,
  time: number,
  rotationCos: number,
  rotationSin: number,
  sample: DensitySample
): void {
  shadeInto(
    rotatedFlowHeight(u, v, time, rotationCos, rotationSin) + 0.65,
    rotatedFlowHeight(u + epsilon, v, time, rotationCos, rotationSin) + 0.65,
    rotatedFlowHeight(u, v + epsilon, time, rotationCos, rotationSin) + 0.65,
    epsilon,
    0.18,
    0.74,
    0.45,
    1.9,
    sample
  )
}

function pulseSampleInto(
  u: number,
  v: number,
  epsilon: number,
  frame: PulseFrame,
  sample: DensitySample
): void {
  const height = pulseHeight(u, v, frame)
  if (height < 0.05) {
    sample.alpha = 0
    sample.radius = 0
    return
  }

  shadeInto(
    height * 0.6 + 0.05,
    pulseHeight(u + epsilon, v, frame) * 0.6 + 0.05,
    pulseHeight(u, v + epsilon, frame) * 0.6 + 0.05,
    epsilon,
    0.12,
    0.85,
    0.4,
    2.2,
    sample
  )
  sample.alpha *= Math.min(1, height * 1.6)
}

export class HalftoneFrameRenderer {
  private readonly motif: 'flow_3d' | 'pulse'
  private readonly color: string
  private readonly spacing: number
  private readonly maxRadius: number
  private readonly vignette: number
  private readonly contrast: number
  private readonly dim: number
  private readonly seedTime: number
  private readonly rotationCos: number
  private readonly rotationSin: number
  private readonly alphaBands: number
  private readonly sample: DensitySample = { alpha: 0, radius: 0 }
  private readonly pulseFrame: PulseFrame = {
    radius0: 0,
    radius1: 0,
    weight0: 0,
    weight1: 0,
  }

  private width = 0
  private height = 0
  private columns = 0
  private rows = 0
  private offsetX = 0
  private offsetY = 0
  private centerColumn = 0
  private centerRow = 0
  private epsilon = 0
  private columnX = new Float64Array(0)
  private columnU = new Float64Array(0)
  private rowY = new Float64Array(0)
  private rowV = new Float64Array(0)
  private cellVignette = new Float64Array(0)
  private cellAlphaScale = new Float64Array(0)
  private cellRadiusScale = new Float64Array(0)
  private scratch: HalftoneDotScratch | null = null

  constructor(options: HalftoneRendererOptions) {
    const seed = options.seed ?? 0
    const rotationAngle = (seed % 18) * 20 * (Math.PI / 180)
    this.motif = options.motif === 'pulse' ? 'pulse' : 'flow_3d'
    this.color = options.color
    this.spacing = options.spacing ?? 6
    this.maxRadius = options.maxRadius ?? 1.6
    this.vignette = options.vignette ?? 0.22
    this.contrast = options.contrast ?? 1.6
    this.dim = options.dim ?? (options.state === 'idle' ? 0.65 : 1)
    this.seedTime = seed % 1000
    this.rotationCos = Math.cos(rotationAngle)
    this.rotationSin = Math.sin(rotationAngle)
    this.alphaBands = options.alphaBands ?? HALFTONE_ALPHA_BANDS
  }

  resize(width: number, height: number): boolean {
    if (width === this.width && height === this.height) {
      return this.scratch !== null
    }
    this.width = width
    this.height = height
    if (width <= 0 || height <= 0) {
      this.columns = 0
      this.rows = 0
      this.epsilon = 0
      this.columnX = new Float64Array(0)
      this.columnU = new Float64Array(0)
      this.rowY = new Float64Array(0)
      this.rowV = new Float64Array(0)
      this.cellVignette = new Float64Array(0)
      this.cellAlphaScale = new Float64Array(0)
      this.cellRadiusScale = new Float64Array(0)
      this.scratch = null
      return false
    }

    this.columns = Math.max(1, Math.floor(width / this.spacing))
    this.rows = Math.max(1, Math.floor(height / this.spacing))
    this.offsetX = (width - (this.columns - 1) * this.spacing) / 2
    this.offsetY = (height - (this.rows - 1) * this.spacing) / 2
    this.centerColumn = (this.columns - 1) / 2
    this.centerRow = (this.rows - 1) / 2
    this.epsilon = 0.5 / this.columns
    this.columnX = new Float64Array(this.columns)
    this.columnU = new Float64Array(this.columns)
    this.rowY = new Float64Array(this.rows)
    this.rowV = new Float64Array(this.rows)
    for (let column = 0; column < this.columns; column++) {
      this.columnX[column] = this.offsetX + column * this.spacing
      this.columnU[column] = column / this.columns
    }
    for (let row = 0; row < this.rows; row++) {
      this.rowY[row] = this.offsetY + row * this.spacing
      this.rowV[row] = row / this.rows
    }

    const capacity = this.columns * this.rows
    this.cellVignette = new Float64Array(capacity)
    this.cellAlphaScale = new Float64Array(capacity)
    this.cellRadiusScale = new Float64Array(capacity)
    for (let row = 0; row < this.rows; row++) {
      const normalizedY =
        this.centerRow === 0 ? 0 : (row - this.centerRow) / this.centerRow
      for (let column = 0; column < this.columns; column++) {
        const normalizedX =
          this.centerColumn === 0
            ? 0
            : (column - this.centerColumn) / this.centerColumn
        const cell = row * this.columns + column
        const vignette = this.vignetteAt(normalizedX, normalizedY)
        this.cellVignette[cell] = vignette
        this.cellAlphaScale[cell] = vignette * this.dim
        this.cellRadiusScale[cell] = 0.35 + 0.65 * vignette
      }
    }
    this.scratch = createHalftoneDotScratch(
      capacity,
      this.alphaBands
    )
    return true
  }

  get columnCount(): number {
    return this.columns
  }

  get rowCount(): number {
    return this.rows
  }

  get capacity(): number {
    return this.scratch?.capacity ?? 0
  }

  draw(
    ctx: CanvasRenderingContext2D,
    time: number,
    strategy: HalftoneDrawStrategy = 'alpha-buckets',
    pointerX = 0,
    pointerY = 0,
    pointerActive = false
  ): number {
    const scratch = this.scratch
    if (!scratch) return 0

    ctx.clearRect(0, 0, this.width, this.height)
    ctx.fillStyle = this.color

    const influenceRadiusSquared = CURSOR_INFLUENCE * CURSOR_INFLUENCE
    const fieldTime = time + this.seedTime
    if (this.motif === 'pulse') updatePulseFrame(fieldTime, this.pulseFrame)
    let dotCount = 0

    for (let row = 0; row < this.rows; row++) {
      const y = this.rowY[row]
      const v = this.rowV[row]
      for (let column = 0; column < this.columns; column++) {
        const x = this.columnX[column]
        const u = this.columnU[column]
        const cell = row * this.columns + column
        if (this.motif === 'pulse') {
          pulseSampleInto(
            u,
            v,
            this.epsilon,
            this.pulseFrame,
            this.sample
          )
        } else {
          flowSampleInto(
            u,
            v,
            this.epsilon,
            fieldTime,
            this.rotationCos,
            this.rotationSin,
            this.sample
          )
        }

        let alpha = Math.min(1, this.sample.alpha * this.contrast * 0.9)
        let radius = this.sample.radius * (this.maxRadius / 2.4)
        let target = 0
        if (pointerActive) {
          const deltaX = x - pointerX
          const deltaY = y - pointerY
          const distanceSquared = deltaX * deltaX + deltaY * deltaY
          if (distanceSquared < influenceRadiusSquared) {
            const falloff = 1 - Math.sqrt(distanceSquared) / CURSOR_INFLUENCE
            target = falloff * falloff
          }
        }

        const currentInfluence = scratch.influence[cell]
        const influence =
          currentInfluence +
          (target - currentInfluence) *
            (target > currentInfluence ? CURSOR_ATTACK : CURSOR_RELEASE)
        scratch.influence[cell] = influence
        if (influence > 0.003) radius += influence * CURSOR_R

        const vignette = this.cellVignette[cell]
        if (vignette <= 0) continue

        alpha *= this.cellAlphaScale[cell]
        if (influence > 0.003) alpha += influence * vignette * CURSOR_A
        alpha = Math.min(1, alpha)
        radius *= this.cellRadiusScale[cell]
        if (alpha < 0.02 || radius < 0.2) continue

        scratch.x[dotCount] = x
        scratch.y[dotCount] = y
        scratch.radius[dotCount] = radius
        scratch.alpha[dotCount] = alpha
        scratch.band[dotCount] = alphaToBand(alpha, scratch.bandCount)
        dotCount++
      }
    }

    if (strategy === 'per-dot') {
      drawPerDot(ctx, scratch, dotCount)
    } else {
      drawAlphaBuckets(ctx, scratch, dotCount)
    }
    ctx.globalAlpha = 1
    return dotCount
  }

  private vignetteAt(deltaX: number, deltaY: number): number {
    if (this.vignette <= 0) return 1
    const normalizedDistance = Math.hypot(deltaX, deltaY)
    const start = 0.4 - this.vignette * 0.15
    let normalizedTime = (normalizedDistance - start) / (1 - start)
    normalizedTime = Math.max(0, Math.min(1, normalizedTime))
    const smooth = normalizedTime * normalizedTime * (3 - 2 * normalizedTime)
    return 1 - (smooth * this.vignette) / 0.45
  }
}
