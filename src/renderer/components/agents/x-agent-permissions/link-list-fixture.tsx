import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { Ban, Check, ChevronRight, FlaskConical, Info, Plus, Unlink, X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Separator } from '@renderer/components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@renderer/components/ui/dialog'
import { HighlightMatch } from '@renderer/components/ui/highlight-match'
import { ResultRow, ResultSection, SEARCH_DIALOG_CONTENT_CLASS, SearchField } from '@renderer/components/search/search-dialog'
import { IntegrationList, IntegrationRow } from '@renderer/components/connections/integration-row'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { OFFERED_ORBS } from '@shared/lib/types/agent-avatar-orbs'
import { ORB_SHAPES } from '@shared/lib/types/agent-avatar-shapes'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import { startViewTransition } from '@renderer/lib/view-transition'
import { cn } from '@shared/lib/utils/cn'
import { AgentOrbit } from './agent-orbit'

// EXPERIMENT: the Connect screen as a list, on fake agents. Turn on with ?link-fixture in the URL, or
// localStorage.setItem('link-lines-fixture', '1'). Nothing is saved. Not for merge.
export const LINK_FIXTURE_KEY = 'link-lines-fixture'
// The desktop app routes by hash (`#/agents/…?link-fixture`), so there the query sits in the hash, not in `search`.
const hashQuery = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '')
export const linkFixtureOn = () => new URLSearchParams(window.location.search).has('link-fixture') || hashQuery().has('link-fixture') || localStorage.getItem(LINK_FIXTURE_KEY) === '1'

/** What this agent may do with another one without asking: nothing (it asks first), or one of the three connections. */
type Reach = 'ask' | 'read' | 'message' | 'both'
/** One state per agent. Blocked is all or nothing: this agent can neither read nor message it, and can't ask to. */
type AgentState = Reach | 'blocked'

const CONNECTIONS: { value: Exclude<Reach, 'ask'>; label: string }[] = [
  { value: 'read', label: 'Read only' },
  { value: 'message', label: 'Message only' },
  { value: 'both', label: 'Read & message' },
]
const LABEL: Record<AgentState, string> = { ask: 'Ask first', read: 'Read only', message: 'Message only', both: 'Read & message', blocked: 'Blocked' }

interface FixtureAgent {
  slug: string
  name: string
  /** This agent's own state for the other one; none follows "All other agents". */
  state?: AgentState
  /** You can see this agent but not change its connection. */
  viewOnlyOwner?: string
}

const AGENTS: FixtureAgent[] = [
  { slug: 'analytics-tzar-a7h6b1h2re', name: 'Analytics Tzar', state: 'both' },
  { slug: 'apartment-manager-2pmqfcdcza', name: 'Apartment Manager', state: 'message' },
  { slug: 'benchmarks-en8byf3dp5', name: 'Benchmarks', state: 'read' },
  { slug: 'billing-operations-agent-dg785iupmf', name: 'Billing Operations Agent', state: 'read', viewOnlyOwner: 'Iddo Gino' },
  { slug: 'research-desk-4kd81mz0qa', name: 'Research Desk' },
  { slug: 'payroll-agent-7hq2m4x9vz', name: 'Payroll Agent', viewOnlyOwner: 'Iddo Gino' },
  { slug: 'quarterly-board-deck-and-investor-update-drafter-x9', name: 'Quarterly Board Deck and Investor Update Drafter', state: 'blocked' },
  { slug: 'inbox-triage-3fz8wq1kpa', name: 'Inbox Triage' },
  { slug: 'travel-planner-9mh2xv4rte', name: 'Travel Planner' },
]

// A different orb and shape per fixture agent, so the avatars read as different agents.
const avatarOf = (agent: FixtureAgent): Pick<ApiAgent, 'slug' | 'avatar'> => {
  const found = AGENTS.findIndex((a) => a.slug === agent.slug)
  const i = found >= 0 ? found : AGENTS.length + Number(agent.slug.replace(/\D/g, ''))
  return { slug: agent.slug, avatar: { color: OFFERED_ORBS[(i * 3) % OFFERED_ORBS.length].name, shape: ORB_SHAPES[i % ORB_SHAPES.length].name } } as Pick<ApiAgent, 'slug' | 'avatar'>
}

// Sentence case, like the search palette's section labels: quieter than the small-caps headings.
/** An info mark beside a label, whose text shows on hover or focus, so the page stays quiet. Opens to the right. */
function InfoTip({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="inline-flex shrink-0 rounded-full text-muted-foreground/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" aria-label={label} data-testid={testId}>
            <Info className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-64 text-xs font-normal" data-testid={`${testId}-tip`}>{children}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

const SECTION_LABEL = 'px-1 text-xs text-muted-foreground'
const VALUE = '-mr-1 h-8 gap-1 px-1 text-[12px]/5 font-normal text-muted-foreground/70 hover:bg-transparent hover:text-muted-foreground data-[state=open]:text-muted-foreground data-[state=open]:ring-0'
const MENU_ITEM = 'flex items-center justify-between gap-2 rounded-item px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground'
const MENU_ACTION = 'flex min-w-0 items-center gap-1.5 rounded-item px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground'

/**
 * One state per agent, in three places. "All other agents" is the default: what this agent may do with any agent that
 * has no state of its own, agents created later included. Under it, the agents this agent can reach, each Read only,
 * Message only or Read & message. Blocked agents sit in their own section, since a blocked agent is not connected.
 * An agent this agent has to ask about is in neither: it waits in "Connect an agent". Changes live in memory only.
 */
export function LinkListFixture({ selfName, titleActions }: {
  selfName: string
  /** The page title's actions slot, where "Connect an agent" sits, like the Connections page's "New connection". */
  titleActions: HTMLElement | null
}) {
  const [agents, setAgents] = useState(AGENTS)
  const [allOthers, setAllOthers] = useState<Reach>('ask')
  // Which picker is open: connecting an agent, or blocking one. Both are the same search-style modal.
  const [picker, setPicker] = useState<'connect' | 'block' | null>(null)
  // The open menu, by key. Choosing closes it.
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [controlsHidden, setControlsHidden] = useState(false)

  // Same move animation as the live screen's switch.
  const animate = (update: () => void) => startViewTransition(() => flushSync(update))

  const stateOf = (agent: FixtureAgent): AgentState => agent.state ?? allOthers
  const connected = agents.filter((a) => stateOf(a) !== 'ask' && stateOf(a) !== 'blocked')
  const blocked = agents.filter((a) => stateOf(a) === 'blocked')
  // An agent you only view can't be connected from here, so it is never offered.
  const connectable = agents.filter((a) => stateOf(a) === 'ask' && !a.viewOnlyOwner)
  // Any agent not already blocked can be blocked straight away, connected or not, and one you only view too: blocking
  // only limits this agent, so it needs no access to the other one.
  const blockable = agents.filter((a) => stateOf(a) !== 'blocked')

  const setState = (slug: string, state: AgentState | undefined) => animate(() => {
    setOpenMenu(null)
    setAgents((all) => all.map((a) => (a.slug === slug ? { ...a, state } : a)))
  })
  // Disconnect and Unblock both end at "ask first", whatever the default is: with a default that allows something, the
  // agent is pinned to Ask first, so neither one ever leaves it reachable.
  const askFirst = (slug: string) => setState(slug, allOthers === 'ask' ? undefined : 'ask')

  // An agent you create has no state of its own, so it follows "All other agents" from the start.
  const createAgent = () => animate(() => setAgents((all) => {
    const n = all.filter((a) => a.slug.startsWith('new-agent-')).length + 1
    return [...all, { slug: `new-agent-${n}`, name: `New agent ${n}` }]
  }))
  const reset = () => animate(() => { setAgents(AGENTS); setAllOthers('ask') })

  // The agent settings panel's row control: the value in muted text with a soft chevron, opening a short list with a ✓
  // on the choice, and the row's other actions under a rule.
  // `readOnly`: you can look but not change it. The value reads like any other; its menu shows the choices locked and why.
  const menu = (key: string, label: string, value: string, body: ReactNode, { readOnly = false, wide = false } = {}) => (
    <Popover open={openMenu === key} onOpenChange={(open) => setOpenMenu(open ? key : null)}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={VALUE}
          aria-label={readOnly ? `${label}: ${value}. You can't change this.` : `${label}: ${value}. Click to change.`}
          data-testid={`link-list-${key}-trigger`}
        >
          <span className="truncate">{value}</span>
          <ChevronRight className="h-4 w-4 text-muted-foreground/50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className={cn('flex flex-col px-1 py-2', wide ? 'w-64' : 'w-56')} align="end" collisionPadding={8} onOpenAutoFocus={(e) => e.preventDefault()} data-testid={`link-list-${key}-menu`}>
        {body}
      </PopoverContent>
    </Popover>
  )
  const choices = <T extends string>(key: string, label: string, options: { value: T; label: string }[], current: T | null, onPick: (value: T) => void, disabled = false) => (
    <div className="flex flex-col" role="listbox" aria-label={label}>
      {options.map((option) => {
        const selected = current === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={selected}
            disabled={disabled}
            onClick={() => onPick(option.value)}
            data-testid={`link-list-${key}-option-${option.value}`}
            className={cn(
              MENU_ITEM,
              selected ? 'text-foreground' : 'text-muted-foreground',
              // Locked: the current choice keeps its normal look, the others grey out, and none respond to hover.
              disabled && (selected
                ? 'cursor-default hover:bg-transparent hover:text-foreground'
                : 'cursor-default text-muted-foreground/50 hover:bg-transparent hover:text-muted-foreground/50'),
            )}
          >
            <span>{option.label}</span>
            {selected && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
          </button>
        )
      })}
    </div>
  )

  // Taking access away only limits this agent, so it needs no access to the other one: these two are open even on an
  // agent you only view.
  const removeActions = (agent: FixtureAgent) => (
    <>
      <button type="button" onClick={() => askFirst(agent.slug)} className={MENU_ACTION} data-testid={`link-list-${agent.slug}-disconnect`}>
        <Unlink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">Disconnect</span>
      </button>
      <button type="button" onClick={() => setState(agent.slug, 'blocked')} className={MENU_ACTION} data-testid={`link-list-${agent.slug}-block`}>
        <Ban className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {/* Blocking a connected agent also ends the connection, so the action says both. */}
        <span className="truncate">Disconnect &amp; block</span>
      </button>
    </>
  )
  const connectedMenu = (agent: FixtureAgent) => {
    const state = stateOf(agent)
    return menu(agent.slug, agent.name, LABEL[state], (
      <>
        {choices(agent.slug, agent.name, CONNECTIONS, state === 'ask' || state === 'blocked' ? null : state, (value) => setState(agent.slug, value))}
        <Separator className="my-2 bg-border/50" />
        {removeActions(agent)}
      </>
    ))
  }
  // A blocked row reads "Blocked" until you point at it (or tab to it): then the value becomes the one thing you can do
  // there, a "Remove block" button. Removing the block goes back to Ask first.
  const removeBlock = (agent: FixtureAgent) => (
    <button
      type="button"
      onClick={() => askFirst(agent.slug)}
      aria-label={`Remove block on ${agent.name}`}
      data-testid={`link-list-${agent.slug}-unblock`}
      className="group/unblock flex h-7 items-center gap-1 rounded-control border border-transparent px-2 text-[12px]/5 text-muted-foreground/70 transition-colors group-hover:border-input group-hover:bg-background group-hover:text-foreground group-hover:shadow-sm hover:bg-muted focus-visible:border-input focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="group-hover:hidden group-focus-visible/unblock:hidden">Blocked</span>
      <span className="hidden items-center gap-1 group-hover:inline-flex group-focus-visible/unblock:inline-flex">
        <X className="h-3.5 w-3.5" aria-hidden="true" />Remove block
      </span>
    </button>
  )

  // An agent you can see but don't own: its connection is shown, greyed, and its menu says who can change it, with the
  // choices listed but not clickable.
  const viewOnlyMenu = (agent: FixtureAgent) => {
    const state = stateOf(agent)
    return menu(agent.slug, agent.name, LABEL[state], (
      <>
        {choices(agent.slug, agent.name, CONNECTIONS, state === 'ask' || state === 'blocked' ? null : state, () => {}, true)}
        <Separator className="my-2 bg-border/50" />
        {removeActions(agent)}
        {/* Last, under its own rule: why the choices above can't be changed. */}
        <Separator className="my-2 bg-border/50" />
        <p className="px-2 pb-0.5 text-[11px] leading-snug text-muted-foreground" data-testid={`link-list-${agent.slug}-not-owner`}>
          You have view-only access to this agent. Request owner access to edit permissions.
        </p>
      </>
    ), { readOnly: true, wide: true })
  }

  const row = (agent: FixtureAgent, control: ReactNode) => (
    <IntegrationRow
      key={agent.slug}
      icon={<AgentAvatar agent={avatarOf(agent)} size={28} />}
      bareIcon
      name={agent.name}
      // Says why an agent with no state of its own is here: the default reaches it.
      subtitle={!agent.viewOnlyOwner && agent.state === undefined ? 'Follows All other agents' : undefined}
      viewTransitionName={`xagent-list-${agent.slug}`}
      data-testid={`link-list-row-${agent.slug}`}
      right={agent.viewOnlyOwner ? viewOnlyMenu(agent) : control}
    />
  )

  // "Connect an agent" and "Block an agent" open one picker built from the global search palette's own parts: the same
  // box, field, section and rows, so it types, arrows and Enters the same way. Connecting allows both, like the Allow
  // card; blocking blocks, whatever the agent had.
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const trimmedQuery = query.trim()
  const pool = picker === 'block' ? blockable : connectable
  const matches = pool.filter((a) => a.name.toLowerCase().includes(trimmedQuery.toLowerCase()))
  useEffect(() => {
    if (!picker) return
    setQuery('')
    setActiveIndex(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [picker])
  const pick = (agent: FixtureAgent) => {
    const mode = picker
    setPicker(null)
    setState(agent.slug, mode === 'block' ? 'blocked' : 'both')
  }
  const onPickerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (matches.length === 0 ? 0 : (i + 1) % matches.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (matches.length === 0 ? 0 : (i - 1 + matches.length) % matches.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const agent = matches[activeIndex]
      if (agent) pick(agent)
    }
  }
  const pickerTitle = picker === 'block' ? `Block an agent from ${selfName}` : `Connect an agent to ${selfName}`
  const pickerDialog = (
    <Dialog open={picker !== null} onOpenChange={(open) => { if (!open) setPicker(null) }}>
      <DialogContent className={SEARCH_DIALOG_CONTENT_CLASS} onKeyDown={onPickerKey} aria-label={pickerTitle} data-testid={`link-${picker ?? 'connect'}-dialog`}>
        <DialogTitle className="sr-only">{pickerTitle}</DialogTitle>
        <DialogDescription className="sr-only">
          {picker === 'block'
            ? `Pick an agent ${selfName} can't read, message or ask about`
            : `Pick an agent ${selfName} may read and message without asking you first`}
        </DialogDescription>
        <SearchField
          inputRef={inputRef}
          value={query}
          onChange={(value) => { setQuery(value); setActiveIndex(0) }}
          placeholder={`${pickerTitle}...`}
          testId={`link-${picker ?? 'connect'}-input`}
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" data-testid={`link-${picker ?? 'connect'}-results`}>
          {matches.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              {trimmedQuery ? 'No matches found' : picker === 'block' ? 'Every agent is already blocked' : 'Every agent is already connected'}
            </div>
          ) : (
            <ResultSection label="Agents" count={matches.length}>
              {matches.map((agent, i) => (
                <ResultRow
                  key={agent.slug}
                  index={i}
                  active={activeIndex === i}
                  agent={avatarOf(agent)}
                  title={<HighlightMatch text={agent.name} query={trimmedQuery} />}
                  // What the agent has now, so blocking a connected one is a visible choice.
                  subtitle={picker === 'block' ? LABEL[stateOf(agent)] : 'Asks first'}
                  onSelect={() => pick(agent)}
                  onActivate={setActiveIndex}
                  data-testid={`link-${picker ?? 'connect'}-${agent.slug}`}
                />
              ))}
            </ResultSection>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )

  return (
    <div className="space-y-6" data-testid="link-list">
      <IntegrationList>
        {connected.length === 0 && (
          <p className="px-4 py-3 text-xs text-muted-foreground" data-testid="link-list-empty">
            {selfName} isn’t connected to any agents yet. It asks you first before reading or messaging one.
          </p>
        )}
        {connected.map((agent) => row(agent, connectedMenu(agent)))}
        {/* The default closes the list, in the rows' own words: every agent not named above it. Its avatar is a few of
            the agents, circling slowly, so it reads as "all of them" and not as one agent. */}
        <IntegrationRow
          icon={<AgentOrbit agents={AGENTS.slice(0, 4).map(avatarOf)} size={28} />}
          bareIcon
          name="All other agents"
          data-testid="link-list-all-row"
          right={menu('all', 'All other agents', LABEL[allOthers], (
            <>
              {choices('all', 'All other agents', [{ value: 'ask' as Reach, label: LABEL.ask }, ...CONNECTIONS], allOthers, (value) => animate(() => { setOpenMenu(null); setAllOthers(value) }))}
              {/* What the default covers, last and under a rule, like the view-only note in an agent's menu. */}
              <Separator className="my-2 bg-border/50" />
              <p className="px-2 pb-0.5 text-[11px] leading-snug text-muted-foreground" data-testid="link-list-all-header">
                Set what {selfName} can do with any agent not listed above, and with agents you create later.
              </p>
            </>
          ), { wide: true })}
        />
      </IntegrationList>

      {/* Always on the page, even empty, so blocking an agent never needs connecting it first. */}
      <div className="space-y-1.5" data-testid="link-list-blocked">
          <div className={cn(SECTION_LABEL, 'flex items-center gap-1')}>
            <span>Blocked</span>
            <InfoTip label="What Blocked means" testId="link-list-blocked-info">{selfName} can’t read or message these agents, and can’t ask to.</InfoTip>
          </div>
          {blocked.length === 0 ? (
            // Empty: say why you'd block, which is what sets it apart from Ask first. One quiet row on a grey ground, the
            // reason on the left and the way in on the right.
            <div className="flex items-center gap-3 rounded-card bg-muted/50 px-4 py-3" data-testid="link-list-blocked-empty">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">Block an agent to keep {selfName} from reading or messaging it, even with your approval.</p>
              {blockable.length > 0 && (
                <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => setPicker('block')} data-testid="link-block-trigger">
                  <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
                  Block an agent
                </Button>
              )}
            </div>
          ) : (
            <IntegrationList>
              {blocked.map((agent) => row(agent, removeBlock(agent)))}
              {blockable.length > 0 && (
                // A plain ghost button with a plus, not a row of its own: it adds an agent to the list above it.
                <div className="px-2 py-1.5">
                  <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={() => setPicker('block')} data-testid="link-block-trigger">
                    <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
                    Block an agent
                  </Button>
                </div>
              )}
            </IntegrationList>
          )}
        </div>

      {titleActions && createPortal(
        <Button variant="outline" size="sm" disabled={connectable.length === 0} onClick={() => setPicker('connect')} data-testid="link-connect-trigger">
          <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Connect an agent
        </Button>,
        titleActions,
      )}
      {pickerDialog}

      {/* The fixture's own controls, out of the page: a card in the bottom-right corner, styled like the app's toasts. */}
      {createPortal(controlsHidden ? (
        <button
          type="button"
          onClick={() => setControlsHidden(false)}
          className="fixed bottom-4 right-4 z-50 flex items-center gap-1.5 rounded-full border bg-background px-3 py-1.5 text-xs text-muted-foreground shadow-lg hover:text-foreground"
          data-testid="link-fixture-show"
        >
          <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />Fixture
        </button>
      ) : (
        <div role="region" aria-label="Link fixture controls" className="fixed bottom-4 right-4 z-50 w-72 space-y-3 rounded-card border bg-background p-3 text-xs shadow-lg" data-testid="link-fixture-controls">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="font-medium">Connections experiment</div>
              <div className="text-muted-foreground">Fixture data, nothing is saved.</div>
            </div>
            <button type="button" onClick={() => setControlsHidden(true)} className="-mr-1 -mt-1 rounded-control p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Hide fixture controls" data-testid="link-fixture-hide">
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          <div className="flex justify-end gap-1 text-muted-foreground">
            <button type="button" onClick={createAgent} className="rounded-control px-2 py-1 hover:bg-muted hover:text-foreground" data-testid="link-fixture-create">New agent (test)</button>
            <button type="button" onClick={reset} className="rounded-control px-2 py-1 hover:bg-muted hover:text-foreground" data-testid="link-fixture-reset">Reset</button>
          </div>
        </div>
      ), document.body)}
    </div>
  )
}
