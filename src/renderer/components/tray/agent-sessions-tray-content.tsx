import { useMemo, type CSSProperties } from 'react'
import { useQueries } from '@tanstack/react-query'
import { ArrowLeft, ArrowUpRight, Bot, ChevronRight } from 'lucide-react'
import { MessageList } from '@renderer/components/messages/message-list'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { AppLink } from '@renderer/components/ui/app-link'
import { useAgents } from '@renderer/hooks/use-agents'
import { useMessages } from '@renderer/hooks/use-messages'
import { sessionQuery } from '@renderer/hooks/query-options'
import { useWorkflow, type AgentCallTab } from '@renderer/context/workflow-context'
import type { ApiAgent, ApiSession } from '@shared/lib/types/api'
import { collectAgentCalls, findCalledAgent } from './agent-calls'
import { TRAY_BODY_CLASS } from './tray-card'
import { TrayTabLiveDot } from './tray-tabs'

/**
 * The page reaches its transcript up under a floating header through
 * --header-overlap (globals.css); a transcript in the drawer has no header
 * above it, so it reaches nowhere.
 */
const NO_HEADER_OVERLAP = { '--header-overlap': '0px' } as CSSProperties

interface CalledSession {
  /** By the agent's id where it is known, so a call by either of its slugs is the one session. */
  call: AgentCallTab
  agent?: ApiAgent
  session?: ApiSession
  /** What this session last asked of it. */
  prompt: string
  working: boolean
}

/**
 * The sessions this one called through invoke_agent, most recent first, each
 * with the called agent and whether that session is working now. `viewing`
 * stays listed even before the transcript has saved the call that started it.
 */
function useCalledSessions(sessionId: string, agentSlug: string, viewing: AgentCallTab | null = null): CalledSession[] {
  const { data: messages } = useMessages(sessionId, agentSlug)
  const { data: agents } = useAgents()
  const calls = useMemo(() => {
    const found = collectAgentCalls(messages, agentSlug).flatMap(call => (
      call.sessionId ? [{ slug: call.slug, sessionId: call.sessionId, prompt: call.prompt }] : []
    ))
    if (viewing && !found.some(call => call.sessionId === viewing.sessionId)) found.unshift({ ...viewing, prompt: '' })
    return found
  }, [messages, agentSlug, viewing])
  const sessions = useQueries({ queries: calls.map(call => sessionQuery(call.slug, call.sessionId)) })
  return calls.map((call, index) => {
    const agent = findCalledAgent(call.slug, agents)
    const session = sessions[index]?.data as ApiSession | undefined
    return {
      call: { slug: agent?.slug ?? call.slug, sessionId: call.sessionId },
      agent,
      session,
      prompt: call.prompt,
      working: !!session?.isActive,
    }
  })
}

/** Lit while any session this one called is working. */
export function AgentSessionsLiveDot({ sessionId, agentSlug }: { sessionId: string; agentSlug: string }) {
  const called = useCalledSessions(sessionId, agentSlug)
  return called.some(entry => entry.working) ? <TrayTabLiveDot /> : null
}

/**
 * The drawer's Invoked agents tab, the Subagents tab's pattern for other
 * agents: every session this one called, the working ones first, and picking
 * one shows that agent's conversation in place, read-only and live, with a way
 * back and a way to open the session itself.
 */
export function AgentSessionsTrayContent({ agentSlug, sessionId }: { agentSlug: string; sessionId: string }) {
  const { agentSessions, viewAgentCall } = useWorkflow()
  const called = useCalledSessions(sessionId, agentSlug, agentSessions.viewing)
  const viewed = agentSessions.viewing
    ? called.find(entry => entry.call.sessionId === agentSessions.viewing?.sessionId)
    : undefined
  const active = called.filter(entry => entry.working)
  const done = called.filter(entry => !entry.working)

  return (
    <div className={TRAY_BODY_CLASS} data-testid="agent-sessions-tray">
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
        {viewed ? (
          <AgentSessionDetail key={viewed.call.sessionId} entry={viewed} onBack={() => viewAgentCall(null)} />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto px-2 py-3" data-testid="agent-sessions-list">
            {called.length === 0 && (
              <div className="px-2 py-1 text-xs text-muted-foreground italic">No agents invoked in this session yet.</div>
            )}
            <AgentSessionGroup title="Active" entries={active} onPick={viewAgentCall} />
            <AgentSessionGroup title="Done" entries={done} onPick={viewAgentCall} />
          </div>
        )}
      </div>
    </div>
  )
}

function AgentSessionGroup({ title, entries, onPick }: { title: string; entries: CalledSession[]; onPick: (call: AgentCallTab) => void }) {
  if (entries.length === 0) return null
  return (
    <section className="mb-4 last:mb-0" data-testid={`agent-sessions-${title.toLowerCase()}`}>
      <h3 className="px-2 pb-1.5 text-xs font-normal text-muted-foreground">
        {title} · {entries.length}
      </h3>
      {entries.map(entry => (
        <AgentSessionRow key={entry.call.sessionId} entry={entry} onPick={() => onPick(entry.call)} />
      ))}
    </section>
  )
}

function CalledAgentIcon({ entry, size }: { entry: CalledSession; size: number }) {
  return entry.agent?.avatar
    ? <AgentAvatar agent={entry.agent} size={size} state={entry.working ? 'working' : 'idle'} still={!entry.working} />
    : <Bot className="shrink-0 text-muted-foreground" style={{ width: size, height: size }} />
}

/** Laid out as a Subagents row: who, then what it was asked; the chevron on hover says it drills in. */
function AgentSessionRow({ entry, onPick }: { entry: CalledSession; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={entry.prompt || undefined}
      data-testid="agent-sessions-list-row"
      data-working={entry.working || undefined}
      className="group flex w-full items-start gap-2.5 rounded-item px-2 py-2 text-left transition-colors hover:bg-muted/60"
    >
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        <CalledAgentIcon entry={entry} size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]/5 text-foreground">{entry.agent?.name ?? entry.call.slug}</span>
        {entry.prompt && <span className="block truncate text-xs text-muted-foreground">{entry.prompt}</span>}
      </span>
      <ChevronRight
        aria-hidden
        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    </button>
  )
}

function AgentSessionDetail({ entry, onBack }: { entry: CalledSession; onBack: () => void }) {
  const status = entry.session?.isAwaitingInput ? 'Waiting for input' : entry.working ? 'Working' : 'Idle'
  return (
    <div className="flex flex-1 min-h-0 flex-col text-sm" style={NO_HEADER_OVERLAP} data-testid="agent-call-tray">
      <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-2">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 inline-flex shrink-0 rounded-icon p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="All invoked agents"
          title="All invoked agents"
          data-testid="agent-call-back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="min-w-0 truncate text-sm font-medium text-foreground">{entry.agent?.name ?? entry.call.slug}</h2>
        <span className="shrink-0 text-xs text-muted-foreground" data-testid="agent-call-status">{status}</span>
        <AppLink
          to="/agents/$slug/sessions/$sessionId"
          params={{ slug: entry.call.slug, sessionId: entry.call.sessionId }}
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-control px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          data-testid="agent-call-open-session"
        >
          Open session
          <ArrowUpRight className="h-3 w-3" />
        </AppLink>
      </div>
      <div className="flex flex-1 min-h-0 flex-col">
        <MessageList key={entry.call.sessionId} sessionId={entry.call.sessionId} agentSlug={entry.call.slug} readOnly />
      </div>
    </div>
  )
}
