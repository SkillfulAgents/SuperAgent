import { describe, expect, it } from 'vitest'
import { DEFAULT_ORBS } from '@renderer/components/agents/agent-avatar/avatar-orbs'
import { avatarHalftoneInk } from './agent-halftone'

const orb = (name: string) => DEFAULT_ORBS.find((o) => o.name === name)!

describe('avatarHalftoneInk', () => {
  it('inks with the deep rim on light and the lighter core on dark', () => {
    const forest = orb('tonal-forest')
    expect(avatarHalftoneInk(forest, false, 0.5).color).toBe(forest.rim)
    expect(avatarHalftoneInk(forest, true, 0.5).color).toBe(forest.core)
  })

  it('draws a colour that stands far from the page fainter than one close to it', () => {
    // On the light page Black's rim stands far out, White's barely: Black is drawn fainter.
    const black = avatarHalftoneInk(orb('tonal-black'), false, 0.5).opacity
    const white = avatarHalftoneInk(orb('tonal-white'), false, 0.5).opacity
    expect(black).toBeLessThan(white)
  })

  it('never goes past full opacity', () => {
    for (const o of DEFAULT_ORBS) {
      for (const dark of [false, true]) {
        expect(avatarHalftoneInk(o, dark, 1).opacity).toBeLessThanOrEqual(1)
      }
    }
  })
})
