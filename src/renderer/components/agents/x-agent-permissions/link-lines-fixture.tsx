import { useState } from 'react'
import { flushSync } from 'react-dom'
import { Eye } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils/cn'
import { IntegrationList } from '@renderer/components/connections/integration-row'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { OFFERED_ORBS } from '@renderer/components/agents/agent-avatar/avatar-orbs'
import { ORB_SHAPES } from '@renderer/components/agents/agent-avatar/orb-shapes'
import { AGENT_AVATAR_SIZE } from '@renderer/components/layout/sidebar-avatar'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import { startViewTransition } from '@renderer/lib/view-transition'
import { isOn, lineWords, type LinkAction, type LinkChange, type LinkDirection, type LinkEnd, type LinkLine, type LinkWrite } from './link-ends'
import { LinkLines } from './link-lines'
import { AgentOrbit } from './agent-orbit'

// EXPERIMENT: every link state on fake agents, for styling and checking the row. Turn on with ?link-fixture in
// the URL, or localStorage.setItem('link-lines-fixture', '1'). Nothing is saved. Not for merge.
export const LINK_FIXTURE_KEY = 'link-lines-fixture'
export const linkFixtureOn = () => new URLSearchParams(window.location.search).has('link-fixture') || localStorage.getItem(LINK_FIXTURE_KEY) === '1'

interface FixtureAgent {
  slug: string
  name: string
  read: LinkLine
  message: LinkLine
  /** You can see this agent but not change its links. */
  viewOnlyOwner?: string
  /** Test-grid rows: the case, shown where a real agent shows its slug. */
  caseLabel?: string
  coverage?: boolean
  /** Test-grid rows: which look group the case belongs to. */
  group?: string
  /**
   * Ends "every agent" changed, with what each was before. Turning "every agent" off restores exactly these, so a link
   * set by hand is never undone. Changing an end by hand drops its entry: from then on it is yours.
   */
  setByEveryAgent?: Partial<Record<EndKey, LinkEnd>>
}

type EndKey = `${LinkAction}-${LinkDirection}`

type Links = Record<LinkAction, LinkLine>

const ASK: LinkLine = { out: 'ask', in: 'ask' }
const line = (out: LinkEnd, inn: LinkEnd): LinkLine => ({ out, in: inn })

const SCENARIOS: FixtureAgent[] = [
  { slug: 'analytics-tzar-a7h6b1h2re', name: 'Analytics Tzar', read: line('allowed', 'ask'), message: line('allowed', 'ask') },
  { slug: 'apartment-manager-2pmqfcdcza', name: 'Apartment Manager', read: ASK, message: line('allowed', 'allowed') },
  { slug: 'benchmarks-en8byf3dp5', name: 'Benchmarks', read: line('allowed', 'ask'), message: line('blocked', 'ask') },
  { slug: 'billing-operations-agent-dg785iupmf', name: 'Billing Operations Agent', read: ASK, message: line('ask', 'allowed'), viewOnlyOwner: 'Iddo Gino' },
  { slug: 'research-desk-4kd81mz0qa', name: 'Research Desk', read: ASK, message: ASK },
  // View only and no link: never listed.
  { slug: 'payroll-agent-7hq2m4x9vz', name: 'Payroll Agent', read: ASK, message: ASK, viewOnlyOwner: 'Iddo Gino' },
  { slug: 'quarterly-board-deck-and-investor-update-drafter-x9', name: 'Quarterly Board Deck and Investor Update Drafter', read: line('ask', 'blocked'), message: ASK },
]

// Every saved state of "Work does it" against every saved state of "it does it to Work" (both lines set the same),
// grouped by how the row should look, so each group can be checked against its one-line description.
const LABEL: Record<LinkEnd, string> = { ask: 'unset', allowed: 'allow', blocked: 'block' }
interface CaseGroup { id: string; title: string; looks: string; cases: [LinkEnd, LinkEnd][]; viewOnly?: boolean }
const GROUPS: CaseGroup[] = [
  { id: 'none', title: 'Not linked · nothing saved', looks: 'Dashed lines, one faint arrowhead pointing at the agent. A middle click allows Work’s direction.', cases: [['ask', 'ask']] },
  { id: 'blocked', title: 'Not linked · blocked', looks: '✕ on each blocked side. Clicking the line never lifts a block. To change a block, click the ✕ or right-click the line.', cases: [['blocked', 'ask'], ['ask', 'blocked'], ['blocked', 'blocked']] },
  { id: 'out', title: 'One way · Work reaches the agent', looks: 'Solid lines, solid arrowhead at the agent. The reverse arrowhead stays faint or shows ✕.', cases: [['allowed', 'ask'], ['allowed', 'blocked']] },
  { id: 'in', title: 'One way · the agent reaches Work', looks: 'Solid lines, solid arrowhead at Work’s trunk. The reverse arrowhead stays faint or shows ✕.', cases: [['ask', 'allowed'], ['blocked', 'allowed']] },
  { id: 'both', title: 'Both ways', looks: 'Solid lines, both arrowheads solid, “can read each other’s chats” / “can message each other”.', cases: [['allowed', 'allowed']] },
  { id: 'view', title: 'View only', looks: 'Own list, no lines. Listed only while a link exists: what the links are, the “View only” mark, and who to ask.', cases: [['allowed', 'ask'], ['ask', 'allowed'], ['allowed', 'allowed'], ['allowed', 'blocked'], ['ask', 'ask'], ['blocked', 'ask']], viewOnly: true },
]
let caseNumber = 0
const COVERAGE: FixtureAgent[] = GROUPS.flatMap((g) => g.cases.map(([o, i]) => {
  caseNumber += 1
  return {
    slug: `case-${g.id}-${o}-${i}`,
    name: `Test agent ${caseNumber}`,
    caseLabel: `Work → agent: ${LABEL[o]} · agent → Work: ${LABEL[i]}`,
    read: line(o, i),
    message: line(o, i),
    viewOnlyOwner: g.viewOnly ? 'Iddo Gino' : undefined,
    coverage: true,
    group: g.id,
  }
}))

const ALL = [...SCENARIOS, ...COVERAGE]

// A different orb and shape per fixture agent, so the avatars read as different agents.
const avatarOf = (agent: FixtureAgent): Pick<ApiAgent, 'slug' | 'avatar'> => {
  const found = ALL.findIndex((a) => a.slug === agent.slug)
  const i = found >= 0 ? found : ALL.length + Number(agent.slug.replace(/\D/g, ''))
  return { slug: agent.slug, avatar: { color: OFFERED_ORBS[(i * 3) % OFFERED_ORBS.length].name, shape: ORB_SHAPES[i % ORB_SHAPES.length].name } } as Pick<ApiAgent, 'slug' | 'avatar'>
}

const SAVED: Record<LinkWrite, LinkEnd> = { allow: 'allowed', block: 'blocked', clear: 'ask' }
const linked = (agent: FixtureAgent) => [agent.read, agent.message].some((l) => isOn(l.out) || isOn(l.in))
/** An agent you only view is listed only while it has a link with this agent, so its reach is never hidden. */
const listed = (agent: FixtureAgent) => !agent.viewOnlyOwner || linked(agent)
const NONE: Links = { read: ASK, message: ASK }

/** The Connect screen as a tree from this agent, drawn from the fixture, with clicks changing it in memory. */
export function LinkLinesFixture({ self }: { self: Pick<ApiAgent, 'slug' | 'avatar' | 'name'> }) {
  const [agents, setAgents] = useState(ALL)
  // Your "every agent I'm a member of" setting, which also applies to agents you make later.
  const [everyAgent, setEveryAgentLinks] = useState<Links>(NONE)

  // Same move-between-sections animation as the live screen's switch.
  const animate = (update: () => void) => startViewTransition(() => flushSync(update))

  const toggle = (slug: string, action: LinkAction, changes: LinkChange[]) => animate(() => setAgents((all) => all.map((agent) => {
    if (agent.slug !== slug) return agent
    const setByEveryAgent = { ...agent.setByEveryAgent }
    for (const c of changes) delete setByEveryAgent[`${action}-${c.direction}`]
    return { ...agent, setByEveryAgent, [action]: { ...agent[action], ...Object.fromEntries(changes.map((c) => [c.direction, SAVED[c.write]])) } }
  })))

  // The "every agent" row is an ordinary link row whose other side is every agent you are in, and agents you create
  // later. Each change is written as a link on each of those agents, skipping ones you only view, and remembered with
  // what it replaced. Allow never lifts a Block. Turning a direction off restores only what it changed.
  const applyEveryAgent = (agent: FixtureAgent, action: LinkAction, direction: LinkDirection, write: LinkWrite): FixtureAgent => {
    const key: EndKey = `${action}-${direction}`
    const setByEveryAgent = { ...agent.setByEveryAgent }
    const before = setByEveryAgent[key] ?? agent[action][direction]
    delete setByEveryAgent[key]
    let next = before
    if (write === 'allow' && before === 'ask') next = 'allowed'
    if (write === 'block' && before !== 'blocked') next = 'blocked'
    if (next !== before) setByEveryAgent[key] = before
    return { ...agent, setByEveryAgent, [action]: { ...agent[action], [direction]: next } }
  }

  const setEveryAgent = (action: LinkAction, changes: LinkChange[]) => animate(() => {
    for (const { direction, write } of changes) {
      setEveryAgentLinks((links) => ({ ...links, [action]: { ...links[action], [direction]: SAVED[write] } }))
      setAgents((all) => all.map((agent) => agent.coverage || agent.viewOnlyOwner ? agent : applyEveryAgent(agent, action, direction, write)))
    }
  })

  // An agent you create picks up your "every agent" setting the moment it exists (precedent: Team Brain's
  // applyTeamBrainEveryAgent at creation).
  const [created, setCreated] = useState(0)
  const createAgent = () => animate(() => {
    const n = created + 1
    setCreated(n)
    let agent: FixtureAgent = { slug: `new-agent-${n}`, name: `New agent ${n}`, read: ASK, message: ASK }
    for (const action of ['read', 'message'] as const) {
      for (const direction of ['out', 'in'] as const) {
        const setting = everyAgent[action][direction]
        if (setting !== 'ask') agent = applyEveryAgent(agent, action, direction, setting === 'allowed' ? 'allow' : 'block')
      }
    }
    setAgents((all) => [...all.filter((a) => !a.coverage), agent, ...all.filter((a) => a.coverage)])
  })

  const reset = () => animate(() => { setAgents(ALL); setEveryAgentLinks(NONE); setCreated(0) })

  const row = (agent: FixtureAgent) => (
    <div key={agent.slug} className="relative flex items-center gap-3 px-4 py-3" style={{ viewTransitionName: `xagent-fixture-${agent.slug}` }} data-testid={`link-fixture-row-${agent.slug}`}>
      <span className="pointer-events-none absolute -left-5 top-1/2 w-5 border-t-2 border-border" aria-hidden="true" />
      <LinkLines
        self={self.name}
        other={agent.name}
        selfSide="left"
        className="shrink-0"
        read={agent.read}
        message={agent.message}
        disabled={!!agent.viewOnlyOwner}
        fromEveryAgent={Object.keys(agent.setByEveryAgent ?? {})}
        onToggle={(action, changes) => toggle(agent.slug, action, changes)}
      />
      <AgentAvatar agent={avatarOf(agent)} size={AGENT_AVATAR_SIZE} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs font-medium">{agent.name}</span>
          {agent.viewOnlyOwner && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-control border px-1 py-px text-[10px] text-muted-foreground" data-testid="link-view-only">
              <Eye className="h-3 w-3" aria-hidden="true" />View only
            </span>
          )}
        </div>
        <div className={cn('text-[11px] text-muted-foreground', !agent.viewOnlyOwner && 'truncate')}>
          {agent.viewOnlyOwner ? `${agent.caseLabel ? `${agent.caseLabel}. ` : ''}Only someone who uses both agents can change this. Ask ${agent.viewOnlyOwner} (Owner).` : agent.caseLabel ?? <span className="font-mono">{agent.slug}</span>}
        </div>
      </div>
    </div>
  )

  // An agent you only view: nothing on its row is yours to change, so no lines. It says what links exist and who
  // can change them.
  const viewRow = (agent: FixtureAgent) => {
    const links = (['read', 'message'] as const).filter((a) => isOn(agent[a].out) || isOn(agent[a].in)).map((a) => lineWords(a, agent[a], self.name, agent.name))
    return (
      <div key={agent.slug} className="relative flex items-center gap-3 px-4 py-3" data-testid={`link-fixture-row-${agent.slug}`}>
        <span className="pointer-events-none absolute -left-5 top-1/2 w-5 border-t-2 border-border" aria-hidden="true" />
        <AgentAvatar agent={avatarOf(agent)} size={AGENT_AVATAR_SIZE} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-xs font-medium">{agent.name}</span>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-control border px-1 py-px text-[10px] text-muted-foreground" data-testid="link-view-only">
              <Eye className="h-3 w-3" aria-hidden="true" />View only
            </span>
          </div>
          <div className="text-[11px]" data-testid="link-view-only-links">{links.join(' · ')}</div>
          <div className="text-[11px] text-muted-foreground">
            {agent.caseLabel ? `${agent.caseLabel}. ` : ''}Only someone who uses both agents can change this. Ask {agent.viewOnlyOwner} (Owner).
          </div>
        </div>
      </div>
    )
  }

  const section = (title: string, list: FixtureAgent[], note?: string, looks?: string) => list.length > 0 && (
    <div className="space-y-1.5">
      <p className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{title}{note && <span className="ml-2 normal-case tracking-normal">{note}</span>}</p>
      {looks && <p className="px-1 text-[11px] text-muted-foreground" data-testid="link-fixture-looks">{looks}</p>}
      {/* The tree's branches run from the trunk into each row, outside the list's box, so it must not clip them. */}
      <IntegrationList className="overflow-visible">{list.map((a) => a.viewOnlyOwner ? viewRow(a) : row(a))}</IntegrationList>
    </div>
  )

  const scenarios = agents.filter((a) => !a.coverage && listed(a))

  return (
    <TooltipProvider delayDuration={150}>
    <div className="space-y-6" data-testid="link-lines-fixture">
      <div className="flex flex-wrap items-center gap-2 rounded-item bg-muted px-2 py-1.5 text-xs text-muted-foreground">
        <span className="flex-1">Link row experiment: fixture data, nothing is saved. Right-click a line to block.</span>
        <button type="button" onClick={createAgent} className="rounded-control px-2 py-0.5 hover:text-foreground" data-testid="link-fixture-create">New agent (test)</button>
        <button type="button" onClick={reset} className="rounded-control px-2 py-0.5 hover:text-foreground" data-testid="link-fixture-reset">Reset</button>
      </div>

      <div>
        <div className="flex items-center gap-3 px-1">
          {self.avatar && <AgentAvatar agent={self} size={AGENT_AVATAR_SIZE} />}
          <div>
            <div className="text-xs font-medium">{self.name}</div>
            <div className="text-[11px] text-muted-foreground">this agent</div>
          </div>
        </div>
        {/* The trunk runs from this agent's avatar down past every row. */}
        <div className="relative ml-[15px] mt-1 space-y-6 border-l-2 border-border pb-1 pl-5 pt-4">
          <div className="space-y-1.5">
            <p className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Every agent</p>
            <IntegrationList className="overflow-visible">
              <div className="relative flex items-center gap-3 px-4 py-3" data-testid="link-fixture-every-agent">
                <span className="pointer-events-none absolute -left-5 top-1/2 w-5 border-t-2 border-border" aria-hidden="true" />
                <LinkLines
                  self={self.name}
                  other="every agent"
                  selfSide="left"
                  className="shrink-0"
                  read={everyAgent.read}
                  message={everyAgent.message}
                  onToggle={setEveryAgent}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span data-testid="link-every-agent-orbit"><AgentOrbit agents={SCENARIOS.map(avatarOf)} size={44} /></span>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs" data-testid="link-every-agent-orbit-tip">
                    Covers {agents.filter((a) => !a.coverage && !a.viewOnlyOwner).length} agents I’m a member of, and future agents I create
                  </TooltipContent>
                </Tooltip>
                <div className="min-w-0">
                  <div className="text-xs font-medium">Every agent I’m a member of and future agents I create</div>
                  <div className="text-[11px] text-muted-foreground">Blocked agents stay blocked. Turning this off undoes only what this row changed.</div>
                </div>
              </div>
            </IntegrationList>
          </div>
          {section('Linked', scenarios.filter((a) => !a.viewOnlyOwner && linked(a)))}
          {section('Not linked', scenarios.filter((a) => !a.viewOnlyOwner && !linked(a)))}
          {section('Agents you can only view', scenarios.filter((a) => a.viewOnlyOwner))}
          <div className="space-y-6 border-t border-dashed pt-6" data-testid="link-fixture-coverage">
            <p className="px-1 text-xs text-muted-foreground">
              All combinations: {COVERAGE.length} test rows in {GROUPS.length} groups. Both lines on a row are set the same. Under each group title is how that group’s rows should look.
            </p>
            {GROUPS.map((g) => (
              <div key={g.id} data-testid={`link-fixture-group-${g.id}`}>
                {section(g.title, agents.filter((a) => a.group === g.id && listed(a)), undefined, g.looks)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
    </TooltipProvider>
  )
}
