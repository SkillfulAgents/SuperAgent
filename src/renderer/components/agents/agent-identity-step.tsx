import { ArrowDownToLine, Shapes } from 'lucide-react'
import { OptionCard } from '@renderer/components/ui/option-card'
import { useEffect, useRef, useState } from 'react'
import { Input } from '@renderer/components/ui/input'
import { AvatarView, orbRestingPhi } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { AvatarChoices } from '@renderer/components/agents/agent-avatar/avatar-choices'
import { avatarSource } from '@renderer/components/agents/agent-avatar/avatar-source'
import { AGENT_NAME_MAX_LENGTH } from '@shared/lib/services/agent-identity-schema'
import type { ChosenAgentIdentity } from '@renderer/components/agents/creation-draft'
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

interface AgentIdentityStepProps {
  title: string
  value: ChosenAgentIdentity
  onChange: (value: ChosenAgentIdentity) => void
  /** Continue (or Enter): only acted on once the name has something in it. */
  onChooseSource?: (importing: boolean) => void
  onContinue: () => void
}

/**
 * The create screen's first step: the new teammate's name and orb. The name
 * is required; the orb starts as a random pick. Confirming the identity creates the agent.
 */
export function AgentIdentityStep({ title, value, onChange, onContinue, onChooseSource }: AgentIdentityStepProps) {
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

        {onChooseSource && (
          <div className="grid gap-3 max-sm:[&>button]:min-h-11 sm:flex sm:flex-wrap">
            <OptionCard title="Browse Templates" icon={<Shapes className="h-4 w-4" />} onClick={() => onChooseSource(false)} />
            <OptionCard title="Import an Agent" icon={<ArrowDownToLine className="h-4 w-4" />} onClick={() => onChooseSource(true)} />
          </div>
        )}
      </form>
      <div className="min-h-0 shrink" style={CREATE_STEP_BOTTOM_SPACER} aria-hidden />
    </div>
  )
}
