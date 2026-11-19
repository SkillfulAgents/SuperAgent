import {
  FLOW_AMPLITUDES,
  FLOW_ORIGINS,
  FLOW_TIME_RATES,
  HALFTONE_LIGHT,
  flowWaveFrequencies,
  halftoneGridLayout,
  halftoneSeedPhase,
  updatePulseFrame,
  type HalftoneGridLayout,
  type HalftoneRendererOptions,
  type PulseFrame,
} from './halftone-renderer'

/**
 * The halftone field on the GPU: the vertex shader works out each dot's size
 * and opacity and draws it as one point sprite, so a frame is a handful of
 * uniforms and one draw call however many dots it holds.
 *
 * The Canvas2D path (halftone-renderer.ts) computes every dot in script and
 * then builds an arc path for it, which costs the renderer's main thread and
 * the GPU process in proportion to the dot count. A card's few thousand dots
 * are affordable; a full-view backdrop's sixty thousand are not: at 30 frames
 * a second they kept a core's fifth busy in each process
 * (docs/halftone-rendering.md).
 *
 * This is the same field as HalftoneFrameRenderer, without the pointer's
 * influence (which eases per dot over time, so it needs state a shader does
 * not keep): the shading and motif maths here mirror that file's, and a change
 * to either is made in both. Every WebGL context is a limited resource on a
 * page, so this is for the few large views, not a board of cards.
 */

/** Premultiplied RGBA, each 0..1. */
export type HalftoneInk = readonly [number, number, number, number]

export interface HalftoneGpuField {
  /** Lay the grid out for a canvas already sized to `width` x `height` CSS pixels at `pixelRatio`. */
  resize(width: number, height: number, pixelRatio: number): void
  /** Draw the field at `time`. False when the context is lost and nothing was drawn. */
  draw(time: number): boolean
  dispose(): void
}

export interface HalftoneGpuFieldOptions extends Omit<HalftoneRendererOptions, 'color' | 'alphaBands'> {
  ink: HalftoneInk
  /** The context was lost: the canvas is blank and this field is finished. */
  onLost: () => void
}

const VERTEX_SHADER = `
attribute vec2 aCell;
uniform vec2 uGrid;
uniform vec2 uCenter;
uniform vec2 uCenterInverse;
uniform vec2 uOrigin;
uniform float uSpacing;
uniform vec2 uScale;
uniform float uPixelRatio;
uniform float uEpsilon;
uniform float uMotif;
uniform vec3 uAmplitudes;
uniform vec3 uColumnFrequency;
uniform vec3 uRowFrequency;
uniform vec3 uPhase;
uniform vec4 uPulse;
uniform vec3 uLight;
uniform float uContrast;
uniform float uDim;
uniform float uMaxRadius;
uniform float uVignette;
varying float vRadius;
varying float vSize;
varying float vAlpha;

float pulseHeight(vec2 uv) {
  float fromCenter = length(uv - 0.5);
  float band0 = (fromCenter - uPulse.x) * 5.5;
  float band1 = (fromCenter - uPulse.y) * 5.5;
  return exp(-band0 * band0) * uPulse.z + exp(-band1 * band1) * uPulse.w;
}

void main() {
  vec2 uv = aCell / uGrid;
  // The field's height here, and how much it rises one epsilon along x and y.
  float height;
  vec2 rise;
  float baseAlpha;
  float litAlpha;
  float baseRadius;
  float heightRadius;
  float fade = 1.0;
  bool visible = true;

  if (uMotif < 0.5) {
    vec3 phase = uPhase + (uv.x - 0.5) * uColumnFrequency + (uv.y - 0.5) * uRowFrequency;
    vec3 halfX = 0.5 * uEpsilon * uColumnFrequency;
    vec3 halfY = 0.5 * uEpsilon * uRowFrequency;
    height = dot(uAmplitudes, sin(phase)) + 0.65;
    // sin(p + d) - sin(p), as a product: a difference of two single-precision
    // sines would lose the digits the lighting is made of.
    rise = vec2(
      dot(uAmplitudes, 2.0 * cos(phase + halfX) * sin(halfX)),
      dot(uAmplitudes, 2.0 * cos(phase + halfY) * sin(halfY))
    );
    baseAlpha = 0.18;
    litAlpha = 0.74;
    baseRadius = 0.45;
    heightRadius = 1.9;
  } else {
    float pulse = pulseHeight(uv);
    visible = pulse >= 0.05;
    height = pulse * 0.6 + 0.05;
    rise = 0.6 * vec2(
      pulseHeight(uv + vec2(uEpsilon, 0.0)) - pulse,
      pulseHeight(uv + vec2(0.0, uEpsilon)) - pulse
    );
    baseAlpha = 0.12;
    litAlpha = 0.85;
    baseRadius = 0.4;
    heightRadius = 2.2;
    fade = min(1.0, pulse * 1.6);
  }

  vec3 normal = vec3(-rise / uEpsilon, 1.0);
  float lit = max(0.0, dot(normal, uLight) / length(normal));
  float alpha = min(1.0, baseAlpha + lit * litAlpha) * fade;
  float radius = max(0.2, baseRadius + max(0.0, height) * heightRadius);

  alpha = min(1.0, alpha * uContrast * 0.9);
  radius *= uMaxRadius / 2.4;

  float vignette = 1.0;
  if (uVignette > 0.0) {
    float start = 0.4 - uVignette * 0.15;
    float edge = clamp((length((aCell - uCenter) * uCenterInverse) - start) / (1.0 - start), 0.0, 1.0);
    vignette = 1.0 - (edge * edge * (3.0 - 2.0 * edge) * uVignette) / 0.45;
  }
  alpha = min(1.0, alpha * vignette * uDim);
  radius *= 0.35 + 0.65 * vignette;

  if (!visible || vignette <= 0.0 || alpha < 0.02 || radius < 0.2) {
    // Outside the clip volume: the dot is not drawn.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vRadius = 0.0;
    vSize = 0.0;
    vAlpha = 0.0;
    return;
  }

  vec2 position = uOrigin + aCell * uSpacing;
  gl_Position = vec4(position.x * uScale.x - 1.0, 1.0 - position.y * uScale.y, 0.0, 1.0);
  float pixels = radius * uPixelRatio;
  // The sprite covers the disc plus the antialiasing ramp around it.
  float size = ceil(pixels * 2.0) + 2.0;
  gl_PointSize = size;
  vRadius = pixels;
  vSize = size;
  // The fragment shader's one-pixel linear edge covers more than the disc
  // does: pi * (r^2 + 1/12) for r >= 0.5, and a cone of pi * (r + 0.5)^3 / 3
  // below that. Scale alpha back so a dot carries its true area of ink, or
  // the smallest, faintest dots would draw up to half again too heavy.
  float area = pixels * pixels;
  float reach = pixels + 0.5;
  float drawn = pixels >= 0.5 ? area + 1.0 / 12.0 : reach * reach * reach / 3.0;
  vAlpha = alpha * area / drawn;
}
`

const FRAGMENT_SHADER = `
precision mediump float;
uniform vec4 uColor;
varying float vRadius;
varying float vSize;
varying float vAlpha;

void main() {
  float fromCenter = length(gl_PointCoord - 0.5) * vSize;
  float coverage = clamp(vRadius - fromCenter + 0.5, 0.0, 1.0);
  gl_FragColor = uColor * (vAlpha * coverage);
}
`

const UNIFORMS = [
  'uGrid', 'uCenter', 'uCenterInverse', 'uOrigin', 'uSpacing', 'uScale', 'uPixelRatio', 'uEpsilon',
  'uMotif', 'uAmplitudes', 'uColumnFrequency', 'uRowFrequency', 'uPhase', 'uPulse', 'uLight',
  'uContrast', 'uDim', 'uMaxRadius', 'uVignette', 'uColor',
] as const
type UniformName = (typeof UNIFORMS)[number]

/** Contexts lost this many times stop being asked for: something is wrong with the GPU. */
const MAX_FAILURES = 3
let failures = 0

/** Whether a halftone may draw on the GPU here. False sends it to Canvas2D. */
export function halftoneGpuAvailable(): boolean {
  return failures < MAX_FAILURES && typeof WebGLRenderingContext !== 'undefined'
}

const inkCache = new Map<string, HalftoneInk | null>()
let inkProbe: CanvasRenderingContext2D | null | undefined

/** Resolve any CSS colour to premultiplied RGBA, or null where it cannot be read. */
export function parseHalftoneInk(color: string): HalftoneInk | null {
  const cached = inkCache.get(color)
  if (cached !== undefined) return cached
  if (inkProbe === undefined) {
    const probe = document.createElement('canvas')
    probe.width = 1
    probe.height = 1
    inkProbe = probe.getContext('2d', { willReadFrequently: true })
  }
  let ink: HalftoneInk | null = null
  if (inkProbe) {
    inkProbe.clearRect(0, 0, 1, 1)
    inkProbe.fillStyle = color
    inkProbe.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = inkProbe.getImageData(0, 0, 1, 1).data
    const alpha = a / 255
    ink = [(r / 255) * alpha, (g / 255) * alpha, (b / 255) * alpha, alpha]
  }
  if (inkCache.size >= 64) inkCache.clear()
  inkCache.set(color, ink)
  return ink
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  gl.deleteShader(shader)
  return null
}

const TAU = Math.PI * 2

/**
 * Take over `canvas` (which must not already have a rendering context of
 * another kind) and draw the field into it. Null when WebGL is unavailable or
 * only available in software, where Canvas2D is the better path.
 */
export function createHalftoneGpuField(
  canvas: HTMLCanvasElement,
  options: HalftoneGpuFieldOptions
): HalftoneGpuField | null {
  if (!halftoneGpuAvailable()) return null
  let gl: WebGLRenderingContext | null = null
  try {
    gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
      failIfMajorPerformanceCaveat: true,
    })
  } catch {
    gl = null
  }
  if (!gl || gl.isContextLost()) return null
  const context = gl

  const vertex = compile(context, context.VERTEX_SHADER, VERTEX_SHADER)
  const fragment = compile(context, context.FRAGMENT_SHADER, FRAGMENT_SHADER)
  const program = context.createProgram()
  const cells = context.createBuffer()
  const release = () => {
    if (vertex) context.deleteShader(vertex)
    if (fragment) context.deleteShader(fragment)
    if (program) context.deleteProgram(program)
    if (cells) context.deleteBuffer(cells)
  }
  if (!vertex || !fragment || !program || !cells) {
    release()
    return null
  }
  context.attachShader(program, vertex)
  context.attachShader(program, fragment)
  context.bindAttribLocation(program, 0, 'aCell')
  context.linkProgram(program)
  if (!context.getProgramParameter(program, context.LINK_STATUS)) {
    release()
    return null
  }

  const uniforms = {} as Record<UniformName, WebGLUniformLocation | null>
  for (const name of UNIFORMS) uniforms[name] = context.getUniformLocation(program, name)

  const spacing = options.spacing ?? 6
  const { rotationAngle, seedTime } = halftoneSeedPhase(options.seed ?? 0)
  const frequencies = flowWaveFrequencies(Math.cos(rotationAngle), Math.sin(rotationAngle))
  const pulse = options.motif === 'pulse'
  const pulseFrame: PulseFrame = { radius0: 0, radius1: 0, weight0: 0, weight1: 0 }

  context.useProgram(program)
  context.disable(context.DEPTH_TEST)
  context.enable(context.BLEND)
  // Premultiplied source over, as Canvas2D composites.
  context.blendFunc(context.ONE, context.ONE_MINUS_SRC_ALPHA)
  context.clearColor(0, 0, 0, 0)
  context.uniform1f(uniforms.uMotif, pulse ? 1 : 0)
  context.uniform1f(uniforms.uSpacing, spacing)
  context.uniform3f(uniforms.uAmplitudes, FLOW_AMPLITUDES[0], FLOW_AMPLITUDES[1], FLOW_AMPLITUDES[2])
  context.uniform3f(uniforms.uColumnFrequency, frequencies.column[0], frequencies.column[1], frequencies.column[2])
  context.uniform3f(uniforms.uRowFrequency, frequencies.row[0], frequencies.row[1], frequencies.row[2])
  context.uniform3f(uniforms.uLight, HALFTONE_LIGHT[0], HALFTONE_LIGHT[1], HALFTONE_LIGHT[2])
  context.uniform1f(uniforms.uContrast, options.contrast ?? 1.6)
  context.uniform1f(uniforms.uDim, options.dim ?? (options.state === 'idle' ? 0.65 : 1))
  context.uniform1f(uniforms.uMaxRadius, options.maxRadius ?? 1.6)
  context.uniform1f(uniforms.uVignette, options.vignette ?? 0.22)
  context.uniform4f(uniforms.uColor, options.ink[0], options.ink[1], options.ink[2], options.ink[3])
  context.bindBuffer(context.ARRAY_BUFFER, cells)
  context.enableVertexAttribArray(0)
  context.vertexAttribPointer(0, 2, context.FLOAT, false, 0, 0)

  let layout: HalftoneGridLayout | null = null
  let dotCount = 0
  let disposed = false

  const onContextLost = (event: Event) => {
    // Nothing restores this context: the caller redraws on Canvas2D instead.
    event.preventDefault()
    if (disposed) return
    failures++
    options.onLost()
  }
  canvas.addEventListener('webglcontextlost', onContextLost)

  return {
    resize(width, height, pixelRatio) {
      if (disposed || context.isContextLost()) return
      const next = halftoneGridLayout(width, height, spacing)
      if (!layout || next.columns !== layout.columns || next.rows !== layout.rows) {
        const grid = new Float32Array(next.columns * next.rows * 2)
        let index = 0
        for (let row = 0; row < next.rows; row++) {
          for (let column = 0; column < next.columns; column++) {
            grid[index++] = column
            grid[index++] = row
          }
        }
        context.bufferData(context.ARRAY_BUFFER, grid, context.STATIC_DRAW)
      }
      layout = next
      dotCount = next.columns * next.rows
      context.viewport(0, 0, context.drawingBufferWidth, context.drawingBufferHeight)
      context.uniform2f(uniforms.uGrid, next.columns, next.rows)
      context.uniform2f(uniforms.uCenter, next.centerColumn, next.centerRow)
      context.uniform2f(
        uniforms.uCenterInverse,
        next.centerColumn === 0 ? 0 : 1 / next.centerColumn,
        next.centerRow === 0 ? 0 : 1 / next.centerRow
      )
      context.uniform2f(uniforms.uOrigin, next.offsetX, next.offsetY)
      context.uniform2f(uniforms.uScale, 2 / width, 2 / height)
      context.uniform1f(uniforms.uPixelRatio, pixelRatio)
      context.uniform1f(uniforms.uEpsilon, next.epsilon)
    },

    draw(time) {
      if (disposed || !layout || context.isContextLost()) return false
      const fieldTime = time + seedTime
      if (pulse) {
        updatePulseFrame(fieldTime, pulseFrame)
        context.uniform4f(
          uniforms.uPulse,
          pulseFrame.radius0, pulseFrame.radius1, pulseFrame.weight0, pulseFrame.weight1
        )
      } else {
        // Wrapped here in double precision: a shader's single-precision phase
        // would grow coarse as the animation's clock runs on for hours.
        context.uniform3f(
          uniforms.uPhase,
          (FLOW_ORIGINS[0] + fieldTime * FLOW_TIME_RATES[0]) % TAU,
          (FLOW_ORIGINS[1] + fieldTime * FLOW_TIME_RATES[1]) % TAU,
          (FLOW_ORIGINS[2] + fieldTime * FLOW_TIME_RATES[2]) % TAU
        )
      }
      context.clear(context.COLOR_BUFFER_BIT)
      context.drawArrays(context.POINTS, 0, dotCount)
      return true
    },

    dispose() {
      if (disposed) return
      disposed = true
      canvas.removeEventListener('webglcontextlost', onContextLost)
      // The canvas, and so this context, may be handed to the next field: free
      // what this one made, leave the context itself alive.
      if (!context.isContextLost()) release()
    },
  }
}
