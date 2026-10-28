import { describe, expect, it } from 'vitest'
import { BOOT_DURATION_S, BOOT_HOLD_S, DotOrb, dotsForRadius, readLevel, smoothLevel, syntheticEnvelope, type DotOrbContext } from './dot-orb'

function recorder() {
  const arcs: Array<{ x: number; y: number; r: number }> = []
  const fills: string[] = []
  let cleared = 0
  const ctx = {
    set fillStyle(value: string) { fills.push(value) },
    clearRect: () => { cleared++ },
    beginPath: () => {},
    arc: (x: number, y: number, r: number) => { arcs.push({ x, y, r }) },
    fill: () => {},
  } as unknown as DotOrbContext
  return { ctx, arcs, fills, cleared: () => cleared }
}

function lightnessOf(fills: string[]): number[] {
  return fills.filter((f) => f.startsWith('hsl')).map((f) => Number(/,([\d.]+)%\)$/.exec(f)![1]))
}


function run(orb: DotOrb, seconds: number, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) orb.step(dt)
}

describe('DotOrb', () => {
  it('culls the far side and keeps every drawn dot on the canvas', () => {
    const orb = new DotOrb(64)
    const { ctx, arcs } = recorder()
    orb.step(1 / 60)
    orb.draw(ctx)
    expect(arcs.length).toBeGreaterThan(orb.count * 0.25)
    // Under perspective the visible cap is less than a hemisphere.
    expect(arcs.length).toBeLessThan(orb.count * 0.5)
    for (const { x, y, r } of arcs) {
      expect(x - r).toBeGreaterThanOrEqual(0)
      expect(x + r).toBeLessThanOrEqual(64)
      expect(y - r).toBeGreaterThanOrEqual(0)
      expect(y + r).toBeLessThanOrEqual(64)
    }
  })

  it('assembles inside the disc: no dot leaves the canvas or looms while booting', () => {
    const { ctx, arcs } = recorder()
    const orb = new DotOrb(64)
    orb.setState('boot')
    const settled = 64 * 0.35 * Math.sqrt(4 * Math.PI / orb.count) * 0.31
    for (let t = 0; t < BOOT_HOLD_S + BOOT_DURATION_S; t += 0.1) {
      run(orb, 0.1)
      arcs.length = 0
      orb.draw(ctx)
      expect(arcs.length).toBeGreaterThan(0)
      for (const { x, y, r } of arcs) {
        expect(Math.hypot(x - 32, y - 32) + r).toBeLessThanOrEqual(32)
        expect(r).toBeLessThan(settled * 2)
      }
    }
  })

  it('stays inside the canvas at full stir, full swell and a fresh ring', () => {
    const { ctx, arcs } = recorder()
    for (const state of ['user', 'agent'] as const) {
      const orb = new DotOrb(64)
      orb.setState(state)
      orb.setLevel(1)
      orb.pulse(1.4)
      run(orb, 0.3)
      arcs.length = 0
      orb.draw(ctx)
      for (const { x, y, r } of arcs) {
        expect(Math.hypot(x - 32, y - 32) + r).toBeLessThanOrEqual(32)
      }
    }
  })

  it('keeps the spectrum drifting in every state, speaking turns included', () => {
    const orb = new DotOrb(64)
    for (const state of ['ready', 'user', 'agent', 'thinking'] as const) {
      orb.setState(state)
      const before = orb.hue
      run(orb, 1)
      expect(((orb.hue - before) % 360 + 360) % 360).toBeGreaterThan(3)
    }
  })

  it('assembles once, then applies the state asked for mid-assembly with a pulse', () => {
    const orb = new DotOrb(64)
    orb.setState('boot')
    run(orb, 0.4)
    orb.setState('ready')
    expect(orb.currentState).toBe('boot')
    expect(orb.bootDone).toBe(false)
    run(orb, BOOT_HOLD_S + BOOT_DURATION_S)
    expect(orb.bootDone).toBe(true)
    expect(orb.currentState).toBe('ready')
    expect(orb.liveRipples).toBe(1)
  })

  it('emits rings only while the reply is loud', () => {
    const orb = new DotOrb(64)
    orb.setState('agent')
    orb.setLevel(0.1)
    run(orb, 1)
    expect(orb.liveRipples).toBe(0)
    orb.setLevel(0.8)
    run(orb, 1)
    expect(orb.liveRipples).toBeGreaterThan(3)
  })

  it('paints ink on a light ground over a cleared, transparent canvas', () => {
    const dark = new DotOrb(64)
    const light = new DotOrb(64)
    light.setGround('light')
    dark.step(1 / 60); light.step(1 / 60)
    const onBlack = recorder(); dark.draw(onBlack.ctx)
    const onWhite = recorder(); light.draw(onWhite.ctx)
    expect(onBlack.cleared()).toBe(1)
    expect(onWhite.cleared()).toBe(1)
    expect(onBlack.fills.every((f) => f.startsWith('hsl'))).toBe(true)
    const blackL = lightnessOf(onBlack.fills)
    expect(Math.max(...blackL) - Math.min(...blackL)).toBeGreaterThan(10)
    // Ink on paper: full saturation, pure hue at the centre, darker at the limb.
    expect(onWhite.fills.every((f) => /,100%,/.test(f))).toBe(true)
    const whiteL = lightnessOf(onWhite.fills)
    expect(Math.min(...whiteL)).toBeGreaterThanOrEqual(30)
    expect(Math.max(...whiteL)).toBeLessThanOrEqual(56)
    expect(Math.max(...whiteL) - Math.min(...whiteL)).toBeGreaterThan(8)
  })

  it('drains to greyscale and lets colour back in, easing both ways', () => {
    const orb = new DotOrb(64)
    const saturations = () => {
      const { ctx, fills } = recorder()
      orb.draw(ctx)
      return fills.filter((f) => f.startsWith('hsl')).map((f) => Number(/,(\d+)%,/.exec(f)![1]))
    }
    run(orb, 0.2)
    expect(Math.max(...saturations())).toBeGreaterThan(50)
    orb.setMonochrome(true)
    run(orb, 1 / 60)
    // Eased, not cut: one frame in there is still colour.
    expect(Math.max(...saturations())).toBeGreaterThan(20)
    run(orb, 2)
    expect(Math.max(...saturations())).toBe(0)
    orb.setMonochrome(false)
    run(orb, 2)
    expect(Math.max(...saturations())).toBeGreaterThan(50)
  })

  it('spends far less of its colour cycle on reds and yellows', () => {
    const orb = new DotOrb(64)
    let warm = 0, total = 0
    // A full hue cycle at the ready state's 14°/s takes ~26 s; sample it.
    for (let t = 0; t < 26; t += 0.5) {
      run(orb, 0.5)
      const { ctx, fills } = recorder()
      orb.draw(ctx)
      for (const f of fills) {
        const h = Number(/^hsl\((\d+),/.exec(f)![1])
        total++
        if (h >= 330 || h < 70) warm++
      }
    }
    // Uniform would be 100/360 ≈ 28%; the warp brings it to roughly a third of that.
    expect(warm / total).toBeLessThan(0.14)
    expect(warm / total).toBeGreaterThan(0.04)
  })

  it('draws a different frame for every state without throwing', () => {
    const { ctx, arcs } = recorder()
    for (const state of ['boot', 'ready', 'thinking', 'user', 'agent'] as const) {
      const orb = new DotOrb(48)
      orb.setState(state)
      orb.setLevel(0.7)
      run(orb, 0.5)
      arcs.length = 0
      orb.draw(ctx)
      expect(arcs.length).toBeGreaterThan(50)
    }
  })
})

describe('level helpers', () => {
  it('keeps the lattice at one density across sizes, within bounds', () => {
    expect(dotsForRadius(27)).toBe(656)
    expect(dotsForRadius(5)).toBe(200)
    expect(dotsForRadius(500)).toBe(9000)
  })

  it('attacks faster than it releases, independent of frame rate', () => {
    const up = smoothLevel(0, 1, 1 / 60)
    const down = 1 - smoothLevel(1, 0, 1 / 60)
    expect(up).toBeGreaterThan(down)
    // Two 120 Hz frames land where one 60 Hz frame does.
    const twice = smoothLevel(smoothLevel(0, 1, 1 / 120), 1, 1 / 120)
    expect(twice).toBeCloseTo(up, 6)
  })

  it('reads a sine as its RMS scaled onto 0..1', () => {
    const buffer = new Uint8Array(256)
    const analyser = {
      getByteTimeDomainData(target: Uint8Array) {
        for (let i = 0; i < target.length; i++) target[i] = Math.round(128 + Math.sin(i / 4) * 0.25 * 127)
      },
    } as unknown as AnalyserNode
    // RMS of a sine is amplitude / √2 ≈ 0.177, times four.
    expect(readLevel(analyser, buffer)).toBeCloseTo(0.707, 1)
    analyser.getByteTimeDomainData = (target: Uint8Array) => target.fill(128)
    expect(readLevel(analyser, buffer)).toBe(0)
  })

  it('shapes a synthetic envelope inside 0..1 with silent word gaps', () => {
    let min = 1, max = 0
    for (let t = 0; t < 10; t += 0.01) {
      const v = syntheticEnvelope(t)
      min = Math.min(min, v); max = Math.max(max, v)
    }
    expect(min).toBe(0)
    expect(max).toBeGreaterThan(0.6)
    expect(max).toBeLessThanOrEqual(1)
  })
})
