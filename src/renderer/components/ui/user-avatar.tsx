import { useState } from 'react'
import { cn } from '@shared/lib/utils'
import { getUserImage, type UserSummary } from '@shared/lib/user-profile-schema'
import { getApiBaseUrl } from '@renderer/lib/env'

const gradients = [
  ['#6475dd', '#9a56b1'], ['#187f88', '#3d8c60'], ['#c16747', '#aa4776'],
  ['#655bc1', '#337cb5'], ['#a26727', '#b35350'], ['#427e62', '#397998'],
]

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
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.34), background: `linear-gradient(145deg, ${from}, ${to})` }}
    >
      {src && src !== failedSrc
        ? <img src={src} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" onError={() => setFailedSrc(src)} />
        : userInitials(user)}
    </span>
  )
}
