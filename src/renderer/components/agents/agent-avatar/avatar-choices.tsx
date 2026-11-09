import { useState } from 'react'

import { cn } from '@shared/lib/utils/cn'
import type { AgentAvatar } from '@shared/lib/types/agent-avatar'

import { AvatarView, orbRestingPhi } from './agent-avatar'
import { avatarSource } from './avatar-source'
import { OFFERED_ORBS } from './avatar-orbs'
import { ORB_SHAPES } from './orb-shapes'

// Options, px across.
const OPTION_SIZE = 37

interface AvatarChoicesProps {
  value: AgentAvatar
  onChange: (avatar: AgentAvatar) => void
  /** Eight columns from `sm` up, for a page rather than the identity editor's popover. */
  wide?: boolean
}

/**
 * A shape row and the colours, chosen independently — picking a shape keeps
 * the colour and vice versa. Every option follows the cursor; hovering one
 * previews its working motion. Agent Home's identity editor and the create
 * page's name step both show it.
 */
export function AvatarChoices({ value, onChange, wide = false }: AvatarChoicesProps) {
  const [previewing, setPreviewing] = useState<string | null>(null)

  const option = (avatar: AgentAvatar, label: string, pressed: boolean) => {
    const id = `${avatar.color}:${avatar.shape}`
    return (
      <button
        key={id}
        type="button"
        aria-pressed={pressed}
        aria-label={label}
        title={label}
        onClick={() => onChange(avatar)}
        onMouseEnter={() => setPreviewing(id)}
        onFocus={() => setPreviewing(id)}
        className={cn(
          'flex items-center justify-center rounded-item p-2 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
          pressed && 'bg-accent',
          // Stretched columns (the wide grid) would make the hover and
          // selection wider than tall; keep each option square.
          wide && 'aspect-square',
        )}
      >
        <AvatarView
          source={avatarSource(avatar)}
          restingPhi={orbRestingPhi(id)}
          size={OPTION_SIZE}
          state={previewing === id ? 'working' : 'idle'}
          followPointer
        />
      </button>
    )
  }

  const columns = wide ? 'grid-cols-4 sm:grid-cols-8' : 'grid-cols-4'
  return (
    <div onMouseLeave={() => setPreviewing(null)}>
      <div className="px-2 pb-1 pt-0.5 text-xs text-muted-foreground">Shape</div>
      <div className={cn('grid gap-1', columns)}>
        {ORB_SHAPES.map(shape => option({ ...value, shape: shape.name }, shape.label, value.shape === shape.name))}
      </div>
      <div className="px-2 pb-1 pt-2 text-xs text-muted-foreground">Color</div>
      <div className={cn('grid gap-1', columns)}>
        {OFFERED_ORBS.map(orb => option({ ...value, color: orb.name }, orb.label, value.color === orb.name))}
      </div>
    </div>
  )
}
