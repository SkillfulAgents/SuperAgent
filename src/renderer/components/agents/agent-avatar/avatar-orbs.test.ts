import { describe, expect, it } from 'vitest'

import { DEFAULT_ORBS, OFFERED_ORBS, PAIRED_DUOS } from './avatar-orbs'

describe('avatar colourways', () => {
  it('offers the sixteen-colour palette then eight duos, under unique keys', () => {
    // Six full rows in the picker's four-wide grid: four of the palette, two of duos.
    expect(DEFAULT_ORBS.map(orb => orb.name)).toEqual([
      'tonal-red', 'tonal-orange', 'tonal-amber', 'tonal-green',
      'tonal-forest', 'tonal-teal', 'tonal-blue', 'tonal-cobalt',
      'tonal-purple', 'tonal-blush', 'tonal-pink', 'tonal-brown',
      'tonal-chocolate', 'tonal-white', 'tonal-grey', 'tonal-black',
    ])
    expect(OFFERED_ORBS.map(orb => orb.name)).toEqual([
      ...DEFAULT_ORBS.map(orb => orb.name),
      'duo-red-amber', 'duo-green-amber', 'duo-forest-teal', 'duo-teal-blush',
      'duo-blue-amber', 'duo-cobalt-teal', 'duo-pink-blue', 'duo-brown-amber',
    ])
    expect(new Set(OFFERED_ORBS.map(orb => orb.label)).size).toBe(OFFERED_ORBS.length)
  })

  it('derives the face colours by the design’s rule', () => {
    const red = DEFAULT_ORBS[0]
    expect(red).toMatchObject({ label: 'Red', core: '#FA8274', rim: '#DE0223', hold: 34 })
    // Face A: core 10% toward rim; face B: rim 5% toward core.
    expect(red.faceA).toBe('#F7756C')
    expect(red.faceB).toBe('#DF0827')
    for (const orb of OFFERED_ORBS) {
      for (const colour of [orb.core, orb.rim, orb.faceA, orb.faceB]) expect(colour).toMatch(/^#[0-9A-F]{6}$/)
    }
  })

  it('builds each duo from one palette colour’s rim and another’s core', () => {
    const [redAmber] = PAIRED_DUOS
    expect(redAmber).toMatchObject({ label: 'Red / Amber', rim: DEFAULT_ORBS[0].rim, core: DEFAULT_ORBS[2].core })
  })
})
