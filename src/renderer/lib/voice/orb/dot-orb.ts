/**
 * The dot orb behind the voice-mode mic: a tumbling Fibonacci sphere of
 * coloured dots whose hue field is locked to the surface, drawn on a 2D
 * canvas. One port of the design handoff's `voice-states.html`, kept as
 * plain data and maths so React only has to own a canvas and a clock.
 *
 * Invariants, each with a measured failure behind it (see the handoff):
 * hidden-surface culling happens at the horizon plane `-1/FOV`, not the
 * equator; dot radius scales with both `sqrt(4π/N)` and `sqrt(cos tilt)`;
 * hue and ripple origins are computed from UNROTATED coordinates; the dot
 * pass is source-over; rotation is delta-time driven; hues are built once.
 */

const TAU = Math.PI * 2
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
/** Weak perspective: `s = FOV / (FOV + z)`, +z away from the camera. */
const FOV = 3.2
/**
 * Sphere radius as a fraction of the canvas. The rest is room for the stir
 * and ring lift (capped together at +30%) seen through perspective, which
 * brings a lifted near dot out to about 1.37 radii on screen.
 */
const RADIUS_OF_SIZE = 0.35
/** Dots per square CSS pixel of sphere radius: the handoff's lattices, solved for radius. */
const DOT_DENSITY = 0.9
const SHADE_MIN_L = 0.6
const SPLOTCH = 0.46

/** How long the particles take to swirl in and settle into the sphere. */
export const BOOT_DURATION_S = 1.25
/**
 * A beat before the particles start moving, scattered where they are: the
 * composer's own fade-in takes about this long, so none of the assembly is
 * spent behind it.
 */
export const BOOT_HOLD_S = 0.35
/** How far out a particle's burst carries it before the vortex takes it, in sphere radii; never past what the disc can hold. */
const BOOT_BURST_MIN = 0.85
const BOOT_BURST_MAX = 1.2
/** How far round a particle spirals over its whole flight, in radians. */
const BOOT_SWIRL_MIN = 2.6
const BOOT_SWIRL_MAX = 4.6
/** The vortex's own turn, in radians a second, on top of each particle's spiral. */
const BOOT_ORBIT_RATE = 1.1
/** How small a particle is when it leaves the origin, relative to its settled dot. */
const BOOT_SEED_SCALE = 0.35
/** How quickly colour drains or returns when the orb is switched to or from greyscale. */
const CHROMA_TAU_S = 0.35

const RIPPLE_SPEED = 1.15
const RIPPLE_WIDTH = 0.5
const RIPPLE_LIFE_S = 2.4
const RIPPLE_LIFT = 0.1
const MAX_RIPPLES = 7

/** Peak radial displacement while the person talks, as a fraction of the radius. */
const STIR_GAIN = 0.26
/** Stir and ring lift together never push a dot past this, so the disc always holds it. */
const MAX_RADIAL = 1.3
/** Perlin's practical swing; normalised so the shaping exponent sees the whole range. */
const STIR_NORM = 0.72
/** Above 1: the calm middle drops while the extremes stay, which reads as relief. */
const STIR_SHAPE = 1.38

export type DotOrbState = 'boot' | 'ready' | 'thinking' | 'user' | 'agent'
/**
 * What the orb sits on. The canvas itself is transparent; the ground only
 * chooses the ramp. The design is emissive on black: dots dim toward the limb
 * by fading toward the ground. On a light ground the dots are ink instead,
 * most vivid at the centre and paling toward the rim; everything else
 * (lattice, hold, stir, rings) is unchanged.
 */
export type DotOrbGround = 'dark' | 'light'

interface StateTuning {
  /** Drift rates: tumble multiplier and hue cycle in degrees a second. The orb keeps turning through a speaking turn. */
  spin: number
  hue: number
  bright: number
  sat: number
  /** Radius swell per unit of level. */
  grow: number
  /** Seconds between outward rings while the level is up; 0 emits none. */
  spawnEvery: number
  breathe: boolean
}

/** Every knob a state can turn, side by side. */
const STATES: Record<DotOrbState, StateTuning> = {
  boot: { spin: 0.3, hue: 26, bright: 0.9, sat: 95, grow: 0, spawnEvery: 0, breathe: false },
  ready: { spin: 0.45, hue: 14, bright: 0.78, sat: 88, grow: 0, spawnEvery: 0, breathe: true },
  // Not in the handoff: the agent working with nothing to say yet. The ready
  // treatment at a brisker tumble, so the turn's pace shows without borrowing
  // either speaking state's cue (colour as state was rejected there).
  thinking: { spin: 1.1, hue: 20, bright: 0.84, sat: 90, grow: 0, spawnEvery: 0, breathe: false },
  user: { spin: 0.72, hue: 6, bright: 0.92, sat: 95, grow: 0, spawnEvery: 0, breathe: false },
  agent: { spin: 1.25, hue: 60, bright: 1.04, sat: 97, grow: 0.05, spawnEvery: 0.15, breathe: false },
}

// ── Perlin, the same field as the handoff ────────────────────────────────
const GRAD3 = new Int8Array([1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1])

function makeNoise3(seed: number): (x: number, y: number, z: number) => number {
  const p = new Uint8Array(256)
  const perm = new Uint8Array(512)
  for (let i = 0; i < 256; i++) p[i] = i
  let st = (seed >>> 0) || 1
  const rnd = () => { st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0; return st / 4294967296 }
  for (let i = 255; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; const t = p[i]; p[i] = p[j]; p[j] = t }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]
  const fade = (u: number) => u * u * u * (u * (u * 6 - 15) + 10)
  const grad = (h: number, x: number, y: number, z: number) => { const k = (h % 12) * 3; return GRAD3[k] * x + GRAD3[k + 1] * y + GRAD3[k + 2] * z }
  const lerp = (a: number, b: number, m: number) => a + m * (b - a)
  return (x, y, z) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z)
    const u = fade(x), v = fade(y), w = fade(z)
    const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z
    const B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z
    return lerp(
      lerp(lerp(grad(perm[AA], x, y, z), grad(perm[BA], x - 1, y, z), u), lerp(grad(perm[AB], x, y - 1, z), grad(perm[BB], x - 1, y - 1, z), u), v),
      lerp(lerp(grad(perm[AA + 1], x, y, z - 1), grad(perm[BA + 1], x - 1, y, z - 1), u), lerp(grad(perm[AB + 1], x, y - 1, z - 1), grad(perm[BB + 1], x - 1, y - 1, z - 1), u), v),
      w,
    )
  }
}
const noise3 = makeNoise3(20260819)

function fbm3(x: number, y: number, z: number, octaves: number): number {
  let f = 1.75, a = 1, sum = 0, norm = 0
  for (let o = 0; o < octaves; o++) { sum += a * noise3(x * f, y * f, z * f); norm += a; f *= 2.13; a *= 0.52 }
  return sum / norm
}

/**
 * The palette's share of the wheel given to reds and yellows (hues 330°
 * through 70°). At 1 every hue gets equal time; below it that arc is
 * compressed and the rest of the spectrum (greens, cyans, blues, magentas)
 * fills the difference, so the orb spends less of its cycle warm.
 */
const WARM_SHARE = 0.3
const WARM_START = 330
const WARM_END = 70

/** Hue lookup, 0..359 in → warped hue out, built once. */
const HUE_WARP: Float32Array = (() => {
  // Walk the output wheel accumulating "time"; warm degrees cost less, so
  // a uniform input sweep passes through them faster.
  const cost = (h: number) => (h >= WARM_START || h < WARM_END ? WARM_SHARE : 1)
  let total = 0
  for (let h = 0; h < 360; h++) total += cost(h)
  const table = new Float32Array(360)
  let acc = 0
  let out = 0
  for (let i = 0; i < 360; i++) {
    const target = (i / 360) * total
    while (acc + cost(out) <= target && out < 359) { acc += cost(out); out++ }
    table[i] = out
  }
  return table
})()

/** Deterministic hash in [0, 1) from a dot's index and a salt. */
function hash(i: number, salt: number): number {
  const h = Math.sin(i * salt) * 43758.5453
  return h - Math.floor(h)
}

function stirShape(n: number): number {
  const v = Math.max(-1, Math.min(1, n / STIR_NORM))
  return (v < 0 ? -1 : 1) * Math.pow(Math.abs(v), STIR_SHAPE)
}

/** Dots for a sphere of this radius (CSS px): the lattice stays at one density at every size. */
export function dotsForRadius(radius: number): number {
  return Math.max(200, Math.min(9000, Math.round(DOT_DENSITY * radius * radius)))
}

/**
 * A speech-shaped loudness curve for a reply whose audio this window cannot
 * meter (the chained engine plays through the reader): syllables inside word
 * gates under a slow drift. Deterministic in `t`.
 */
export function syntheticEnvelope(t: number, seed = 0): number {
  const word = (t * 0.62 + seed) % 1
  const gate = word < 0.72 ? Math.min(1, Math.min(word, 0.72 - word) / 0.09) : 0
  const syllable = 0.5 + 0.5 * Math.sin(t * TAU * 4.1 + seed * 7.3)
  const syllable2 = 0.5 + 0.5 * Math.sin(t * TAU * 6.7 + seed * 3.1)
  const drift = 0.62 + 0.38 * Math.sin(t * 0.83 + seed * 2.7)
  return gate * (0.3 + 0.7 * (0.65 * syllable + 0.35 * syllable2)) * drift
}

const ATTACK_TAU_S = 0.045
const RELEASE_TAU_S = 0.16

/**
 * One step of the level smoothing: attack faster than release, so the orb
 * reads as tracking the voice rather than lagging it, and frame-rate
 * independent, so a 120 Hz display does not double the speed.
 */
export function smoothLevel(current: number, target: number, dt: number): number {
  const tau = target > current ? ATTACK_TAU_S : RELEASE_TAU_S
  return current + (target - current) * (1 - Math.exp(-dt / tau))
}

/** Microphone or playback loudness, 0..1, from an analyser's time-domain samples. */
export function readLevel(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buffer)
  let sum = 0
  for (let i = 0; i < buffer.length; i++) {
    const v = (buffer[i] - 128) / 128
    sum += v * v
  }
  // Speech sits around 0.05–0.3 RMS; map that to most of the range.
  return Math.min(1, Math.sqrt(sum / buffer.length) * 4)
}

interface Ripple { x: number; y: number; z: number; t0: number; amp: number }

/** The subset of a 2D context the orb paints with, so tests can hand in a recorder. */
export type DotOrbContext = Pick<CanvasRenderingContext2D, 'fillStyle' | 'clearRect' | 'beginPath' | 'arc' | 'fill'>

export class DotOrb {
  readonly size: number
  readonly count: number
  private state: DotOrbState = 'ready'
  private ground: DotOrbGround = 'dark'
  /** 1 = full colour, 0 = greyscale; eased toward `monochrome` each step. */
  private chroma = 1
  private monochrome = false
  /** A state asked for mid-assembly, applied when the sphere has knitted. */
  private pendingState: DotOrbState | null = null
  private clock = 0
  private bootT = 0
  private spawnAcc = 0
  private level = 0
  private ax = 0.35
  private ay = 0.6
  private az = 0.1
  private hueOffset = 0
  private ripples: Ripple[] = []
  private readonly m = new Float64Array(9)
  // The lattice, in unrotated object space.
  private readonly px: Float32Array
  private readonly py: Float32Array
  private readonly pz: Float32Array
  private readonly hue0: Float32Array
  // Each particle's own assembly: when it sets off, how far its burst carries
  // it, and how far it spirals over the flight.
  private readonly stagger: Float32Array
  private readonly burst: Float32Array
  private readonly swirl: Float32Array
  // Per-frame scratch, allocated once.
  private readonly sx: Float32Array
  private readonly sy: Float32Array
  private readonly sz: Float32Array
  private readonly sr: Float32Array
  private readonly ss: Float32Array
  /** How ghosted each dot is this frame, 0 solid..1 gone: particles in flight, and the far side of the swirl. */
  private readonly sghost: Float32Array
  private readonly order: number[] = []

  constructor(size: number, count = dotsForRadius(size * RADIUS_OF_SIZE)) {
    this.size = size
    this.count = count
    const n = count
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.pz = new Float32Array(n)
    this.hue0 = new Float32Array(n); this.stagger = new Float32Array(n)
    this.burst = new Float32Array(n); this.swirl = new Float32Array(n)
    this.sx = new Float32Array(n); this.sy = new Float32Array(n); this.sz = new Float32Array(n)
    this.sr = new Float32Array(n); this.ss = new Float32Array(n); this.sghost = new Float32Array(n)

    const denom = n > 1 ? n - 1 : 1
    // Octaves are capped by what the lattice resolves: the finest at about
    // three dot spacings, below which splotches alias into per-dot speckle.
    const spacing = Math.sqrt(4 * Math.PI / n)
    let octaves = 1
    while (octaves < 4 && 1 / (1.75 * Math.pow(2.13, octaves)) > spacing * 3) octaves++
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / denom) * 2
      const r = Math.sqrt(Math.max(0, 1 - y * y))
      const theta = i * GOLDEN_ANGLE
      const x = Math.cos(theta) * r
      const z = Math.sin(theta) * r
      this.px[i] = x; this.py[i] = y; this.pz[i] = z
      // A linear gradient (not a longitude sweep, which seams at ±π), faded
      // but never dropped under the splotch so the orb stays one object.
      const linear = 110 * x + 40 * y + 35 * z
      this.hue0[i] = linear * (1 - 0.6 * SPLOTCH) + fbm3(x, y, z, octaves) * 340 * SPLOTCH
      // Three independent hashes per dot, so departure time, burst reach and
      // spiral length are uncorrelated and the flight reads as particles, not
      // as a shape scaling.
      const h1 = hash(i, 12.9898), h2 = hash(i, 78.233), h3 = hash(i, 37.719)
      this.stagger[i] = h1
      this.burst[i] = BOOT_BURST_MIN + (BOOT_BURST_MAX - BOOT_BURST_MIN) * h2
      this.swirl[i] = BOOT_SWIRL_MIN + (BOOT_SWIRL_MAX - BOOT_SWIRL_MIN) * h3
    }
  }

  get currentState(): DotOrbState { return this.state }
  /** Where the spectrum sits, in degrees; it drifts in every state. */
  get hue(): number { return this.hueOffset }
  get bootDone(): boolean { return this.state !== 'boot' || this.bootT >= BOOT_DURATION_S }
  get liveRipples(): number { return this.ripples.length }

  setGround(ground: DotOrbGround): void {
    this.ground = ground
  }

  /** Drain the orb to greyscale, or let its colour back in; the change eases over a few hundred milliseconds. */
  setMonochrome(monochrome: boolean): void {
    this.monochrome = monochrome
  }

  setState(next: DotOrbState): void {
    if (next === this.state) { this.pendingState = null; return }
    if (next === 'boot') { this.bootT = -BOOT_HOLD_S; this.ripples.length = 0 }
    else if (!this.bootDone) { this.pendingState = next; return }
    this.state = next
    this.pendingState = null
    this.spawnAcc = 0
  }

  /** Smoothed loudness of whoever is speaking, 0..1. The caller meters and smooths it. */
  setLevel(level: number): void {
    this.level = Math.max(0, Math.min(1, level))
  }

  /** One outward ring from the point facing the camera. */
  pulse(amp = 1): void {
    if (this.ripples.length >= MAX_RIPPLES) this.ripples.shift()
    const m = this.m
    // The impact point lives in object space, like the hue, so the ring
    // tumbles with the surface instead of sitting on the glass.
    this.ripples.push({ x: -m[6], y: -m[7], z: -m[8], t0: this.clock, amp })
  }

  step(dt: number): void {
    const S = STATES[this.state]
    this.clock += dt
    this.chroma += ((this.monochrome ? 0 : 1) - this.chroma) * (1 - Math.exp(-dt / CHROMA_TAU_S))

    if (this.state === 'boot') {
      const wasAssembling = this.bootT < BOOT_DURATION_S
      this.bootT += dt
      if (wasAssembling && this.bootT >= BOOT_DURATION_S) {
        // Assembly ends on one outward pulse, then the orb holds a slow idle
        // until whatever was asked for during it (or nothing) arrives.
        this.pulse(1.1)
        if (this.pendingState) this.setState(this.pendingState)
      }
    } else if (this.state === 'agent' && S.spawnEvery > 0) {
      this.spawnAcc += dt
      if (this.level > 0.3 && this.spawnAcc >= S.spawnEvery) {
        this.spawnAcc = 0
        this.pulse(0.45 + 0.9 * this.level)
      }
    }

    // The tumble and the hue cycle run in every state; the stir and the
    // rings ride on top of them rather than replacing them. A settled boot
    // above may have switched state, so the tuning is read again.
    const tuning = STATES[this.state]
    let spin = tuning.spin
    if (this.state === 'boot') spin = tuning.spin * Math.min(1, this.bootT / BOOT_DURATION_S)
    this.ax += 0.13 * spin * dt
    this.ay += 0.21 * spin * dt
    this.az += 0.077 * spin * dt
    this.hueOffset = (this.hueOffset + tuning.hue * dt) % 360
  }

  draw(ctx: DotOrbContext): void {
    const size = this.size
    const S = STATES[this.state]
    ctx.clearRect(0, 0, size, size)

    const cx = size / 2
    const cy = size / 2
    const bootP = this.state === 'boot' ? Math.max(0, Math.min(1, this.bootT / BOOT_DURATION_S)) : 1
    const bootEase = 1 - Math.pow(1 - bootP, 3)

    let scale = 1
    if (S.breathe) scale = 1 + 0.025 * Math.sin(this.clock * TAU / 3.4)
    else if (S.grow) scale = 1 + S.grow * this.level
    const radius = size * RADIUS_OF_SIZE * scale
    const baseDot = radius * Math.sqrt(4 * Math.PI / this.count) * 0.31

    const cA = Math.cos(this.ax), sA = Math.sin(this.ax)
    const cB = Math.cos(this.ay), sB = Math.sin(this.ay)
    const cC = Math.cos(this.az), sC = Math.sin(this.az)
    const m = this.m
    m[0] = cC * cB; m[1] = cC * sB * sA - sC * cA; m[2] = cC * sB * cA + sC * sA
    m[3] = sC * cB; m[4] = sC * sB * sA + cC * cA; m[5] = sC * sB * cA - cC * sA
    m[6] = -sB; m[7] = cB * sA; m[8] = cB * cA

    let live = 0
    for (let k = 0; k < this.ripples.length; k++) {
      if (this.clock - this.ripples[k].t0 < RIPPLE_LIFE_S) this.ripples[live++] = this.ripples[k]
    }
    this.ripples.length = live

    // The two speaking states act on different axes so they never read as
    // versions of one thing: listening displaces the surface in object space
    // (stir); replying brightens a band in camera space over its rings. Both
    // ride on the tumble, which never stops.
    const listening = this.state === 'user'
    const replying = this.state === 'agent'
    const stirAmp = listening ? STIR_GAIN * this.level : 0
    const stirT = this.clock * 1.15
    const bandHalf = 0.09 + 0.38 * this.level
    const bandGain = 0.26 + 0.7 * this.level

    const order = this.order
    order.length = 0
    for (let i = 0; i < this.count; i++) {
      let x = this.px[i], y = this.py[i], z = this.pz[i]

      // Assembly: every dot is a particle that leaves the origin in its own
      // time, bursts outward along a spiral to its own reach, then is drawn
      // back in through a tightening vortex onto its lattice point. Departures
      // are spread across the boot, so the sphere condenses out of the vortex
      // rather than growing from one place.
      let flight = 0
      if (bootP < 1) {
        let a = (bootP - this.stagger[i] * 0.45) / 0.55
        a = a < 0 ? 0 : a > 1 ? 1 : a
        flight = 1 - a
        if (flight > 0) {
          const reach = this.burst[i]
          let rr: number
          if (a < 0.5) {
            // Out: fast off the mark, slowing toward the reach.
            const u = a / 0.5
            rr = reach * (1 - (1 - u) * (1 - u))
          } else {
            // In: eased both ends, from the reach down to the surface.
            const u = (a - 0.5) / 0.5
            rr = reach + (1 - reach) * (u * u * (3 - 2 * u))
          }
          // The particle's own spiral unwinding to nothing as it lands, plus
          // the vortex's turn on top of it.
          const turn = (this.swirl[i] + BOOT_ORBIT_RATE * (this.bootT + BOOT_HOLD_S)) * flight
          const cw = Math.cos(turn), sw = Math.sin(turn)
          const nx = x * cw + z * sw
          const nz = -x * sw + z * cw
          x = nx * rr; y = y * rr; z = nz * rr
        }
      }

      let radial = 1
      if (stirAmp > 0) {
        const sd = 1 + stirAmp * stirShape(noise3(x * 3.1 + stirT, y * 3.1, z * 3.1))
        x *= sd; y *= sd; z *= sd
        radial = sd
      }

      let crest = 0
      if (live > 0) {
        let lift = 0
        for (let k = 0; k < live; k++) {
          const rp = this.ripples[k]
          const age = this.clock - rp.t0
          let cs = x * rp.x + y * rp.y + z * rp.z
          if (cs > 1) cs = 1; else if (cs < -1) cs = -1
          const u = (Math.acos(cs) - RIPPLE_SPEED * age) / RIPPLE_WIDTH
          if (u < -4 || u > 4) continue
          const fade = 1 - age / RIPPLE_LIFE_S
          const w = Math.exp(-u * u) * fade * fade * Math.min(1, age / 0.05) * rp.amp
          lift += w * Math.cos(u * 2.1)
          crest += w
        }
        if (lift !== 0) { const g = 1 + RIPPLE_LIFT * lift; x *= g; y *= g; z *= g; radial *= g }
      }
      if (radial > MAX_RADIAL) { const back = MAX_RADIAL / radial; x *= back; y *= back; z *= back }

      const zr = m[6] * x + m[7] * y + m[8] * z
      // Hidden-surface cull at the visible horizon, where the eye's tangent
      // cone touches the sphere: z = -1/FOV, not the equator. It is a surface
      // rule: a particle in flight is drawn wherever it is, faded by how far
      // behind that plane it sits, and the fade deepens to nothing as it
      // lands so the cull can take over without a pop.
      let ghost = 0
      if (flight > 0) {
        const behind = Math.max(0, Math.min(1, (zr + 1 / FOV) / 1.3))
        const seen = Math.max(0, 1 - behind / Math.max(flight, 0.05))
        ghost = 1 - seen * (1 - 0.3 * flight)
        if (ghost >= 0.98) continue
      } else if (zr > -1 / FOV) continue
      const s = FOV / (FOV + zr)
      const ct = -(1 + zr * FOV) / Math.sqrt(1 + 2 * zr * FOV + FOV * FOV)
      // A particle in flight is not on the surface: it keeps a body of its
      // own instead of foreshortening away, small when it leaves the origin
      // and growing to its settled size as it lands.
      const facing = ct > 0 ? Math.sqrt(ct) : 0
      let rad = baseDot * s * (flight > 0
        ? Math.max(facing, 0.7 * flight) * (BOOT_SEED_SCALE + (1 - BOOT_SEED_SCALE) * (1 - flight))
        : facing)
      if (rad < 0.3) rad = 0.3
      if (rad > baseDot * 1.6) rad = baseDot * 1.6
      this.sghost[i] = ghost
      // A lifted dot can sit outside the unit sphere: clamp before the root.
      const zc = zr < -1 ? -1 : zr > 1 ? 1 : zr
      const yc = m[3] * x + m[4] * y + m[5] * z
      let shade = (1 - Math.sqrt(1 - zc * zc)) + crest * 0.8
      if (replying) {
        // A thin band survives at zero level on purpose: the gaps between
        // words still read as "still speaking", not as the turn having ended.
        const dd = Math.abs(yc) / bandHalf
        if (dd < 1) shade += (1 - dd * dd) * bandGain
      }
      this.sx[i] = cx + (m[0] * x + m[1] * y + m[2] * z) * radius * s
      this.sy[i] = cy - yc * radius * s
      this.sz[i] = zr
      this.sr[i] = rad
      this.ss[i] = shade
      order.push(i)
    }

    // Far to near: the painter's order is the occlusion.
    const sz = this.sz
    order.sort((a, b) => sz[b] - sz[a])

    const light = this.ground === 'light'
    // Ink on paper takes the full chroma the gamut has: pure hues at
    // mid-lightness, since anything paler washes out against the ground.
    // Colour comes up as the particles land, from a muted start rather than
    // grey; the whole is drained to greyscale while `monochrome` holds.
    const sat = (light ? 100 : S.sat) * (0.5 + 0.5 * bootEase) * this.chroma
    let bright = S.bright * (0.6 + 0.4 * bootEase)
    if (replying) bright *= 0.88 + 0.34 * this.level
    else if (listening) bright *= 0.94 + 0.22 * this.level

    let last = ''
    for (let k = 0; k < order.length; k++) {
      const i = order[k]
      const shade = this.ss[i] < 0 ? 0 : this.ss[i] > 1 ? 1 : this.ss[i]
      let h = (this.hue0[i] + this.hueOffset) % 360
      if (h < 0) h += 360
      h = HUE_WARP[h | 0]
      let L: number
      if (light) {
        // Pure hue at the centre, and the limb darkens rather than pales, so
        // the sphere keeps its relief without a single faded dot. A louder or
        // brighter state deepens the ink a touch instead of lightening it.
        L = Math.max(30, Math.min(56, 56 - 8 * bright - 14 * (1 - shade)))
      } else {
        L = 55 * (SHADE_MIN_L + (1 - SHADE_MIN_L) * shade) * bright
        if (L > 82) L = 82
      }
      // Particles in flight are ghosts of the dots they will be, and the far
      // side of the vortex fades toward the ground: both come up to full
      // strength as they land.
      const ghost = this.sghost[i]
      if (ghost > 0) L = light ? L + (86 - L) * ghost : L * (1 - ghost)
      const colour = `hsl(${h | 0},${sat.toFixed(0)}%,${L.toFixed(1)}%)`
      if (colour !== last) { ctx.fillStyle = colour; last = colour }
      ctx.beginPath()
      ctx.arc(this.sx[i], this.sy[i], this.sr[i], 0, TAU)
      ctx.fill()
    }
  }
}
