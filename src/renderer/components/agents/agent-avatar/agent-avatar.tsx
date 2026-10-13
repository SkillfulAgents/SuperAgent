import { useAvatarChoice } from './avatar-choice-store'
import { avatarForId, orbId, type AvatarId, type AvatarSource } from './avatar-ids'
import { DEFAULT_ORBS } from './avatar-orbs'
import { ORB_SHAPES } from './orb-shapes'
import { OrbAvatar, type AvatarMotionState } from './orb-avatar'

export type { AvatarMotionState } from './orb-avatar'

// Stable per-slug numbers for an agent's colour, shape and gaze: FNV-1a, then
// MurmurHash3's finaliser. FNV-1a alone leaves the low bits poorly mixed, and
// `% n` reads exactly those, so a small palette came out badly uneven.
function hashSeed(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

/**
 * An agent's own avatar: a plain colour (no duos) and a shape drawn from its
 * slug, as its resting gaze is. The slug never changes, so this is fixed from the moment
 * the agent exists — the same on every device and for every teammate, and
 * untouched when other agents come and go. Separate salts keep colour, shape
 * and gaze from moving in step.
 */
export function agentAvatarId(slug: string): AvatarId {
  const colour = DEFAULT_ORBS[hashSeed(`${slug}:colour`) % DEFAULT_ORBS.length]
  const shape = ORB_SHAPES[hashSeed(`${slug}:shape`) % ORB_SHAPES.length]
  return orbId(colour, shape.name)
}

function useAvatarSource(slug: string): AvatarSource {
  const chosen = useAvatarChoice(slug)
  return avatarForId(chosen ?? agentAvatarId(slug))!
}

/** An orb's resting gaze, degrees (0 = right): stable per seed, any direction. */
export function orbRestingPhi(seed: string): number {
  return (hashSeed(`${seed}:gaze`) % 300) - 240
}

interface AvatarViewProps {
  /** Diameter in px. */
  size?: number
  state?: AvatarMotionState
  /** Follow the cursor: `true` anywhere in the window, or a selector for an ancestor region to follow within. */
  followPointer?: boolean | string
  className?: string
}

/**
 * An agent's avatar: its own colour and shape (see agentAvatarId), or one
 * picked for it on this device. `state` drives motion (typing dots while
 * working, knocking while awaiting input, and so on). Decorative — status text
 * elsewhere carries the accessible status, since motion alone isn't one.
 */
export function AgentAvatar({ slug, ...rest }: { slug: string } & AvatarViewProps) {
  return <AvatarView source={useAvatarSource(slug)} restingPhi={orbRestingPhi(slug)} {...rest} />
}

/** Draws an avatar source. */
export function AvatarView({
  source,
  restingPhi = -90,
  size = 20,
  ...rest
}: { source: AvatarSource; restingPhi?: number } & AvatarViewProps) {
  return <OrbAvatar orb={source.orb} shape={source.shape} diameter={size} restingPhi={restingPhi} {...rest} />
}
