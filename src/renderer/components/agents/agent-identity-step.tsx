import { useEffect, useRef, useState } from 'react'
import { Input } from '@renderer/components/ui/input'
import { AvatarView, orbRestingPhi } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { AvatarChoices } from '@renderer/components/agents/agent-avatar/agent-avatar-picker'
import { avatarSource } from '@renderer/components/agents/agent-avatar/avatar-source'
import { AGENT_NAME_MAX_LENGTH } from '@shared/lib/services/agent-identity-schema'
import { AGENT_AVATAR_SHAPES, DEFAULT_AGENT_AVATAR_COLORS, type AgentAvatar } from '@shared/lib/types/agent-avatar'
import type { ChosenAgentIdentity } from '@renderer/hooks/use-create-agent-for-prompt'
import { CREATE_STEP_BOTTOM_SPACER } from '@renderer/components/agents/create-agent-layout'

/** The big orb above the name: the teammate being made, before it exists. */
const PREVIEW_SIZE = 72
/** Its gaze seed; there is no slug yet. */
const PREVIEW_SEED = 'new-agent'
/**
 * The step's form, by id: its Continue sits in the screen's bottom row,
 * opposite Back, and submits it from there (`<button form=…>`).
 */
export const AGENT_IDENTITY_FORM_ID = 'agent-identity-form'

/** A first orb to start from, drawn like the server draws one for an agent created without a pick. */
export function randomAgentAvatar(random: () => number = Math.random): AgentAvatar {
  const pick = <T,>(options: readonly T[]) => options[Math.floor(random() * options.length)]
  return { color: pick(DEFAULT_AGENT_AVATAR_COLORS), shape: pick(AGENT_AVATAR_SHAPES) }
}

interface AgentIdentityStepProps {
  title: string
  value: ChosenAgentIdentity
  onChange: (value: ChosenAgentIdentity) => void
  /** Continue (or Enter): only acted on once the name has something in it. */
  onContinue: () => void
}

/**
 * The create screen's first step: the new teammate's name and orb. The name
 * is required; the orb starts as a random pick. Both apply to an agent made
 * from a prompt on the next step — templates and imports bring their own.
 */
export function AgentIdentityStep({ title, value, onChange, onContinue }: AgentIdentityStepProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  // Same staggered reveal as the describe step's items (.create-agent-item).
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setRevealed(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  const item = (delayMs: number) => ({
    className: 'create-agent-item',
    'data-hidden': revealed ? 'false' : 'true',
    style: { transitionDelay: `${delayMs}ms` },
  })

  const canContinue = value.name.trim().length > 0

  return (
    // Same vertical rhythm as the job step without its roster: centred.
    <div className="flex h-full min-h-0 flex-col overflow-y-auto" data-testid="agent-identity-step">
      <div className="min-h-0 flex-1 shrink" aria-hidden />
      <form
        id={AGENT_IDENTITY_FORM_ID}
        className="mx-auto w-full max-w-xl shrink-0 space-y-8"
        onSubmit={(e) => {
          e.preventDefault()
          if (canContinue) onContinue()
          else inputRef.current?.focus()
        }}
      >
        <div {...item(0)}>
          <AvatarView
            source={avatarSource(value.avatar)}
            restingPhi={orbRestingPhi(PREVIEW_SEED)}
            size={PREVIEW_SIZE}
            state="idle"
            followPointer
          />
        </div>

        <div {...item(60)}>
          <div className="space-y-3">
            <h2 className="text-2xl font-normal" id="agent-identity-title">{title}</h2>
            <Input
              ref={inputRef}
              autoFocus
              value={value.name}
              onChange={(e) => onChange({ ...value, name: e.target.value })}
              maxLength={AGENT_NAME_MAX_LENGTH}
              placeholder="e.g. Research Assistant"
              aria-labelledby="agent-identity-title"
              data-testid="agent-identity-name"
              className="h-11 text-base md:text-base"
            />
          </div>
        </div>

        <div {...item(120)}>
          <AvatarChoices
            value={value.avatar}
            onChange={(avatar) => onChange({ ...value, avatar })}
            wide
          />
        </div>

      </form>
      <div className="min-h-0 shrink" style={CREATE_STEP_BOTTOM_SPACER} aria-hidden />
    </div>
  )
}
