import { useState } from 'react'
import { cn } from '@shared/lib/utils'
import { getUserImage, type UserSummary } from '@shared/lib/user-profile-schema'
import { getApiBaseUrl } from '@renderer/lib/env'
import { DEFAULT_ORBS, hexMix } from '@renderer/components/agents/agent-avatar/avatar-orbs'

// People without a photo take the agent palette's hues, so faces and orbs
// read as one set: each colourway's rim, lifted 20% toward its core at the
// top-left. Amber and Blush are too light for white initials, and White and
// Black would read as an empty or missing avatar, so they are left out.
const PERSON_COLOURWAYS: ReadonlySet<string> = new Set([
  'tonal-red', 'tonal-orange', 'tonal-green', 'tonal-forest', 'tonal-teal', 'tonal-blue',
  'tonal-cobalt', 'tonal-purple', 'tonal-pink', 'tonal-brown', 'tonal-chocolate', 'tonal-grey',
])
const gradients = DEFAULT_ORBS
  .filter(orb => PERSON_COLOURWAYS.has(orb.name))
  .map(orb => [hexMix(orb.rim, orb.core, 0.2), orb.rim])

export function userInitials(user: Pick<UserSummary, 'name' | 'email'>): string {
  const words = (user.name?.trim() || user.email?.split('@')[0] || '').split(/\s+/).filter(Boolean)
  return (words.length > 1
    ? `${Array.from(words[0])[0]}${Array.from(words[words.length - 1])[0]}`
    : Array.from(words[0] || '?').slice(0, 2).join('')).toLocaleUpperCase()
}

export function UserAvatar({ user, size = 28, className }: {
  user: UserSummary
  size?: number
  className?: string
}) {
  const image = getUserImage(user)
  const src = image?.startsWith('/api/') ? `${getApiBaseUrl()}${image}` : image
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const hash = Array.from(user.id).reduce((value, char) => (Math.imul(value, 31) + char.codePointAt(0)!) >>> 0, 0)
  const [from, to] = gradients[hash % gradients.length]
  return (
    <span
      role="img"
      aria-label={user.name || user.email || 'User'}
      className={cn('relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-medium text-white select-none', className)}
      // A 10px floor keeps initials legible on roomy avatars, but under 20px it
      // overfills the circle, so the small ones (sidebar faces, mention chips)
      // scale with their size instead.
      style={{ width: size, height: size, fontSize: size < 20 ? size * 0.42 : Math.max(10, size * 0.34), background: `linear-gradient(145deg, ${from}, ${to})` }}
    >
      {src && src !== failedSrc
        ? <img src={src} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" onError={() => setFailedSrc(src)} />
        : userInitials(user)}
    </span>
  )
}
