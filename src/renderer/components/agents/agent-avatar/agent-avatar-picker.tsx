import { useRef, useState } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@shared/lib/utils/cn'
import type { ApiAgent } from '@shared/lib/types/api'
import type { AgentAvatar } from '@shared/lib/types/agent-avatar'
import { useUpdateAgentAvatar } from '@renderer/hooks/use-agents'

import { AvatarView, orbRestingPhi, type AvatarMotionState } from './agent-avatar'
import { avatarSource } from './avatar-source'
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
  agent,
  state,
  size,
}: {
  agent: Pick<ApiAgent, 'slug' | 'name' | 'avatar'>
  state?: AvatarMotionState
  size?: number
}) {
  const saved = agent.avatar
  const update = useUpdateAgentAvatar()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<AgentAvatar>(saved)
  const openedWith = useRef(saved)
  const [previewing, setPreviewing] = useState<string | null>(null)

  const openChange = (next: boolean) => {
    // Start from the server's current choice, and save the pair atomically.
    if (next) {
      openedWith.current = saved
      setDraft(saved)
    } else if (draft.color !== openedWith.current.color || draft.shape !== openedWith.current.shape) {
      // A remote update while open must not turn an untouched draft into a save.
      update.mutate({ slug: agent.slug, avatar: draft })
    }
    setPreviewing(null)
    setOpen(next)
  }

  const option = (avatar: AgentAvatar, label: string, pressed: boolean) => {
    const id = `${avatar.color}:${avatar.shape}`
    return (
      <button
        key={id}
        type="button"
        aria-pressed={pressed}
        aria-label={label}
        title={label}
        onClick={() => setDraft(avatar)}
        onMouseEnter={() => setPreviewing(id)}
        onFocus={() => setPreviewing(id)}
        className={cn(
          'flex items-center justify-center rounded-md p-2 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
          pressed && 'bg-accent',
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

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Change ${agent.name}'s avatar`}
          title="Change avatar"
          data-testid="agent-avatar-picker"
          disabled={update.isPending}
          className="shrink-0 rounded-md outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* While picking, the avatar itself shows the draft. */}
          <AvatarView source={avatarSource(open || update.isPending ? draft : saved)} restingPhi={orbRestingPhi(agent.slug)} size={size} state={state} />
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
          {ORB_SHAPES.map(shape => option({ ...draft, shape: shape.name }, shape.label, draft.shape === shape.name))}
        </div>
        <div className="px-2 pb-1 pt-2 text-xs text-muted-foreground">Color</div>
        <div className="grid grid-cols-4 gap-1">
          {OFFERED_ORBS.map(orb => option({ ...draft, color: orb.name }, orb.label, draft.color === orb.name))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
