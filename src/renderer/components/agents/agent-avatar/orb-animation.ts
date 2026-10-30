import {
  blendFrames, doneFrame, easeInOut, idleFrame, needsInputFrame, restFrame,
  sleepingFrame, workingFrame, type OrbFrame, type OrbState,
} from './orb-states'
import { cubicBezier, FREE_EASE, gazeToward, nearestAngle, type OrbShape, type ShapeGaze } from './orb-shapes'
import { DOTS_CYCLE, DOTS_GATHER, workingPosition } from './orb-working'

const BLEND_MS = 450
const FOLLOW_MS = 360
/** Time constant the shown roll eases toward its target with. */
const ROLL_MS = 120

export interface OrbAnimationConfig {
  shape: OrbShape
  diameter: number
  restingPhi: number
  state: OrbState
  reduced: boolean
}

interface Follow {
  from: ShapeGaze
  to: ShapeGaze
  since: number
}

function stillFrame(state: OrbState, restingPhi: number): OrbFrame {
  if (state === 'sleeping') return sleepingFrame(0)
  if (state === 'done') return doneFrame(2)
  if (state === 'needs-input') return needsInputFrame(0)
  return restFrame(restingPhi)
}

/** Animation state and transitions, independent of React, DOM nodes and frame scheduling. */
export class OrbAnimation {
  last: OrbFrame
  private config: OrbAnimationConfig
  private state: OrbState
  private since: number
  private from: OrbFrame | null = null
  private blendSince = 0
  private lastTick = 0
  private working: { elapsed: number; position: number; ending: boolean; phi: number } | null = null
  private follow: Follow | null = null
  private followEase: (t: number) => number
  private roll = { target: 0, shown: 0 }

  constructor(config: OrbAnimationConfig, now: number) {
    this.config = config
    this.state = config.state
    this.since = now
    this.followEase = cubicBezier(config.shape.snaps ? config.shape.ease : FREE_EASE)
    this.last = config.reduced ? stillFrame(config.state, config.restingPhi) : this.frameFor(0)
    this.configure(config, now)
  }

  /** Update props without restarting an unchanged state's timeline. */
  configure(config: OrbAnimationConfig, now: number) {
    if (this.config.shape !== config.shape || this.config.restingPhi !== config.restingPhi) {
      this.follow = null
      this.followEase = cubicBezier(config.shape.snaps ? config.shape.ease : FREE_EASE)
    }
    this.config = config
    const leaving = this.state
    this.state = config.state
    if (config.reduced) {
      // The stored frame and the painted frame must agree on subsequent prop changes.
      this.last = stillFrame(this.state, config.restingPhi)
      return
    }
    if (leaving === this.state && (this.state !== 'working' || this.working)) return
    const run = this.working
    if (this.state === 'working') {
      if (run) {
        run.ending = false
        run.elapsed = run.position < DOTS_GATHER ? run.position : 0
      } else {
        this.working = { elapsed: 0, position: 0, ending: false, phi: this.last.phi }
        this.blend(now)
      }
      this.follow = null
      return
    }
    if (leaving === 'working' && run && !run.ending) {
      if (run.position < 0.5) this.working = null
      else {
        run.ending = true
        run.position = Math.max(run.position, DOTS_GATHER)
        return
      }
    }
    this.blend(now)
    this.since = now
  }

  get canFollow(): boolean {
    return !this.working && (this.state === 'idle' || this.state === 'done')
  }

  lookAt(dx: number, dy: number, width: number, now: number) {
    if (!this.canFollow) return
    const shown = this.follow ? this.followGaze(now) : this.last
    const target = gazeToward(this.config.shape, shown, dx, dy, width)
    if (this.follow && Math.abs(nearestAngle(this.follow.to.phi, target.phi) - this.follow.to.phi) <= 0.5
      && Math.abs(this.follow.to.distance - target.distance) <= 0.01) return
    this.follow = { from: shown, to: target, since: now }
  }

  /** The face rolls round the rim (degrees, positive = clockwise) when it isn't working or asleep. */
  get canRoll(): boolean {
    return !this.working && this.state !== 'working' && this.state !== 'sleeping'
  }

  rollBy(degrees: number) {
    if (this.canRoll) this.roll.target += degrees
  }

  releasePointer(now: number) {
    if (!this.follow) return
    this.follow = null
    this.blend(now)
  }

  resume(now: number) {
    // Offscreen time must not advance the incremental typing/gather animation in one step.
    this.lastTick = now
  }

  advance(now: number): OrbFrame {
    const dt = this.lastTick ? Math.min(now - this.lastTick, 64) : 16
    this.lastTick = now
    let frame: OrbFrame | null = null
    const run = this.working
    if (run) {
      if (run.ending) {
        run.position += dt / 1000
        if (run.position >= DOTS_CYCLE) {
          this.working = null
          this.blend(now)
          this.since = now
        }
      } else {
        run.elapsed += dt / 1000
        run.position = workingPosition(run.elapsed)
      }
      if (this.working) frame = workingFrame(run.position, this.config.diameter, run.phi)
    }
    if (!frame) frame = this.frameFor((now - this.since) / 1000)
    // A followed pointer is an absolute direction, so the roll steps aside while
    // it leads; the follow starts from the rolled gaze and blends back into it.
    if (this.follow && this.canFollow) frame = { ...frame, ...this.followGaze(now) }
    else if (this.canRoll) {
      this.roll.shown += (this.roll.target - this.roll.shown) * (1 - Math.exp(-dt / ROLL_MS))
      if (this.roll.shown) frame = { ...frame, phi: frame.phi + this.roll.shown }
    }
    if (this.from) {
      const k = (now - this.blendSince) / BLEND_MS
      if (k < 1) frame = blendFrames(this.from, frame, easeInOut(k))
      else this.from = null
    }
    this.last = frame
    return frame
  }

  private blend(now: number) {
    this.from = this.last
    this.blendSince = now
  }

  private frameFor(t: number): OrbFrame {
    const { restingPhi } = this.config
    const phase = (((restingPhi % 360) + 360) % 360) / 360 * 5.3
    if (this.state === 'idle') return idleFrame(t + phase, restingPhi)
    if (this.state === 'sleeping') return sleepingFrame(t + phase)
    if (this.state === 'done') return doneFrame(t)
    if (this.state === 'needs-input') return needsInputFrame(t)
    return restFrame(restingPhi)
  }

  private followGaze(now: number): ShapeGaze {
    const follow = this.follow!
    const duration = this.config.shape.snaps ? this.config.shape.duration : FOLLOW_MS
    const k = this.followEase(Math.min(1, (now - follow.since) / duration))
    return {
      phi: follow.from.phi + (nearestAngle(follow.from.phi, follow.to.phi) - follow.from.phi) * k,
      distance: follow.from.distance + (follow.to.distance - follow.from.distance) * k,
    }
  }
}
