import { OFFERED_ORBS, type AvatarOrb } from './avatar-orbs'
import { ORB_SHAPES, type OrbShape, type OrbShapeName } from './orb-shapes'

/**
 * Names an avatar: `orb:<colourway>[:<shape>]`, no shape meaning the circle.
 * Ids are what gets remembered for a picked avatar.
 */
export type AvatarId = string

/** What an id draws: a colourway on a shape. */
export interface AvatarSource {
  orb: AvatarOrb
  shape: OrbShape
}

export const orbId = (orb: AvatarOrb, shape: OrbShapeName = 'circle'): AvatarId =>
  shape === 'circle' ? `orb:${orb.name}` : `orb:${orb.name}:${shape}`

// One source per id, so a re-render hands the orb the same objects.
const cache = new Map<AvatarId, AvatarSource>()

/** The avatar an id names, or null for an id this build doesn't know (a colour or shape since removed). */
export function avatarForId(id: AvatarId): AvatarSource | null {
  const cached = cache.get(id)
  if (cached) return cached
  if (!id.startsWith('orb:')) return null
  const [, colour, shapeName = 'circle'] = id.split(':')
  const orb = OFFERED_ORBS.find(candidate => candidate.name === colour)
  const shape = ORB_SHAPES.find(candidate => candidate.name === shapeName)
  if (!orb || !shape) return null
  const source = { orb, shape }
  cache.set(id, source)
  return source
}
