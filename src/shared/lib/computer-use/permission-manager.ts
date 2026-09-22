/**
 * The router in front of every agent's computer-use permissions.
 *
 * The grants and the grabbed app live in each agent's actor
 * (`AgentComputerUse`); this singleton dispatches the calls that arrive with
 * a slug — the persister's permission check on a computer-use tool call, the
 * runtime's ungrab when a container stops — to that agent's store. A read for
 * an agent that has no handle finds nothing in memory; a check loads the
 * agent's persisted grants through its store, as it always did.
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
  checkPermission(
    agentSlug: string,
    level: ComputerUsePermissionLevel,
    appName?: string,
  ): 'granted' | 'prompt_needed' {
    return this.agents.get(agentSlug).check(level, appName)
  }

  /** `AgentComputerUse.grant` */
  grantPermission(
    agentSlug: string,
    level: ComputerUsePermissionLevel,
    grantType: PermissionGrantType,
    appName?: string,
  ): void {
    this.agents.get(agentSlug).grant(level, grantType, appName)
  }

  /** `AgentComputerUse.consumeOnce` */
  consumeOnceGrant(agentSlug: string, level: ComputerUsePermissionLevel, appName?: string): void {
    this.agents.peek(agentSlug)?.consumeOnce(level, appName)
  }

  /** `AgentComputerUse.revokeAll` */
  revokeAllForAgent(agentSlug: string): void {
    this.agents.get(agentSlug).revokeAll()
  }

  /** `AgentComputerUse.revoke` */
  revokeGrant(agentSlug: string, level: ComputerUsePermissionLevel, appName?: string): void {
    this.agents.get(agentSlug).revoke(level, appName)
  }

  /** `AgentComputerUse.activeGrants` */
  getGrantsForAgent(agentSlug: string): PermissionGrant[] {
    return this.agents.get(agentSlug).activeGrants()
  }

  /** `AgentComputerUse.setGrabbed` */
  setGrabbedApp(agentSlug: string, appName: string): void {
    this.agents.get(agentSlug).setGrabbed(appName)
  }

  /** `AgentComputerUse.clearGrabbed` */
  clearGrabbedApp(agentSlug: string): void {
    this.agents.peek(agentSlug)?.clearGrabbed()
  }

  /** `AgentComputerUse.grabbed` */
  getGrabbedApp(agentSlug: string): string | undefined {
    return this.agents.peek(agentSlug)?.grabbed()
  }
}

/** Singleton instance */
export const computerUsePermissionManager = new ComputerUsePermissionManager()
