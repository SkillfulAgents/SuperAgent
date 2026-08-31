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

/**
 * Minimal capability marker for a connected account owned by another user.
 *
 * `mappingId` names the agent↔account LINK, never the account: it carries no
 * owner, provider, or account identity, and the only route that accepts it —
 * the agent-owner unlink below — re-checks that the link belongs to the agent
 * in the URL. That is what lets a co-owner drop a shared connection from their
 * agent without ever learning whose it is.
 */
export interface ForeignAgentConnectedAccount {
  kind: 'connected-account'
  toolkitSlug: string
  mappingId: string
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

/**
 * Minimal capability marker for a remote MCP owned by another user. See
 * {@link ForeignAgentConnectedAccount} for why `mappingId` is safe to expose.
 */
export interface ForeignAgentRemoteMcp {
  kind: 'remote-mcp'
  mappingId: string
}

export type AgentRemoteMcpDto = PublicAgentRemoteMcp | ForeignAgentRemoteMcp

const mcpToolInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
}).loose()

const mcpToolsSchema = z.array(mcpToolInfoSchema)

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
    return {
      kind: 'connected-account',
      toolkitSlug: account.toolkitSlug,
      mappingId: mapping.id,
    }
  }

  return {
    id: account.id,
    providerConnectionId: account.providerConnectionId,
    providerName: account.providerName,
    toolkitSlug: account.toolkitSlug,
    displayName: account.displayName,
    status: account.status,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
    mappingId: mapping.id,
    mappedAt: mapping.createdAt.toISOString(),
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
    return { kind: 'remote-mcp', mappingId: mapping.id }
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
    mappedAt: mapping.createdAt.toISOString(),
  }
}

export function isForeignAgentConnectedAccount(
  account: AgentConnectedAccountDto,
): account is ForeignAgentConnectedAccount {
  return 'kind' in account && account.kind === 'connected-account'
}

export function isPublicAgentConnectedAccount(
  account: AgentConnectedAccountDto,
): account is PublicAgentConnectedAccount {
  return !isForeignAgentConnectedAccount(account)
}

export function isForeignAgentRemoteMcp(
  mcp: AgentRemoteMcpDto,
): mcp is ForeignAgentRemoteMcp {
  return 'kind' in mcp && mcp.kind === 'remote-mcp'
}

export function isPublicAgentRemoteMcp(
  mcp: AgentRemoteMcpDto,
): mcp is PublicAgentRemoteMcp {
  return !isForeignAgentRemoteMcp(mcp)
}
