import type { McpToolInfo } from '../mcp/types'

/** A runtime connection owned by an integration; never an independently editable account. */
export interface IntegrationMcpConnection {
  integrationId: string
  agentSlug: string
  name: string
  url: string
  identity: { provider: string; name: string; workspace: string }
  status: 'active' | 'auth_required'
  tools: McpToolInfo[]
  /** Revalidates parent lifecycle and uses its single rotating credential store. */
  authorization(): Promise<string>
  authRequired(): Promise<void>
  reportHealth(available: boolean): Promise<void>
}
