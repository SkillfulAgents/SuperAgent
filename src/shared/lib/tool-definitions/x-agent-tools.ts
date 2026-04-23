/**
 * Tool definitions for x-agent MCP server tools.
 * Mirror the runtime Zod schemas in agent-container/src/tools/agents/*.ts.
 */

export type ListAgentsInput = Record<string, never>

export interface CreateAgentInput {
  name?: string
  description?: string
  instructions?: string
}

export interface InvokeAgentInput {
  slug?: string
  prompt?: string
  session_id?: string
  sync?: boolean
}

export interface GetAgentSessionsInput {
  slug?: string
}

export interface GetAgentSessionTranscriptInput {
  slug?: string
  session_id?: string
  sync?: boolean
}

function asObj<T>(input: unknown): T {
  return typeof input === 'object' && input !== null ? (input as T) : ({} as T)
}

function truncate(s: string | undefined, max = 80): string | null {
  if (!s) return null
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export const listAgentsDef = {
  displayName: 'List Agents',
  iconName: 'Users',
  parseInput: (i: unknown) => asObj<ListAgentsInput>(i),
  getSummary: () => 'List other agents in this workspace',
} as const

export const createAgentDef = {
  displayName: 'Create Agent',
  iconName: 'UserPlus',
  parseInput: (i: unknown) => asObj<CreateAgentInput>(i),
  getSummary: (i: unknown) => {
    const { name } = asObj<CreateAgentInput>(i)
    return name ? `Create agent: ${name}` : 'Create new agent'
  },
} as const

export const invokeAgentDef = {
  displayName: 'Invoke Agent',
  iconName: 'Send',
  parseInput: (i: unknown) => asObj<InvokeAgentInput>(i),
  getSummary: (i: unknown) => {
    const { slug, session_id, sync, prompt } = asObj<InvokeAgentInput>(i)
    if (!slug) return 'Invoke agent'
    const action = session_id ? `→ ${slug}/${session_id.slice(0, 8)}…` : `→ ${slug} (new session)`
    const preview = truncate(prompt, 50)
    const syncLabel = sync ? ' [sync]' : ''
    return preview ? `${action}${syncLabel}: ${preview}` : `${action}${syncLabel}`
  },
} as const

export const getAgentSessionsDef = {
  displayName: 'Get Agent Sessions',
  iconName: 'List',
  parseInput: (i: unknown) => asObj<GetAgentSessionsInput>(i),
  getSummary: (i: unknown) => {
    const { slug } = asObj<GetAgentSessionsInput>(i)
    return slug ? `Sessions of ${slug}` : 'Get agent sessions'
  },
} as const

export const getAgentSessionTranscriptDef = {
  displayName: 'Get Agent Session Transcript',
  iconName: 'ScrollText',
  parseInput: (i: unknown) => asObj<GetAgentSessionTranscriptInput>(i),
  getSummary: (i: unknown) => {
    const { slug, session_id, sync } = asObj<GetAgentSessionTranscriptInput>(i)
    if (!slug || !session_id) return 'Read agent transcript'
    return `Read ${slug}/${session_id.slice(0, 8)}…${sync ? ' [sync]' : ''}`
  },
} as const
