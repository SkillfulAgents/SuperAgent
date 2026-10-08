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
  attachments?: string[]
}

export interface GetAgentSessionsInput {
  slug?: string
  limit?: number
  offset?: number
}

export interface GetAgentSessionTranscriptInput {
  slug?: string
  session_id?: string
  sync?: boolean
}

export interface DownloadAgentFileInput {
  slug?: string
  session_id?: string
  delivery_id?: string
}

function asObj<T>(input: unknown): T {
  return typeof input === 'object' && input !== null ? (input as T) : ({} as T)
}

function parseInvokeAgentInput(input: unknown): InvokeAgentInput {
  const value = asObj<Record<string, unknown>>(input)
  const parsed: InvokeAgentInput = {}
  if (typeof value.slug === 'string') parsed.slug = value.slug
  if (typeof value.prompt === 'string') parsed.prompt = value.prompt
  if (typeof value.session_id === 'string') parsed.session_id = value.session_id
  if (typeof value.sync === 'boolean') parsed.sync = value.sync
  if (Array.isArray(value.attachments) && value.attachments.every((path) => typeof path === 'string')) {
    parsed.attachments = value.attachments
  }
  return parsed
}

function parseDownloadAgentFileInput(input: unknown): DownloadAgentFileInput {
  const value = asObj<Record<string, unknown>>(input)
  const parsed: DownloadAgentFileInput = {}
  if (typeof value.slug === 'string') parsed.slug = value.slug
  if (typeof value.session_id === 'string') parsed.session_id = value.session_id
  if (typeof value.delivery_id === 'string') parsed.delivery_id = value.delivery_id
  return parsed
}

function truncate(s: string | undefined, max = 80): string | null {
  if (!s) return null
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export const listAgentsDef = {
  displayName: 'List Agents',
  parseInput: (i: unknown) => asObj<ListAgentsInput>(i),
  getSummary: () => 'List other agents in this workspace',
} as const

export const createAgentDef = {
  displayName: 'Create Agent',
  parseInput: (i: unknown) => asObj<CreateAgentInput>(i),
  getSummary: (i: unknown) => {
    const { name } = asObj<CreateAgentInput>(i)
    return name ? `Create agent: ${name}` : 'Create new agent'
  },
} as const

export const invokeAgentDef = {
  displayName: 'Invoke Agent',
  parseInput: parseInvokeAgentInput,
  getSummary: (i: unknown) => {
    const { slug, session_id, sync, prompt, attachments } = parseInvokeAgentInput(i)
    if (!slug) return 'Invoke agent'
    const action = session_id ? `${slug}/${session_id.slice(0, 8)}…` : `${slug} (new session)`
    const preview = truncate(prompt, 50)
    const syncLabel = sync ? ' [sync]' : ''
    const fileCount = attachments?.length ?? 0
    const attachmentsLabel = fileCount ? ` [${fileCount} ${fileCount === 1 ? 'file' : 'files'}]` : ''
    return preview
      ? `${action}${syncLabel}${attachmentsLabel}: ${preview}`
      : `${action}${syncLabel}${attachmentsLabel}`
  },
} as const

export const getAgentSessionsDef = {
  displayName: 'Get Agent Sessions',
  parseInput: (i: unknown) => asObj<GetAgentSessionsInput>(i),
  getSummary: (i: unknown) => {
    const { slug } = asObj<GetAgentSessionsInput>(i)
    return slug ? `Sessions of ${slug}` : 'Get agent sessions'
  },
} as const

export const getAgentSessionTranscriptDef = {
  displayName: 'Get Agent Session Transcript',
  parseInput: (i: unknown) => asObj<GetAgentSessionTranscriptInput>(i),
  getSummary: (i: unknown) => {
    const { slug, session_id, sync } = asObj<GetAgentSessionTranscriptInput>(i)
    if (!slug || !session_id) return 'Read agent transcript'
    return `Read ${slug}/${session_id.slice(0, 8)}…${sync ? ' [sync]' : ''}`
  },
} as const

export const downloadAgentFileDef = {
  displayName: 'Download Agent File',
  parseInput: parseDownloadAgentFileInput,
  getSummary: (i: unknown) => {
    const { slug, session_id, delivery_id } = parseDownloadAgentFileInput(i)
    if (!slug) return 'Download agent file'
    if (!session_id) return `Download file from ${slug}`
    const target = `${slug}/${session_id.slice(0, 8)}…`
    return delivery_id ? `Download ${target} · ${delivery_id.slice(0, 8)}…` : `Download ${target}`
  },
} as const
