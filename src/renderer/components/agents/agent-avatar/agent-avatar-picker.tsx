import { useState } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@shared/lib/utils/cn'

import { agentAvatarId, AvatarView, orbRestingPhi, type AvatarMotionState } from './agent-avatar'
import { setAvatarChoice, useAvatarChoice } from './avatar-choice-store'
import { avatarForId, orbId, type AvatarId } from './avatar-ids'
import { OFFERED_ORBS } from './avatar-orbs'
import { ORB_SHAPES } from './orb-shapes'

// Picker options, px across.
const OPTION_SIZE = 37

/**
 * The agent's avatar as a button that opens a picker: a shape row and the
 * colours, chosen independently — picking a shape keeps the colour and vice
 * versa. Choices are a draft, shown in place on the avatar itself, and are
 * kept when the picker closes, by clicking out or Escape. While it's open
 * every option follows the cursor; hovering one previews its working motion.
 */
export function AgentAvatarPicker({
  slug,
  agentName,
  state,
  size,
}: {
  slug: string
  agentName: string
  state?: AvatarMotionState
  size?: number
}) {
  const own = agentAvatarId(slug)
  const saved = useAvatarChoice(slug) ?? own
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<AvatarId>(saved)
  const [previewing, setPreviewing] = useState<AvatarId | null>(null)
  const current = avatarForId(draft)!

  const openChange = (next: boolean) => {
    // Every opening starts from what's saved; closing keeps the draft. The
    // agent's own look needs no stored pick.
    if (next) setDraft(saved)
    else if (draft !== saved) setAvatarChoice(slug, draft === own ? null : draft)
    setPreviewing(null)
    setOpen(next)
  }

  const option = (id: AvatarId, label: string, pressed: boolean) => (
    <button
      key={id}
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={() => setDraft(id)}
      onMouseEnter={() => setPreviewing(id)}
      onFocus={() => setPreviewing(id)}
      className={cn(
        'flex items-center justify-center rounded-md p-2 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
        pressed && 'bg-accent',
      )}
    >
      <AvatarView
        source={avatarForId(id)!}
        restingPhi={orbRestingPhi(id)}
        size={OPTION_SIZE}
        state={previewing === id ? 'working' : 'idle'}
        followPointer
      />
    </button>
  )

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Change ${agentName}'s avatar`}
          title="Change avatar"
          data-testid="agent-avatar-picker"
          className="shrink-0 rounded-md outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* While picking, the avatar itself shows the draft. */}
          <AvatarView source={avatarForId(open ? draft : saved)!} restingPhi={orbRestingPhi(slug)} size={size} state={state} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        // Shapes plus every colour outgrow short windows: scroll within the room Radix measures.
        className="max-h-[var(--radix-popover-content-available-height)] w-auto overflow-y-auto p-2"
        onMouseLeave={() => setPreviewing(null)}
      >
        <div className="px-2 pb-1 pt-0.5 text-xs text-muted-foreground">Shape</div>
        <div className="grid grid-cols-4 gap-1">
          {ORB_SHAPES.map(shape => option(orbId(current.orb, shape.name), shape.label, current.shape === shape))}
        </div>
        <div className="px-2 pb-1 pt-2 text-xs text-muted-foreground">Color</div>
        <div className="grid grid-cols-4 gap-1">
          {OFFERED_ORBS.map(orb => option(orbId(orb, current.shape.name), orb.label, current.orb === orb))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
