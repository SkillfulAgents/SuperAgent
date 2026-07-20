import { z } from 'zod'
import type {
  AgentConnectedAccount,
  AgentRemoteMcp,
  ConnectedAccount,
  RemoteMcpServer,
} from '@shared/lib/db/schema'
import type { Provider } from '@shared/lib/account-providers/service-catalog'
import type { McpToolInfo } from '@shared/lib/mcp/types'

export interface PublicAgentConnectedAccount {
  id: string
  providerConnectionId: string
  providerName: string
  toolkitSlug: string
  displayName: string
  status: ConnectedAccount['status']
  createdAt: string
  updatedAt: string
  mappingId: string
  mappedAt: string
  provider?: Provider
}

/** Minimal capability marker for a connected account owned by another user. */
export interface ForeignAgentConnectedAccount {
  kind: 'connected-account'
  toolkitSlug: string
}

export type AgentConnectedAccountDto = PublicAgentConnectedAccount | ForeignAgentConnectedAccount

export interface PublicAgentRemoteMcp {
  id: string
  name: string
  url: string
  authType: RemoteMcpServer['authType']
  status: RemoteMcpServer['status']
  errorMessage: string | null
  tools: McpToolInfo[]
  mappingId: string
  mappedAt: string
}

/** Minimal capability marker for a remote MCP owned by another user. */
export interface ForeignAgentRemoteMcp {
  kind: 'remote-mcp'
}

export type AgentRemoteMcpDto = PublicAgentRemoteMcp | ForeignAgentRemoteMcp

const mcpToolInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
}).loose()

const mcpToolsSchema = z.array(mcpToolInfoSchema)

function serializeDate(value: Date): string {
  return value.toISOString()
}

function parseMcpTools(value: string | null): McpToolInfo[] {
  if (!value) return []
  try {
    const parsed = mcpToolsSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

/**
 * Project an agent-linked account for the current caller. `viewerUserId=null`
 * denotes local mode, where every resource belongs to the single local user.
 */
export function toAgentConnectedAccountDto(
  mapping: AgentConnectedAccount,
  account: ConnectedAccount,
  viewerUserId: string | null,
  provider?: Provider,
): AgentConnectedAccountDto {
  if (viewerUserId !== null && account.userId !== viewerUserId) {
    return { kind: 'connected-account', toolkitSlug: account.toolkitSlug }
  }

  return {
    id: account.id,
    providerConnectionId: account.providerConnectionId,
    providerName: account.providerName,
    toolkitSlug: account.toolkitSlug,
    displayName: account.displayName,
    status: account.status,
    createdAt: serializeDate(account.createdAt),
    updatedAt: serializeDate(account.updatedAt),
    mappingId: mapping.id,
    mappedAt: serializeDate(mapping.createdAt),
    provider,
  }
}

/** Project an agent-linked MCP without exposing another user's server row. */
export function toAgentRemoteMcpDto(
  mapping: AgentRemoteMcp,
  mcp: RemoteMcpServer,
  viewerUserId: string | null,
): AgentRemoteMcpDto {
  if (viewerUserId !== null && mcp.userId !== viewerUserId) {
    return { kind: 'remote-mcp' }
  }

  return {
    id: mcp.id,
    name: mcp.name,
    url: mcp.url,
    authType: mcp.authType,
    status: mcp.status,
    errorMessage: mcp.errorMessage,
    tools: parseMcpTools(mcp.toolsJson),
    mappingId: mapping.id,
    mappedAt: serializeDate(mapping.createdAt),
  }
}

export function isForeignAgentConnectedAccount(
  account: AgentConnectedAccountDto,
): account is ForeignAgentConnectedAccount {
  return 'kind' in account
}

export function isPublicAgentConnectedAccount(
  account: AgentConnectedAccountDto,
): account is PublicAgentConnectedAccount {
  return !isForeignAgentConnectedAccount(account)
}

export function isForeignAgentRemoteMcp(
  mcp: AgentRemoteMcpDto,
): mcp is ForeignAgentRemoteMcp {
  return 'kind' in mcp
}

export function isPublicAgentRemoteMcp(
  mcp: AgentRemoteMcpDto,
): mcp is PublicAgentRemoteMcp {
  return !isForeignAgentRemoteMcp(mcp)
}
