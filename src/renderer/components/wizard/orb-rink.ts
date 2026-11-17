/**
 * Circles on ice: barely any friction, springy boards, elastic collisions. A
 * held orb follows the pointer as if infinitely heavy, shoving the others
 * aside, and leaves with the pointer's velocity. Pressing an empty patch of
 * ice and sweeping scatters the orbs near it.
 *
 * This is the iOS welcome screen's rink (`OrbRink` in WelcomeOrbCrowd.swift)
 * with the same constants, minus what only a phone has: tilt and haptics.
 * Those constants were tuned for 92pt orbs, so every length here scales with
 * the orb's size and the rink reads the same in a small panel and a large one.
 *
 * Pure simulation: no DOM, no clock of its own. The caller steps it once per
 * frame and reads positions back.
 */

export interface Point {
  x: number
  y: number
}

interface Body {
  x: number
  y: number
  vx: number
  vy: number
}

/** The orb size the iOS constants below were tuned at. */
const TUNED_DIAMETER = 92
/** Velocity lost per second: low, so a flick glides a long way. */
const FRICTION = 0.45
/** Bounce kept off the edges, and off each other. */
const BOARDS = 0.8
const RESTITUTION = 0.9
const MAX_SPEED = 3200
/** A faint wander so a resting rink never quite freezes. */
const WANDER = 5
/** How far a sweep reaches, and how hard it pushes at its centre. */
const SWEEP_REACH = 130
const SWEEP_PUSH = 2600
/** The longest span one step may cover: a late frame must not teleport anything. */
const MAX_STEP = 1 / 30

export class OrbRink {
  width = 0
  height = 0
  diameter = 0

  private bodies: Body[] = []
  private last: number | null = null
  private grabbed: number | null = null
  private grabOffset: Point = { x: 0, y: 0 }
  private target: Point | null = null
  /** The pointer, while it sweeps an empty patch of ice. */
  private sweep: Point | null = null
  private touching = false

  /** `homes` are the orbs' starting spots, as fractions of the rink. */
  constructor(private readonly homes: readonly Point[]) {}

  /** An orb's collision radius: a little inside its drawn circle. */
  private get radius(): number {
    return this.diameter * 0.46
  }

  /** Every tuned length, at this rink's orb size. */
  private get scale(): number {
    return this.diameter / TUNED_DIAMETER
  }

  /**
   * Set the boards and the orbs' size. The first call sets the orbs out on
   * the ice, each with a gentle starting glide; later ones leave them where
   * they are, brought inside the new boards.
   */
  resize(width: number, height: number, diameter: number) {
    this.width = width
    this.height = height
    this.diameter = diameter
    if (!this.bodies.length) {
      this.bodies = this.homes.map((home, index) => {
        const heading = index * 2.39996
        const speed = (18 + (index % 4) * 8) * this.scale
        return { x: home.x * width, y: home.y * height, vx: Math.cos(heading) * speed, vy: Math.sin(heading) * speed }
      })
    }
    const r = this.radius
    for (const body of this.bodies) {
      body.x = Math.min(Math.max(body.x, r), Math.max(width - r, r))
      body.y = Math.min(Math.max(body.y, r), Math.max(height - r, r))
    }
  }

  /** An orb's centre. */
  position(index: number): Point {
    return this.bodies[index] ?? { x: 0, y: 0 }
  }

  /** The orb drawn under a point: the nearest, when two overlap it. */
  orbUnder(x: number, y: number): number | null {
    let hit: number | null = null
    let nearest = Infinity
    this.bodies.forEach((body, index) => {
      const distance = Math.hypot(body.x - x, body.y - y)
      if (distance < this.diameter / 2 && distance < nearest) {
        hit = index
        nearest = distance
      }
    })
    return hit
  }

  /** The pointer is down at `(x, y)`, having gone down at `(startX, startY)`. */
  touch(x: number, y: number, startX: number, startY: number) {
    if (!this.touching) {
      this.touching = true
      this.grabbed = this.orbUnder(startX, startY)
      if (this.grabbed !== null) {
        const body = this.bodies[this.grabbed]
        this.grabOffset = { x: body.x - startX, y: body.y - startY }
      }
    }
    this.sweep = this.grabbed === null ? { x, y } : null
    this.target = { x, y }
  }

  /** The orb the pointer is holding, if any. */
  get held(): number | null {
    return this.grabbed
  }

  /** The pointer lifted, moving at this velocity (px/s): a held orb leaves with it. */
  release(vx: number, vy: number) {
    if (this.grabbed !== null) {
      const body = this.bodies[this.grabbed]
      const limit = MAX_SPEED * this.scale
      const speed = Math.hypot(vx, vy)
      const k = speed > limit ? limit / speed : 1
      body.vx = vx * k
      body.vy = vy * k
    }
    this.touching = false
    this.grabbed = null
    this.sweep = null
    this.target = null
  }

  /** Advance to `now` (ms, any monotonic clock). */
  step(now: number) {
    if (!this.width || !this.height || !this.bodies.length) return
    const dt = Math.min(Math.max((now - (this.last ?? now)) / 1000, 0), MAX_STEP)
    this.last = now
    if (dt <= 0) return

    const t = now / 1000
    const drag = Math.exp(-FRICTION * dt)
    const scale = this.scale
    const reach = SWEEP_REACH * scale

    this.bodies.forEach((body, index) => {
      if (index === this.grabbed && this.target) {
        const x = this.target.x + this.grabOffset.x
        const y = this.target.y + this.grabOffset.y
        body.vx = (x - body.x) / dt
        body.vy = (y - body.y) / dt
        body.x = x
        body.y = y
        return
      }
      const phase = index * 1.7
      body.vx += Math.sin(t * 0.31 + phase) * WANDER * scale * dt
      body.vy += Math.cos(t * 0.27 + phase) * WANDER * scale * dt
      if (this.sweep) {
        const dx = body.x - this.sweep.x
        const dy = body.y - this.sweep.y
        const distance = Math.max(Math.hypot(dx, dy), 1)
        if (distance < reach) {
          const push = (1 - distance / reach) * SWEEP_PUSH * scale * dt
          body.vx += (dx / distance) * push
          body.vy += (dy / distance) * push
        }
      }
      body.vx *= drag
      body.vy *= drag
      body.x += body.vx * dt
      body.y += body.vy * dt
      this.bounce(body)
    })
    this.collide()
  }

  private bounce(body: Body) {
    const r = this.radius
    if (body.x < r) {
      body.x = r
      body.vx = Math.abs(body.vx) * BOARDS
    }
    if (body.x > this.width - r) {
      body.x = this.width - r
      body.vx = -Math.abs(body.vx) * BOARDS
    }
    if (body.y < r) {
      body.y = r
      body.vy = Math.abs(body.vy) * BOARDS
    }
    if (body.y > this.height - r) {
      body.y = this.height - r
      body.vy = -Math.abs(body.vy) * BOARDS
    }
  }

  /** Every orb is the same size, so every collision is between equals: a held one alone does not give way. */
  private collide() {
    const reach = this.radius * 2
    for (let i = 0; i < this.bodies.length; i++) {
      for (let j = i + 1; j < this.bodies.length; j++) {
        const p = this.bodies[i]
        const q = this.bodies[j]
        const dx = q.x - p.x
        const dy = q.y - p.y
        const distance = Math.hypot(dx, dy)
        if (distance >= reach || distance <= 0.001) continue
        const nx = dx / distance
        const ny = dy / distance
        const wp = i === this.grabbed ? 0 : 1
        const wq = j === this.grabbed ? 0 : 1
        const total = wp + wq
        if (!total) continue
        const overlap = reach - distance
        p.x -= (nx * overlap * wp) / total
        p.y -= (ny * overlap * wp) / total
        q.x += (nx * overlap * wq) / total
        q.y += (ny * overlap * wq) / total
        const closing = (q.vx - p.vx) * nx + (q.vy - p.vy) * ny
        if (closing < 0) {
          const impulse = (-(1 + RESTITUTION) * closing) / total
          p.vx -= nx * impulse * wp
          p.vy -= ny * impulse * wp
          q.vx += nx * impulse * wq
          q.vy += ny * impulse * wq
        }
      }
    }
  }
}
