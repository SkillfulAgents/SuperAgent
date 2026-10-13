/**
 * Agent orb colourways. Each is usable on any orb shape (see orb-shapes.ts):
 * the rim colours the body, the core its glow, and the two face colours the
 * face's gradient.
 *
 * Colourway rule from the design: face A is the core mixed 10% toward the
 * rim, face B the rim mixed 5% toward the core; lighter cores get a larger
 * solid centre (`hold`, % of radius).
 */

import type { AgentAvatarColor } from '@shared/lib/types/agent-avatar'

export interface AvatarOrb {
  /** Stable persisted key; renames require a data migration. */
  name: AgentAvatarColor
  /** Shown in the picker. */
  label: string
  core: string
  rim: string
  faceA: string
  faceB: string
  hold: number
}

function hexMix(from: string, to: string, t: number): string {
  const channels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  const a = channels(from)
  const b = channels(to)
  return `#${a.map((value, i) => Math.round(value + (b[i] - value) * t).toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

/** A colourway from just a core and a rim, by the design's face rule. */
function colourway(name: AgentAvatarColor, label: string, core: string, rim: string, hold: number): AvatarOrb {
  return { name, label, core, rim, faceA: hexMix(core, rim, 0.1), faceB: hexMix(rim, core, 0.05), hold }
}

/**
 * The palette: tonal colourways (one hue, a lighter core inside a deeper
 * rim), in similarity order. An agent's own look is drawn from these.
 *
 * The design's tile palette with a saturation pass (it read dark in the app):
 * rims a touch lighter and more saturated, cores lifted alongside so faces
 * still read. Forest, Teal and Blush fill gaps the tiles left; Cobalt gives
 * blue a dark partner; Brown is a burnt orange round a deep brown rim, clear
 * of Amber and Orange.
 */
export const DEFAULT_ORBS: readonly AvatarOrb[] = [
  colourway('tonal-red', 'Red', '#FA8274', '#DE0223', 34),
  colourway('tonal-orange', 'Orange', '#FCA864', '#EA490C', 34),
  colourway('tonal-amber', 'Amber', '#FFD065', '#F28307', 34),
  colourway('tonal-green', 'Green', '#98E844', '#0DA13B', 34),
  colourway('tonal-forest', 'Forest', '#0B953D', '#005521', 34),
  colourway('tonal-teal', 'Teal', '#3BE4D9', '#14868D', 34),
  colourway('tonal-blue', 'Blue', '#9CCEFC', '#2B79FA', 34),
  colourway('tonal-cobalt', 'Cobalt', '#4890FC', '#1834DE', 30),
  colourway('tonal-purple', 'Purple', '#C39EFB', '#7A1FFD', 34),
  colourway('tonal-blush', 'Blush', '#FDC4E5', '#FB67C5', 34),
  colourway('tonal-pink', 'Pink', '#FDA0D1', '#F11898', 34),
  colourway('tonal-brown', 'Brown', '#EC7622', '#7D3B0A', 34),
]

/** One palette colour's rim round another's core. */
function pair(name: AgentAvatarColor, rimName: AgentAvatarColor, coreName: AgentAvatarColor): AvatarOrb {
  const find = (name: string) => DEFAULT_ORBS.find(orb => orb.name === name)!
  const rim = find(rimName)
  const core = find(coreName)
  return colourway(
    name,
    `${rim.label} / ${core.label}`,
    core.core,
    rim.rim,
    28,
  )
}

/**
 * Duos: the eight strongest pairings of the palette, with faces that read
 * (core/rim ΔE ≥ 0.31) and the clearest of their rim colour's tonal. At
 * sidebar size a duo still reads as a variant of its rim, so they're picker
 * options only, never an agent's own look.
 */
export const PAIRED_DUOS: readonly AvatarOrb[] = [
  pair('duo-red-amber', 'tonal-red', 'tonal-amber'),
  pair('duo-green-amber', 'tonal-green', 'tonal-amber'),
  pair('duo-forest-teal', 'tonal-forest', 'tonal-teal'),
  pair('duo-teal-blush', 'tonal-teal', 'tonal-blush'),
  pair('duo-blue-amber', 'tonal-blue', 'tonal-amber'),
  pair('duo-cobalt-teal', 'tonal-cobalt', 'tonal-teal'),
  pair('duo-pink-blue', 'tonal-pink', 'tonal-blue'),
  pair('duo-brown-amber', 'tonal-brown', 'tonal-amber'),
]

/** Every colour on offer, as the picker shows them: the palette, then the duos as the last two rows. */
export const OFFERED_ORBS: readonly AvatarOrb[] = [...DEFAULT_ORBS, ...PAIRED_DUOS]
