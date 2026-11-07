import { useEffect, useId, useState, type ReactNode } from 'react'
import { Brain, Lightbulb, Mail, NotebookPen, TrendingUp } from 'lucide-react'
import { Switch } from '@renderer/components/ui/switch'
import { ServiceIcon } from '@renderer/components/ui/service-icon'

/**
 * What the create screen's last step collects. PROTOTYPE: nothing applies
 * these yet — the step is here to feel out the flow. Wiring each one up is
 * its own piece of work (self-improvement and proactivity don't exist yet,
 * and memory is always on today; Team Brain, inbox and Slack each have a
 * set-up path that needs the agent).
 */
export interface AgentAddons {
  /** Self-improvement (the "dream" skill): reviews its work and gets better at the job. */
  selfImprovement: boolean
  /** Proactivity: suggests new ideas and checks in unprompted. */
  proactivity: boolean
  /** Memories: keeps what it learns about you and your work. */
  memories: boolean
  /** Read and write access to the workspace's Team Brain. */
  teamBrain: boolean
  /** An email inbox of its own (the platform-email integration). */
  inbox: boolean
  /** A Slack connection, set up by the agent in its first session. */
  slack: boolean
}

/** Soft top and bottom edges on the step's scroll viewport, as the template roster has. */
const SCROLL_FADE_MASK =
  'linear-gradient(to bottom, transparent 0, black 32px, black calc(100% - 32px), transparent 100%)'

/**
 * The likely yeses start on: self-improvement and memories are what nearly
 * everyone wants. The rest are a choice.
 */
export const DEFAULT_AGENT_ADDONS: AgentAddons = {
  selfImprovement: true,
  proactivity: false,
  memories: true,
  teamBrain: false,
  inbox: false,
  slack: false,
}

interface AgentAddonsStepProps {
  /** The identity header the describe step shows, with this step's question. */
  header: ReactNode
  value: AgentAddons
  onChange: (value: AgentAddons) => void
}

/**
 * The create screen's last step: the extras a new teammate can start with,
 * grouped the way Agent Home groups them. Create Agent sits in the bottom row.
 */
export function AgentAddonsStep({ header, value, onChange }: AgentAddonsStepProps) {
  // Same staggered reveal as the other steps (.create-agent-item).
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

  return (
    // The step scrolls in its own viewport (edges fading like the template
    // roster's). The title row starts at a fixed point near the middle of the
    // window rather than the block being centred, so the question is where
    // the eye lands and the list runs down from it, scrolling when it is long.
    <div className="relative h-full min-h-0" data-testid="agent-addons-step">
      <div
        className="absolute inset-0 -mx-2 overflow-y-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ maskImage: SCROLL_FADE_MASK, WebkitMaskImage: SCROLL_FADE_MASK }}
        data-testid="agent-addons-scroll"
      >
        <div className="flex min-h-full flex-col">
          <div className="h-[30vh] shrink-0" aria-hidden />
          <div className="shrink-0">
            <div {...item(0)}>{header}</div>
            <div className="space-y-6">
              <AddonSection title="Skills" {...item(60)}>
                <AddonRow
                  icon={<TrendingUp className="h-4 w-4" />}
                  title="Self-Improvement"
                  description="Reviews its past work between sessions and gets better at the job."
                  checked={value.selfImprovement}
                  onCheckedChange={(selfImprovement) => onChange({ ...value, selfImprovement })}
                  testId="addon-self-improvement"
                />
                <AddonRow
                  icon={<Lightbulb className="h-4 w-4" />}
                  title="Proactivity"
                  description="Comes to you with new ideas and checks in without being asked."
                  checked={value.proactivity}
                  onCheckedChange={(proactivity) => onChange({ ...value, proactivity })}
                  testId="addon-proactivity"
                />
              </AddonSection>

              <AddonSection title="Knowledge & Context" {...item(100)}>
                <AddonRow
                  icon={<NotebookPen className="h-4 w-4" />}
                  title="Memories"
                  description="Remembers what it learns about you and your work."
                  checked={value.memories}
                  onCheckedChange={(memories) => onChange({ ...value, memories })}
                  testId="addon-memories"
                />
                <AddonRow
                  icon={<Brain className="h-4 w-4" />}
                  title="Team Brain"
                  description="Reads and adds to your team's shared knowledge."
                  checked={value.teamBrain}
                  onCheckedChange={(teamBrain) => onChange({ ...value, teamBrain })}
                  testId="addon-team-brain"
                />
              </AddonSection>

              <AddonSection title="Channels" {...item(140)}>
                <AddonRow
                  icon={<Mail className="h-4 w-4" />}
                  title="Inbox"
                  description="An email address of its own, so you can forward it mail."
                  checked={value.inbox}
                  onCheckedChange={(inbox) => onChange({ ...value, inbox })}
                  testId="addon-inbox"
                />
                <AddonRow
                  icon={<ServiceIcon slug="slack" fallback="mcp" className="h-4 w-4" />}
                  title="Slack"
                  description="Talk to it in Slack. It walks you through connecting in its first chat."
                  checked={value.slack}
                  onCheckedChange={(slack) => onChange({ ...value, slack })}
                  testId="addon-slack"
                />
              </AddonSection>
            </div>
          </div>
          <div className="h-12 shrink-0" aria-hidden />
        </div>
      </div>
    </div>
  )
}

function AddonSection({ title, children, ...reveal }: { title: string; children: ReactNode; className: string; style: React.CSSProperties; 'data-hidden': string }) {
  return (
    <section {...reveal}>
      <h3 className="mb-2 text-[13px] font-medium text-muted-foreground">{title}</h3>
      <div className="divide-y rounded-card border bg-card/50">{children}</div>
    </section>
  )
}

function AddonIcon({ children }: { children: ReactNode }) {
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-control bg-muted text-muted-foreground" aria-hidden>
      {children}
    </span>
  )
}

function AddonRow({
  icon,
  title,
  description,
  checked,
  onCheckedChange,
  testId,
}: {
  icon: ReactNode
  title: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  testId: string
}) {
  const id = useId()
  return (
    // The whole row toggles: the label points at the switch.
    <label htmlFor={id} className="flex cursor-pointer items-center gap-3 px-4 py-3" data-testid={testId}>
      <AddonIcon>{icon}</AddonIcon>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  )
}
