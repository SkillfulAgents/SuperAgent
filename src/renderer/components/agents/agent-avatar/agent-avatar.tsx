import type { ApiAgent } from '@shared/lib/types/api'
import { avatarSource, type AvatarSource } from './avatar-source'
import { OrbAvatar, type AvatarMotionState } from './orb-avatar'

export type { AvatarMotionState } from './orb-avatar'

// Stable per-slug resting gaze: FNV-1a, then
// MurmurHash3's finaliser, so similar slugs do not cluster their gaze angles.
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
  /** Roll the face round the rim as the nearest element matching this selector scrolls. */
  rollWithScroll?: string
  className?: string
}

/**
 * An agent's persisted colour and shape. `state` drives motion (typing dots while
 * working, knocking while awaiting input, and so on). Decorative — status text
 * elsewhere carries the accessible status, since motion alone isn't one.
 */
export function AgentAvatar({ agent, ...rest }: { agent: Pick<ApiAgent, 'slug' | 'avatar'> } & AvatarViewProps) {
  if (!agent.avatar) return null
  return <AvatarView source={avatarSource(agent.avatar)} restingPhi={orbRestingPhi(agent.slug)} {...rest} />
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
