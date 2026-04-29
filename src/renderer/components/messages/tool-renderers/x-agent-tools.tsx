import { Users, UserPlus, Send, List, ScrollText, ArrowUpRight } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps } from './types'
import { useSelection } from '@renderer/context/selection-context'
import {
  listAgentsDef,
  createAgentDef,
  invokeAgentDef,
  getAgentSessionsDef,
  getAgentSessionTranscriptDef,
  type CreateAgentInput,
  type InvokeAgentInput,
  type GetAgentSessionsInput,
  type GetAgentSessionTranscriptInput,
} from '@shared/lib/tool-definitions/x-agent-tools'

// ── shared helpers ────────────────────────────────────────────

function AgentLink({ slug, label }: { slug: string; label?: string }) {
  const { selectAgent } = useSelection()
  return (
    <button
      type="button"
      onClick={() => selectAgent(slug)}
      className="inline-flex items-center gap-1 text-primary hover:underline"
    >
      {label ?? slug}
      <ArrowUpRight className="h-3 w-3" />
    </button>
  )
}

function SessionLink({ slug, sessionId }: { slug: string; sessionId: string }) {
  const { selectAgent, selectSession } = useSelection()
  return (
    <button
      type="button"
      onClick={() => {
        selectAgent(slug)
        selectSession(sessionId)
      }}
      className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
    >
      {sessionId.slice(0, 12)}…
      <ArrowUpRight className="h-3 w-3" />
    </button>
  )
}

function ResultBlock({ result, isError }: { result?: string | null; isError?: boolean }) {
  if (!result) return null
  return (
    <pre
      className={`bg-background whitespace-pre-wrap rounded p-2 text-xs ${
        isError ? 'text-red-800 dark:text-red-200' : 'text-foreground/90'
      }`}
    >
      {result}
    </pre>
  )
}

// ── list_agents ───────────────────────────────────────────────

function ListAgentsExpandedView({ result, isError }: ToolRendererProps) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Listing other agents in this workspace.</p>
      <ResultBlock result={result} isError={isError} />
    </div>
  )
}

export const listAgentsRenderer: ToolRenderer = {
  displayName: listAgentsDef.displayName,
  icon: Users,
  getSummary: listAgentsDef.getSummary,
  ExpandedView: ListAgentsExpandedView,
}

// ── create_agent ──────────────────────────────────────────────

function CreateAgentExpandedView({ input, result, isError }: ToolRendererProps) {
  const { name, description, instructions } = input as CreateAgentInput
  // Parse slug from result text if available (format: 'Created agent "X" with slug "Y".')
  const slugMatch = typeof result === 'string' ? result.match(/slug "([^"]+)"/) : null
  const createdSlug = slugMatch?.[1]

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        {name && <span className="font-medium">{name}</span>}
        {createdSlug && (
          <code className="rounded bg-background px-1.5 py-0.5 text-xs">{createdSlug}</code>
        )}
      </div>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {instructions && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Instructions</div>
          <pre className="whitespace-pre-wrap rounded bg-background p-2 text-xs">{instructions}</pre>
        </div>
      )}
      {createdSlug && (
        <div className="text-xs">
          Open: <AgentLink slug={createdSlug} label={name ?? createdSlug} />
        </div>
      )}
      <ResultBlock result={result} isError={isError} />
    </div>
  )
}

export const createAgentRenderer: ToolRenderer = {
  displayName: createAgentDef.displayName,
  icon: UserPlus,
  getSummary: createAgentDef.getSummary,
  ExpandedView: CreateAgentExpandedView,
}

// ── invoke_agent ──────────────────────────────────────────────

function InvokeAgentExpandedView({ input, result, isError }: ToolRendererProps) {
  const { slug, prompt, session_id, sync } = input as InvokeAgentInput
  // Parse sessionId + status from result (format: 'session_id: X\nstatus: Y\n...')
  const resultText = typeof result === 'string' ? result : ''
  const sessionIdMatch = resultText.match(/session_id:\s*([^\s]+)/)
  const statusMatch = resultText.match(/status:\s*([^\s]+)/)
  const resolvedSessionId = sessionIdMatch?.[1] ?? session_id

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Target:</span>
        {slug ? <AgentLink slug={slug} /> : <span>—</span>}
        {resolvedSessionId && slug && (
          <>
            <span className="text-muted-foreground">·</span>
            <SessionLink slug={slug} sessionId={resolvedSessionId} />
          </>
        )}
        {sync && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
            sync
          </span>
        )}
        {statusMatch && (
          <span
            className={`rounded px-1.5 py-0.5 text-xs ${
              statusMatch[1] === 'completed'
                ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                : 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
            }`}
          >
            {statusMatch[1]}
          </span>
        )}
      </div>
      {prompt && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Prompt</div>
          <div className="bg-background rounded p-2 text-xs whitespace-pre-wrap">
            {prompt}
          </div>
        </div>
      )}
      <ResultBlock result={result} isError={isError} />
    </div>
  )
}

export const invokeAgentRenderer: ToolRenderer = {
  displayName: invokeAgentDef.displayName,
  icon: Send,
  getSummary: invokeAgentDef.getSummary,
  ExpandedView: InvokeAgentExpandedView,
}

// ── get_agent_sessions ────────────────────────────────────────

function GetAgentSessionsExpandedView({ input, result, isError }: ToolRendererProps) {
  const { slug } = input as GetAgentSessionsInput
  return (
    <div className="space-y-2">
      <div className="text-xs">
        <span className="text-muted-foreground">Sessions of:</span> {slug ? <AgentLink slug={slug} /> : '—'}
      </div>
      <ResultBlock result={result} isError={isError} />
    </div>
  )
}

export const getAgentSessionsRenderer: ToolRenderer = {
  displayName: getAgentSessionsDef.displayName,
  icon: List,
  getSummary: getAgentSessionsDef.getSummary,
  ExpandedView: GetAgentSessionsExpandedView,
}

// ── get_agent_session_transcript ──────────────────────────────

function GetAgentSessionTranscriptExpandedView({ input, result, isError }: ToolRendererProps) {
  const { slug, session_id, sync } = input as GetAgentSessionTranscriptInput
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Reading:</span>
        {slug ? <AgentLink slug={slug} /> : '—'}
        {slug && session_id && (
          <>
            <span className="text-muted-foreground">·</span>
            <SessionLink slug={slug} sessionId={session_id} />
          </>
        )}
        {sync && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
            sync
          </span>
        )}
      </div>
      <ResultBlock result={result} isError={isError} />
    </div>
  )
}

export const getAgentSessionTranscriptRenderer: ToolRenderer = {
  displayName: getAgentSessionTranscriptDef.displayName,
  icon: ScrollText,
  getSummary: getAgentSessionTranscriptDef.getSummary,
  ExpandedView: GetAgentSessionTranscriptExpandedView,
}
