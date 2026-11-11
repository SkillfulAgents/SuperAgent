import { forwardRef, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@shared/lib/utils/cn'
import type { ApiAgent } from '@shared/lib/types/api'
import type { AgentAvatar } from '@shared/lib/types/agent-avatar'
import { useUpdateAgent, useUpdateAgentAvatar } from '@renderer/hooks/use-agents'

import { AvatarView, orbRestingPhi, type AvatarMotionState } from './agent-avatar'
import { avatarSource } from './avatar-source'
import { OFFERED_ORBS } from '@shared/lib/types/agent-avatar-orbs'
import { ORB_SHAPES } from '@shared/lib/types/agent-avatar-shapes'

// Picker options, px across.
const OPTION_SIZE = 37
// The large preview under the name, px across.
const PREVIEW_SIZE = 76

interface AgentIdentityEditorProps {
  agent: Pick<ApiAgent, 'slug' | 'name' | 'avatar'>
  state?: AvatarMotionState
  /** The header avatar's diameter, px. */
  size?: number
  /** Classes for the name as the header shows it. */
  nameClassName?: string
  /** Optional secondary text below the name, within the same identity control. */
  subtitle?: ReactNode
}

/** Lets a parent (the agent menu's "Rename") open the editor. */
export interface AgentIdentityEditorHandle {
  open: () => void
}

/**
 * The agent's avatar and name as one button that opens one editor: a large
 * preview of the avatar with the name centred under it, then a shape row and the
 * colours, chosen independently — picking a shape keeps the colour and vice
 * versa. Every choice is a draft, shown in place on the header too, and is
 * kept when the editor closes, by clicking out, Escape, or Enter in the name.
 * While it's open every option follows the cursor; hovering one previews its
 * working motion.
 *
 * Avatar metadata also signals that the server supports avatar editing:
 * without it the editor offers the name alone.
 */
export const AgentIdentityEditor = forwardRef<AgentIdentityEditorHandle, AgentIdentityEditorProps>(function AgentIdentityEditor({
  agent,
  state,
  size,
  nameClassName,
  subtitle,
}, ref) {
  const updateName = useUpdateAgent()
  const updateAvatar = useUpdateAgentAvatar()
  const saved = agent.avatar ?? null
  const [open, setOpen] = useState(false)
  const [draftName, setDraftName] = useState(agent.name)
  const [avatarDraft, setDraftAvatar] = useState<AgentAvatar | null>(saved)
  // Metadata that disappears (a refetch from an older server) withdraws the avatar half.
  const draftAvatar = saved && avatarDraft
  // What the editor opened with: a remote update while open must not turn an
  // untouched draft into a save.
  const openedWith = useRef({ name: agent.name, avatar: saved })
  const [previewing, setPreviewing] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const openChange = (next: boolean) => {
    if (next) {
      // Start from the server's current choices.
      openedWith.current = { name: agent.name, avatar: saved }
      setDraftName(agent.name)
      setDraftAvatar(saved)
    } else if (open) {
      const name = draftName.trim()
      if (name && name !== openedWith.current.name) {
        updateName.mutate({ slug: agent.slug, name }, {
          onError: (error) => {
            console.error('Failed to rename agent:', error)
            toast.error('Failed to rename agent', {
              description: error instanceof Error ? error.message : 'Please try again.',
            })
          },
        })
      }
      const was = openedWith.current.avatar
      if (draftAvatar && was && (draftAvatar.color !== was.color || draftAvatar.shape !== was.shape)) {
        // Save the pair atomically.
        updateAvatar.mutate({ slug: agent.slug, avatar: draftAvatar })
      }
    }
    setPreviewing(null)
    setOpen(next)
  }

  useImperativeHandle(ref, () => ({ open: () => openChange(true) }))

  // While editing (and saving), the header shows the draft.
  const shownName = open || updateName.isPending ? (draftName.trim() || agent.name) : agent.name
  const shownAvatar = (open || updateAvatar.isPending) && draftAvatar ? draftAvatar : saved

  const option = (avatar: AgentAvatar, label: string, pressed: boolean) => {
    const id = `${avatar.color}:${avatar.shape}`
    return (
      <button
        key={id}
        type="button"
        aria-pressed={pressed}
        aria-label={label}
        title={label}
        onClick={() => setDraftAvatar(avatar)}
        onMouseEnter={() => setPreviewing(id)}
        onFocus={() => setPreviewing(id)}
        className={cn(
          'flex items-center justify-center rounded-item p-2 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
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
          aria-label={`Edit ${agent.name}'s name and avatar`}
          title="Edit name and avatar"
          data-testid="agent-identity-trigger"
          disabled={updateName.isPending || updateAvatar.isPending}
          className="group flex min-w-0 max-w-full items-center gap-2 rounded-item text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {shownAvatar && (
            <span className="shrink-0 transition-transform group-hover:scale-105">
              <AvatarView source={avatarSource(shownAvatar)} restingPhi={orbRestingPhi(agent.slug)} size={size} state={state} />
            </span>
          )}
          <span className="min-w-0">
            <span className={cn('block truncate transition-opacity group-hover:opacity-80', nameClassName)} data-testid="agent-name">
              {shownName}
            </span>
            {subtitle && <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        // Shapes plus every colour outgrow short windows: scroll within the room Radix measures.
        className="max-h-[var(--radix-popover-content-available-height)] w-auto overflow-y-auto p-2"
        onOpenAutoFocus={(event) => {
          // Land in the name with the caret after it.
          event.preventDefault()
          const input = nameInputRef.current
          input?.focus()
          input?.setSelectionRange(input.value.length, input.value.length)
        }}
        onMouseLeave={() => setPreviewing(null)}
        data-testid="agent-identity-editor"
      >
        {draftAvatar && (
          <div className="flex justify-center pb-2 pt-3" data-testid="agent-identity-preview">
            <AvatarView
              source={avatarSource(draftAvatar)}
              restingPhi={orbRestingPhi(agent.slug)}
              size={PREVIEW_SIZE}
              state={state}
              followPointer
            />
          </div>
        )}
        <input
          ref={nameInputRef}
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              openChange(false)
            }
          }}
          aria-label="Agent name"
          placeholder={agent.name}
          spellCheck={false}
          data-testid="agent-name-input"
          className={cn(
            'block h-9 min-w-0 rounded-control bg-transparent px-2 text-center text-base font-medium outline-none transition-colors',
            'placeholder:text-muted-foreground hover:bg-accent focus-visible:bg-accent',
            draftAvatar ? 'w-full' : 'w-56',
          )}
        />
        {draftAvatar && (
          <>
            <div className="px-2 pb-1 pt-3 text-xs text-muted-foreground">Shape</div>
            <div className="grid grid-cols-4 gap-1">
              {ORB_SHAPES.map(shape => option({ ...draftAvatar, shape: shape.name }, shape.label, draftAvatar.shape === shape.name))}
            </div>
            <div className="px-2 pb-1 pt-2 text-xs text-muted-foreground">Color</div>
            <div className="grid grid-cols-4 gap-1">
              {OFFERED_ORBS.map(orb => option({ ...draftAvatar, color: orb.name }, orb.label, draftAvatar.color === orb.name))}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
})
