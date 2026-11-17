export const HALFTONE_ALPHA_BANDS = 32
export const HALFTONE_MAX_ALPHA_ERROR = 1 / (HALFTONE_ALPHA_BANDS * 2)

const TAU = Math.PI * 2
export const HALFTONE_CURSOR_INFLUENCE = 90
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
/** The unit vector toward the light, for a painter that shades the field itself (halftone-gpu.ts). */
export const HALFTONE_LIGHT = [NORMALIZED_LIGHT_X, NORMALIZED_LIGHT_Y, NORMALIZED_LIGHT_Z] as const

export type HalftoneState = 'working' | 'idle' | 'alert'
export type HalftoneDrawStrategy = 'per-dot' | 'alpha-buckets'

interface DensitySample {
  alpha: number
  radius: number
}

export interface PulseFrame {
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

/** Convert a 60 Hz per-frame easing rate into an equivalent wall-clock rate. */
export function scaleHalftoneEasingRate(rate: number, frameScale: number): number {
  return 1 - Math.pow(1 - rate, Math.max(0, frameScale))
}

function ensureFloat32Capacity(buffer: Float32Array, capacity: number): Float32Array {
  return buffer.length >= capacity ? buffer : new Float32Array(capacity)
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

export const FLOW_AMPLITUDES = [0.3, 0.2, 0.15] as const
/** Each wave's phase at the field's centre at time zero. */
export const FLOW_ORIGINS = [3.5, 9.5, 7.5] as const
/** Each wave's phase change per unit of field time. */
export const FLOW_TIME_RATES = [-0.04, -0.05, 0.03] as const

/**
 * The three waves have (u, v) frequencies (7, 0), (13, 6), (4, 11), rotated
 * around (0.5, 0.5). Split each into its column and row contributions.
 */
export function flowWaveFrequencies(
  rotationCos: number,
  rotationSin: number
): { column: [number, number, number]; row: [number, number, number] } {
  return {
    column: [
      7 * rotationCos,
      13 * rotationCos + 6 * rotationSin,
      4 * rotationCos + 11 * rotationSin,
    ],
    row: [
      -7 * rotationSin,
      -13 * rotationSin + 6 * rotationCos,
      -4 * rotationSin + 11 * rotationCos,
    ],
  }
}

/** A seed's rotation of the flow field, and its offset into the animation. */
export function halftoneSeedPhase(seed: number): { rotationAngle: number; seedTime: number } {
  return { rotationAngle: (seed % 18) * 20 * (Math.PI / 180), seedTime: seed % 1000 }
}

export interface HalftoneGridLayout {
  columns: number
  rows: number
  offsetX: number
  offsetY: number
  centerColumn: number
  centerRow: number
  epsilon: number
}

/** Where a `width` x `height` field's dots sit: a centred grid at `spacing`. */
export function halftoneGridLayout(width: number, height: number, spacing: number): HalftoneGridLayout {
  const columns = Math.max(1, Math.floor(width / spacing))
  const rows = Math.max(1, Math.floor(height / spacing))
  return {
    columns,
    rows,
    offsetX: (width - (columns - 1) * spacing) / 2,
    offsetY: (height - (rows - 1) * spacing) / 2,
    centerColumn: (columns - 1) / 2,
    centerRow: (rows - 1) / 2,
    epsilon: 0.5 / columns,
  }
}

/**
 * Factor the three rotated waves with sin(a + b), sharing trigonometry across
 * each row and column instead of evaluating nine sines per dot per frame.
 * Retain the original finite-difference samples for lighting; derivatives
 * would change the appearance. Float64 caches keep the JS math's precision,
 * with storage proportional to rows + columns rather than the number of dots.
 */
class FlowField {
  // Three phases and three interleaved sin/cos pairs per column/row.
  private columnPhase = new Float64Array(0)
  private columnSinCos = new Float64Array(0)
  private rowSinCos = new Float64Array(0)
  // sin/cos of the x and y finite-difference offsets, four values per wave.
  private readonly offsets = new Float64Array(12)
  private columns = 0

  resize(
    columnU: Float32Array,
    rowV: Float32Array,
    columns: number,
    rows: number,
    epsilon: number,
    rotationCos: number,
    rotationSin: number
  ): void {
    this.columns = columns
    if (this.columnPhase.length < columns * 3) this.columnPhase = new Float64Array(columns * 3)
    if (this.columnSinCos.length < columns * 6) this.columnSinCos = new Float64Array(columns * 6)
    if (this.rowSinCos.length < rows * 6) this.rowSinCos = new Float64Array(rows * 6)

    const { column: columnFrequency, row: rowFrequency } = flowWaveFrequencies(rotationCos, rotationSin)
    const origin = FLOW_ORIGINS
    for (let wave = 0; wave < FLOW_AMPLITUDES.length; wave++) {
      this.offsets[wave * 4] = Math.sin(columnFrequency[wave] * epsilon)
      this.offsets[wave * 4 + 1] = Math.cos(columnFrequency[wave] * epsilon)
      this.offsets[wave * 4 + 2] = Math.sin(rowFrequency[wave] * epsilon)
      this.offsets[wave * 4 + 3] = Math.cos(rowFrequency[wave] * epsilon)
      for (let column = 0; column < columns; column++) {
        this.columnPhase[column * 3 + wave] = origin[wave] + (columnU[column] - 0.5) * columnFrequency[wave]
      }
      for (let row = 0; row < rows; row++) {
        const phase = (rowV[row] - 0.5) * rowFrequency[wave]
        this.rowSinCos[row * 6 + wave * 2] = Math.sin(phase)
        this.rowSinCos[row * 6 + wave * 2 + 1] = Math.cos(phase)
      }
    }
  }

  update(time: number): void {
    for (let column = 0; column < this.columns; column++) {
      const phaseIndex = column * 3
      const pairIndex = column * 6
      const phase0 = this.columnPhase[phaseIndex] + time * FLOW_TIME_RATES[0]
      const phase1 = this.columnPhase[phaseIndex + 1] + time * FLOW_TIME_RATES[1]
      const phase2 = this.columnPhase[phaseIndex + 2] + time * FLOW_TIME_RATES[2]
      this.columnSinCos[pairIndex] = Math.sin(phase0)
      this.columnSinCos[pairIndex + 1] = Math.cos(phase0)
      this.columnSinCos[pairIndex + 2] = Math.sin(phase1)
      this.columnSinCos[pairIndex + 3] = Math.cos(phase1)
      this.columnSinCos[pairIndex + 4] = Math.sin(phase2)
      this.columnSinCos[pairIndex + 5] = Math.cos(phase2)
    }
  }

  sample(column: number, row: number, epsilon: number, sample: DensitySample): void {
    let height = 0, heightX = 0, heightY = 0
    const columns = this.columnSinCos
    const rows = this.rowSinCos
    const offsets = this.offsets
    for (let wave = 0; wave < FLOW_AMPLITUDES.length; wave++) {
      const columnIndex = column * 6 + wave * 2
      const rowIndex = row * 6 + wave * 2
      const offsetIndex = wave * 4
      const sin = columns[columnIndex] * rows[rowIndex + 1] + columns[columnIndex + 1] * rows[rowIndex]
      const cos = columns[columnIndex + 1] * rows[rowIndex + 1] - columns[columnIndex] * rows[rowIndex]
      const amplitude = FLOW_AMPLITUDES[wave]
      height += amplitude * sin
      heightX += amplitude * (sin * offsets[offsetIndex + 1] + cos * offsets[offsetIndex])
      heightY += amplitude * (sin * offsets[offsetIndex + 3] + cos * offsets[offsetIndex + 2])
    }
    shadeInto(height + 0.65, heightX + 0.65, heightY + 0.65, epsilon, 0.18, 0.74, 0.45, 1.9, sample)
  }
}

export function updatePulseFrame(time: number, frame: PulseFrame): void {
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

/**
 * The field on the CPU, drawn with Canvas2D. halftone-gpu.ts holds the same
 * field as a vertex shader for views too large to compute per dot in script:
 * a change to the shading or the motifs here is made there as well.
 */
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
  private readonly flowField = new FlowField()
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
  private columnX: Float32Array = new Float32Array(0)
  private columnU: Float32Array = new Float32Array(0)
  private rowY: Float32Array = new Float32Array(0)
  private rowV: Float32Array = new Float32Array(0)
  private cellVignette: Float32Array = new Float32Array(0)
  private cellAlphaScale: Float32Array = new Float32Array(0)
  private cellRadiusScale: Float32Array = new Float32Array(0)
  private scratch: HalftoneDotScratch | null = null

  constructor(options: HalftoneRendererOptions) {
    const { rotationAngle, seedTime } = halftoneSeedPhase(options.seed ?? 0)
    this.motif = options.motif === 'pulse' ? 'pulse' : 'flow_3d'
    this.color = options.color
    this.spacing = options.spacing ?? 6
    this.maxRadius = options.maxRadius ?? 1.6
    this.vignette = options.vignette ?? 0.22
    this.contrast = options.contrast ?? 1.6
    this.dim = options.dim ?? (options.state === 'idle' ? 0.65 : 1)
    this.seedTime = seedTime
    this.rotationCos = Math.cos(rotationAngle)
    this.rotationSin = Math.sin(rotationAngle)
    this.alphaBands = options.alphaBands ?? HALFTONE_ALPHA_BANDS
  }

  resize(width: number, height: number): boolean {
    if (width === this.width && height === this.height) {
      return width > 0 && height > 0 && this.scratch !== null
    }
    this.width = width
    this.height = height
    if (width <= 0 || height <= 0) {
      this.columns = 0
      this.rows = 0
      this.epsilon = 0
      return false
    }

    const layout = halftoneGridLayout(width, height, this.spacing)
    this.columns = layout.columns
    this.rows = layout.rows
    this.offsetX = layout.offsetX
    this.offsetY = layout.offsetY
    this.centerColumn = layout.centerColumn
    this.centerRow = layout.centerRow
    this.epsilon = layout.epsilon
    this.columnX = ensureFloat32Capacity(this.columnX, this.columns)
    this.columnU = ensureFloat32Capacity(this.columnU, this.columns)
    this.rowY = ensureFloat32Capacity(this.rowY, this.rows)
    this.rowV = ensureFloat32Capacity(this.rowV, this.rows)
    for (let column = 0; column < this.columns; column++) {
      this.columnX[column] = this.offsetX + column * this.spacing
      this.columnU[column] = column / this.columns
    }
    for (let row = 0; row < this.rows; row++) {
      this.rowY[row] = this.offsetY + row * this.spacing
      this.rowV[row] = row / this.rows
    }

    if (this.motif === 'flow_3d') {
      this.flowField.resize(
        this.columnU, this.rowV, this.columns, this.rows,
        this.epsilon, this.rotationCos, this.rotationSin
      )
    }
    const capacity = this.columns * this.rows
    this.cellVignette = ensureFloat32Capacity(this.cellVignette, capacity)
    this.cellAlphaScale = ensureFloat32Capacity(this.cellAlphaScale, capacity)
    this.cellRadiusScale = ensureFloat32Capacity(this.cellRadiusScale, capacity)
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
    if (
      this.scratch === null ||
      this.scratch.capacity < capacity ||
      this.scratch.bandCount !== this.alphaBands
    ) {
      this.scratch = createHalftoneDotScratch(capacity, this.alphaBands)
    } else {
      // Grid coordinates may map to different cells after a resize. Retain the
      // allocation but reset temporal cursor state rather than smearing it into
      // the new geometry.
      this.scratch.influence.fill(0, 0, capacity)
    }
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

  /** The dots of the last `compute()` (its first `dotCount` entries), for a painter other than Canvas2D. */
  get dots(): HalftoneDotScratch | null {
    return this.scratch
  }

  draw(
    ctx: CanvasRenderingContext2D,
    time: number,
    strategy: HalftoneDrawStrategy = 'alpha-buckets',
    pointerX = 0,
    pointerY = 0,
    pointerActive = false,
    frameScale = 1
  ): number {
    const scratch = this.scratch
    if (!scratch) return 0

    ctx.clearRect(0, 0, this.width, this.height)
    ctx.fillStyle = this.color

    const dotCount = this.compute(time, pointerX, pointerY, pointerActive, frameScale)
    if (strategy === 'per-dot') {
      drawPerDot(ctx, scratch, dotCount)
    } else {
      drawAlphaBuckets(ctx, scratch, dotCount)
    }
    ctx.globalAlpha = 1
    return dotCount
  }

  /**
   * Work out a frame's visible dots (position, radius, alpha, alpha band) into
   * `dots` without drawing them, and return how many there are.
   */
  compute(
    time: number,
    pointerX = 0,
    pointerY = 0,
    pointerActive = false,
    frameScale = 1
  ): number {
    const scratch = this.scratch
    if (!scratch) return 0

    const influenceRadiusSquared = HALFTONE_CURSOR_INFLUENCE * HALFTONE_CURSOR_INFLUENCE
    const cursorAttack = scaleHalftoneEasingRate(CURSOR_ATTACK, frameScale)
    const cursorRelease = scaleHalftoneEasingRate(CURSOR_RELEASE, frameScale)
    const fieldTime = time + this.seedTime
    if (this.motif === 'pulse') updatePulseFrame(fieldTime, this.pulseFrame)
    else this.flowField.update(fieldTime)
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
          this.flowField.sample(column, row, this.epsilon, this.sample)
        }

        let alpha = Math.min(1, this.sample.alpha * this.contrast * 0.9)
        let radius = this.sample.radius * (this.maxRadius / 2.4)
        let target = 0
        if (pointerActive) {
          const deltaX = x - pointerX
          const deltaY = y - pointerY
          const distanceSquared = deltaX * deltaX + deltaY * deltaY
          if (distanceSquared < influenceRadiusSquared) {
            const falloff = 1 - Math.sqrt(distanceSquared) / HALFTONE_CURSOR_INFLUENCE
            target = falloff * falloff
          }
        }

        const currentInfluence = scratch.influence[cell]
        const influence =
          currentInfluence +
          (target - currentInfluence) *
            (target > currentInfluence ? cursorAttack : cursorRelease)
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
