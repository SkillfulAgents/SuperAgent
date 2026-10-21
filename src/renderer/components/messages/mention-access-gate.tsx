import { useState, type ReactNode } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { AgentRole } from '@shared/lib/types/agent'
import type { AgentMember } from '@shared/lib/agent-members-schema'
import { apiFetch } from '@renderer/lib/api'
import { loadAgentMembers } from '@renderer/lib/agent-members-loader'
import type { Chip } from '@renderer/lib/chip-marker'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Label } from '@renderer/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { RoleSelectItems } from '@renderer/components/agents/agent-share-popover'
import type { ChipContext, ChipSend } from './composer-chips'
import { agentForSlug, parseChatReferent } from './mention-chip'

type Decision = 'allow' | 'review' | 'block'
type Operation = 'read' | 'invoke'
interface Policy { operation: 'list' | Operation; targetAgentSlug: string | null; decision: Decision }

/** What the agent may do with the agent it was told about. */
type Reach = 'both' | 'invoke' | 'read' | 'ask'
const REACH_OPTIONS: { value: Reach; label: string }[] = [
  { value: 'both', label: 'Read its sessions and send it messages' },
  { value: 'invoke', label: 'Send it messages' },
  { value: 'read', label: 'Read its sessions' },
  { value: 'ask', label: 'Ask me each time' },
]
const REACH_OPERATIONS: Record<Exclude<Reach, 'ask'>, Operation[]> = {
  both: ['read', 'invoke'],
  invoke: ['invoke'],
  read: ['read'],
}

/** What a choice sets for one agent: allows what was picked, or makes a blocked operation ask. */
function reachPolicies(reach: Reach, blocked: Operation[]): Array<{ operation: Operation; decision: Decision }> {
  if (reach === 'ask') return blocked.map((operation) => ({ operation, decision: 'review' }))
  return REACH_OPERATIONS[reach].map((operation) => ({ operation, decision: 'allow' }))
}

/** A target-specific policy, else the caller's global one, else review (x-agent-policy-service evaluate()). */
function effective(policies: Policy[], operation: Operation, target: string): Decision {
  return policies.find((p) => p.operation === operation && p.targetAgentSlug === target)?.decision
    ?? policies.find((p) => p.operation === operation && p.targetAgentSlug === null)?.decision
    ?? 'review'
}

const names = (chips: Chip[]) => chips.map((chip) => chip.label).join(', ')

function fetchMembers(queryClient: QueryClient, agentSlug: string, staleTime: number): Promise<AgentMember[]> {
  return queryClient.fetchQuery({
    queryKey: ['agent-members', agentSlug],
    queryFn: ({ signal }) => loadAgentMembers(queryClient, agentSlug, signal),
    staleTime,
  })
}

async function fetchPolicies(queryClient: QueryClient, agentSlug: string): Promise<Policy[]> {
  const { policies } = await queryClient.fetchQuery<{ policies: Policy[] }>({
    queryKey: ['x-agent-policies', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/x-agent-policies`)
      if (!res.ok) throw new Error('Failed to fetch policies')
      return res.json()
    },
  })
  return policies
}

/**
 * The user chip's check before a send: a teammate who cannot open the agent is
 * offered a share, and the message goes with the fresh roster. Only someone who
 * manages the agent is asked; anyone else sends as is.
 */
export async function offerShare(people: Chip[], { agentSlug, context, isAuthMode, manages, queryClient, ask }: ChipSend): Promise<ChipContext | null> {
  if (!isAuthMode || !manages) return context
  const members = new Set((await fetchMembers(queryClient, agentSlug, 30_000)).map((member) => member.id))
  const outside = people.filter((chip) => !members.has(chip.referent))
  if (outside.length === 0) return context
  if (!(await ask((done) => <ShareDialog agentSlug={agentSlug} people={outside} onDone={done} />))) return null
  const fresh = await fetchMembers(queryClient, agentSlug, 0)
  return { ...context, members: new Map(fresh.map((member) => [member.id, member])) }
}

/**
 * The agent chip's check before a send: an agent this one cannot reach without
 * asking is offered access. Only someone who manages the agent is asked; anyone
 * else sends as is, and the agent asks at call time.
 */
export async function offerReach(tagged: Chip[], { agentSlug, context, silent, manages, queryClient, ask }: ChipSend): Promise<ChipContext | null> {
  // A silent message runs no turn, so there is nothing to reach yet.
  const agents = tagged.filter((chip) => agentForSlug(context.agents, chip.referent))
  if (silent || !manages || agents.length === 0) return context
  const policies = await fetchPolicies(queryClient, agentSlug)
  const unreachable = agents.filter((chip) =>
    effective(policies, 'read', chip.referent) !== 'allow' && effective(policies, 'invoke', chip.referent) !== 'allow')
  if (unreachable.length === 0) return context
  const blocked = new Map(unreachable.map((chip) => [chip.referent,
    (['read', 'invoke'] as const).filter((operation) => effective(policies, operation, chip.referent) === 'block')]))
  const agentName = agentForSlug(context.agents, agentSlug)?.name
  const allowed = await ask((done) => (
    <ReachDialog agentSlug={agentSlug} agentName={agentName} agents={unreachable} blocked={blocked} onDone={done} />
  ))
  return allowed ? context : null
}

/**
 * The chat chip's check before a send: another agent's chat that this one
 * cannot read without asking offers that access, as `offerReach` does. Only
 * someone who manages the agent is asked; anyone else sends as is.
 */
export async function offerChatRead(chats: Chip[], { agentSlug, context, silent, manages, queryClient, ask }: ChipSend): Promise<ChipContext | null> {
  const ownId = agentForSlug(context.agents, agentSlug)?.slug ?? agentSlug
  const owners = new Map<string, Chip>()
  for (const chip of chats) {
    const owner = agentForSlug(context.agents, parseChatReferent(chip.referent).agentId ?? '')
    if (owner && owner.slug !== ownId) owners.set(owner.slug, { kind: 'agent', referent: owner.slug, label: owner.name })
  }
  if (silent || !manages || owners.size === 0) return context
  const policies = await fetchPolicies(queryClient, agentSlug)
  const unreadable = [...owners.values()].filter((chip) => effective(policies, 'read', chip.referent) !== 'allow')
  if (unreadable.length === 0) return context
  const blocked = new Map(unreadable.map((chip) => [chip.referent,
    effective(policies, 'read', chip.referent) === 'block' ? ['read' as const] : []]))
  const agentName = agentForSlug(context.agents, agentSlug)?.name
  const allowed = await ask((done) => (
    <ReachDialog agentSlug={agentSlug} agentName={agentName} agents={unreadable} blocked={blocked} initialReach="read" onDone={done} />
  ))
  return allowed ? context : null
}

interface GateDialogProps {
  title: string
  description: string
  label: string
  control: ReactNode
  submitLabel: string
  /** Does what the dialog offers. A thrown error shows in the dialog. */
  onSubmit: () => Promise<void>
  onDone: (ok: boolean) => void
}

function GateDialog({ title, description, label, control, submitLabel, onSubmit, onDone }: GateDialogProps) {
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    setSaving(true)
    setError('')
    try {
      await onSubmit()
      onDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onDone(false) }}>
      <DialogContent className="sm:max-w-md" data-testid="mention-access-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label>{label}</Label>
          {control}
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onDone(false)}>Cancel</Button>
          <Button type="button" disabled={saving} onClick={() => void submit()}>{submitLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ShareDialog({ agentSlug, people, onDone }: { agentSlug: string; people: Chip[]; onDone: (ok: boolean) => void }) {
  const queryClient = useQueryClient()
  const [role, setRole] = useState<AgentRole>('user')
  const who = names(people)
  const share = async () => {
    try {
      for (const person of people) {
        const res = await apiFetch(`/api/agents/${agentSlug}/access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: person.referent, role }),
        })
        // 409: they were given access meanwhile.
        if (!res.ok && res.status !== 409) {
          const data = await res.json().catch(() => ({}))
          throw new Error(`${person.label}: ${data.error || 'Failed to share the agent'}`)
        }
      }
    } finally {
      // As the share popover does.
      void queryClient.invalidateQueries({ queryKey: ['agent-invite-candidates', agentSlug] })
      void queryClient.invalidateQueries({ queryKey: ['my-agent-roles'] })
    }
  }
  return (
    <GateDialog
      title={people.length === 1 ? `Share this agent with ${who}?` : 'Share this agent with them?'}
      description={`${who} ${people.length === 1 ? "doesn't" : "don't"} have access to this agent, so the mention would not reach them. Share it to send.`}
      label="Their access"
      control={(
        <Select value={role} onValueChange={(value) => setRole(value as AgentRole)}>
          <SelectTrigger data-testid="mention-share-role"><SelectValue /></SelectTrigger>
          <SelectContent className="w-64"><RoleSelectItems /></SelectContent>
        </Select>
      )}
      submitLabel="Share and send"
      onSubmit={share}
      onDone={onDone}
    />
  )
}

function ReachDialog({ agentSlug, agentName, agents, blocked, initialReach = 'both', onDone }: {
  agentSlug: string
  agentName: string | undefined
  agents: Chip[]
  /** The operations a policy blocks, per agent; the rest ask first. */
  blocked: Map<string, Operation[]>
  /** What the dialog offers first. */
  initialReach?: Reach
  onDone: (ok: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [reach, setReach] = useState<Reach>(initialReach)
  const caller = agentName ?? 'This agent'
  const targets = names(agents)
  const grant = async () => {
    try {
      for (const agent of agents) {
        const policies = reachPolicies(reach, blocked.get(agent.referent) ?? [])
        for (const { operation, decision } of policies) {
          const res = await apiFetch(`/api/agents/${agentSlug}/x-agent-policies`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ operation, targetSlug: agent.referent, decision }),
          })
          if (!res.ok) {
            const data = await res.json().catch(() => ({}))
            throw new Error(`${agent.label}: ${data.error || 'Failed to change its access'}`)
          }
        }
        if (policies.length > 0) void queryClient.invalidateQueries({ queryKey: ['inbound-x-agent', agent.referent] })
      }
    } finally {
      void queryClient.invalidateQueries({ queryKey: ['x-agent-policies', agentSlug] })
      void queryClient.invalidateQueries({ queryKey: ['home-graph'] })
    }
  }
  return (
    <GateDialog
      title={`Let ${caller} reach ${targets}?`}
      description={[...blocked.values()].some((operations) => operations.length > 0)
        ? `${caller} is blocked from reaching ${targets}.`
        : `${caller} has to ask you before it reads ${targets}'s sessions or sends ${agents.length === 1 ? 'it' : 'them'} a message.`}
      label="Allow it to"
      control={(
        <Select value={reach} onValueChange={(value) => setReach(value as Reach)}>
          <SelectTrigger data-testid="mention-reach-select"><SelectValue /></SelectTrigger>
          <SelectContent>
            {REACH_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      submitLabel={reach === 'ask' ? 'Send' : 'Allow and send'}
      onSubmit={grant}
      onDone={onDone}
    />
  )
}
