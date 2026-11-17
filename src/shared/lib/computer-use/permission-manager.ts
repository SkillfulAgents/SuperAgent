/**
 * The router in front of every agent's computer-use permissions.
 *
 * The grants and the active app live in each agent's actor
 * (`AgentComputerUse`); this singleton dispatches the calls that arrive with
 * a slug — the runtime's cleanup when a container stops — to that agent's
 * store. The agent's own live sessions call its store directly. A read for
 * an agent that has no handle finds nothing in memory; a check reads the
 * agent's persisted grants from settings through its store.
 */
import { AttachedStores, type AgentStoreDirectory } from '@shared/lib/agent-actor/store-directory'
import { AgentComputerUse } from './agent-permissions'
import type { ComputerUsePermissionLevel, PermissionGrant, PermissionGrantType } from './types'

export class ComputerUsePermissionManager {
  private readonly agents = new AttachedStores<AgentComputerUse>('computer-use permissions')

  /** Called once by the agent registry with the way to each agent's store. */
  attachAgents(directory: AgentStoreDirectory<AgentComputerUse> | null): void {
    this.agents.attach(directory)
  }

  /** `AgentComputerUse.check` */
  async checkPermission(
    agentSlug: string,
    level: ComputerUsePermissionLevel,
    appName?: string,
  ): Promise<'granted' | 'prompt_needed'> {
    return this.agents.get(agentSlug).check(level, appName)
  }

  /** `AgentComputerUse.grant` */
  async grantPermission(
    agentSlug: string,
    level: ComputerUsePermissionLevel,
    grantType: PermissionGrantType,
    appName?: string,
  ): Promise<void> {
    await this.agents.get(agentSlug).grant(level, grantType, appName)
  }

  /** `AgentComputerUse.consumeOnce` */
  consumeOnceGrant(agentSlug: string, level: ComputerUsePermissionLevel, appName?: string): void {
    this.agents.peek(agentSlug)?.consumeOnce(level, appName)
  }

  /** `AgentComputerUse.revokeAll` */
  async revokeAllForAgent(agentSlug: string): Promise<void> {
    await this.agents.get(agentSlug).revokeAll()
  }

  /** `AgentComputerUse.revoke` */
  async revokeGrant(agentSlug: string, level: ComputerUsePermissionLevel, appName?: string): Promise<void> {
    await this.agents.get(agentSlug).revoke(level, appName)
  }

  /** `AgentComputerUse.activeGrants` */
  async getGrantsForAgent(agentSlug: string): Promise<PermissionGrant[]> {
    return this.agents.get(agentSlug).activeGrants()
  }

  /** `AgentComputerUse.setActiveApp` */
  setActiveApp(agentSlug: string, sessionId: string, appName: string): boolean {
    return this.agents.get(agentSlug).setActiveApp(sessionId, appName)
  }

  /** `AgentComputerUse.clearActiveApp`: every session's of the agent. */
  clearActiveApp(agentSlug: string): void {
    this.agents.peek(agentSlug)?.clearActiveApp()
  }

  /** `AgentComputerUse.activeApp` */
  getActiveApp(agentSlug: string, sessionId: string): string | undefined {
    return this.agents.peek(agentSlug)?.activeApp(sessionId)
  }
}

/** Singleton instance */
export const computerUsePermissionManager = new ComputerUsePermissionManager()
