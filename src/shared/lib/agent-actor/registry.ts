import { containerHost } from '@shared/lib/container/container-host'
import { messagePersister } from '@shared/lib/container/message-persister'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'
import { reviewManager } from '@shared/lib/proxy/review-manager'
import { computerUsePermissionManager } from '@shared/lib/computer-use/permission-manager'
import { mcpReauthManager } from '@shared/lib/proxy/mcp-reauth-manager'
import * as sessionService from '@shared/lib/services/session-service'
import { appendInformationalEntry } from '@shared/lib/services/session-transcript-append'
import { getAgentClaudeConfigDir, getAgentWorkspaceDir, getSessionJsonlPath } from '@shared/lib/utils/file-storage'
import {
  syncAgentConnectionEnvironment,
  updateConnectedAccountsEnvironment,
  updateRemoteMcpEnvironment,
} from '@shared/lib/container/connection-runtime-sync'
import { loadDailyUsageData, loadSessionUsageTotals } from '@shared/lib/services/usage-service'
import { LocalAgentActor, type LocalActorDeps } from './local-agent-actor'
import type { AgentActor, AgentRegistry, AgentSlug } from './types'

/**
 * Build a registry whose handles delegate to `deps`. A handle is cheap and is
 * created on first `get`; the container state behind it is the agent's
 * `ContainerRuntime`, held by the container host and created on first use.
 */
export function createAgentRegistry(deps: LocalActorDeps): AgentRegistry {
  const handles = new Map<AgentSlug, AgentActor>()

  const get = (slug: AgentSlug): AgentActor => {
    let actor = handles.get(slug)
    if (!actor) {
      actor = new LocalAgentActor(slug, deps)
      handles.set(slug, actor)
    }
    return actor
  }

  return {
    get,
    peek: (slug) => handles.get(slug),
    running: () => deps.containerHost.getRunningAgentIds().map(get),
    evict: (slug) => {
      deps.containerHost.dropRuntime(slug)
      handles.delete(slug)
    },
    evictAll: () => {
      deps.containerHost.clearRuntimes()
      handles.clear()
    },
  }
}

// Getters, not values: each dependency is read when an actor method runs, not
// when this module loads. A test that mocks one of these modules therefore
// intercepts exactly the call it always intercepted, and the others are never
// touched — the same as when the consumer imported the module directly.
export const agentRegistry: AgentRegistry = createAgentRegistry({
  get containerHost() {
    return containerHost
  },
  get messagePersister() {
    return messagePersister
  },
  get userInputRequestManager() {
    return userInputRequestManager
  },
  get reviewManager() {
    return reviewManager
  },
  get computerUsePermissionManager() {
    return computerUsePermissionManager
  },
  get mcpReauthManager() {
    return mcpReauthManager
  },
  get sessionService() {
    return sessionService
  },
  get appendInformationalEntry() {
    return appendInformationalEntry
  },
  get getAgentWorkspaceDir() {
    return getAgentWorkspaceDir
  },
  get getAgentClaudeConfigDir() {
    return getAgentClaudeConfigDir
  },
  get getSessionJsonlPath() {
    return getSessionJsonlPath
  },
  get updateConnectedAccountsEnvironment() {
    return updateConnectedAccountsEnvironment
  },
  get updateRemoteMcpEnvironment() {
    return updateRemoteMcpEnvironment
  },
  get syncAgentConnectionEnvironment() {
    return syncAgentConnectionEnvironment
  },
  get loadDailyUsageData() {
    return loadDailyUsageData
  },
  get loadSessionUsageTotals() {
    return loadSessionUsageTotals
  },
})
