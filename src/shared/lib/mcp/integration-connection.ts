import { normalizeCachedMcpTools } from './connection-schema'
import type { McpToolInfo } from './types'
import type { IntegrationMcpConnection } from '../agent-integrations/mcp-types'
import type { McpAccessResult, McpAuthorization, McpConnection, McpRecoveryResult } from './connection-types'

/** Adapts the provider contract without creating a separately editable account. */
export class IntegrationMcpAdapter implements McpConnection {
  private readonly tools: McpToolInfo[]

  constructor(private readonly id: string, private readonly connection: IntegrationMcpConnection) {
    this.tools = normalizeCachedMcpTools(connection.tools)
  }

  get descriptor() {
    return { id: this.id, name: `${this.connection.identity.provider}: ${this.connection.identity.name}`,
      url: this.connection.url, status: this.connection.status, tools: this.tools }
  }

  async authorizeInvocation(): Promise<McpAccessResult> {
    return { ok: true, policyDecision: 'integration_identity' }
  }

  async authorization(): Promise<McpAuthorization> {
    return { ok: true, accessToken: await this.connection.authorization() }
  }

  async markAuthRequired(_message: string): Promise<void> {
    await this.connection.authRequired()
  }

  async recoverAuthorization(): Promise<McpRecoveryResult> {
    return { ok: false, reason: 'reconnect_required', error: 'integration_reconnect_required',
      message: `Reconnect ${this.connection.identity.provider} from this agent’s integration settings.`,
      context: { integrationId: this.connection.integrationId } }
  }

  async reportHealth(available: boolean): Promise<void> {
    await this.connection.reportHealth(available)
  }
}
