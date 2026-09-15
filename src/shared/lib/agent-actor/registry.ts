import { containerHost } from '@shared/lib/container/container-host'
import { messagePersister } from '@shared/lib/container/message-persister'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'
import { reviewManager } from '@shared/lib/proxy/review-manager'
import { computerUsePermissionManager } from '@shared/lib/computer-use/permission-manager'
import { mcpReauthManager } from '@shared/lib/proxy/mcp-reauth-manager'
import * as sessionService from '@shared/lib/services/session-service'
import { appendAssistantEntry, appendInformationalEntry } from '@shared/lib/services/session-transcript-append'
import { recordSessionActivity } from '@shared/lib/services/session-summary-cache'
import * as transcriptOps from './local-transcript-ops'
import { getAgentClaudeConfigDir, getAgentWorkspaceDir, getSessionJsonlPath } from '@shared/lib/utils/file-storage'
import {
  syncAgentConnectionEnvironment,
  updateConnectedAccountsEnvironment,
  updateRemoteMcpEnvironment,
} from '@shared/lib/container/connection-runtime-sync'
import { loadDailyUsageData, loadSessionUsageTotals } from '@shared/lib/services/usage-service'
import { LocalAgentActor, type LocalActorDeps } from './local-agent-actor'
import { ModalAgentActor } from './modal-agent-actor'
import { readAgentPlacement, type AgentPlacement } from './placement'
import type { AgentActor, AgentRegistry, AgentSlug } from './types'

export interface AgentRegistryOptions {
  /** Where an agent lives; decides which actor its handle is. Defaults to the placement document. */
  readPlacement?: (slug: AgentSlug) => AgentPlacement
}

/**
 * Build a registry whose handles delegate to `deps`. A handle is cheap and is
 * created on first `get`; the container state behind it is the agent's
 * `ContainerRuntime`, held by the container host and created on first use.
 *
 * Which actor a handle is follows the agent's placement: a local actor for
 * an agent on this machine, a Modal actor for one whose sandbox and volume
 * are on Modal. Placements are loaded at boot (`loadAgentPlacements`), so a
 * `get` still does no I/O; a handle built for an agent whose placement was
 * not loaded yet is a local one, which is why startup evicts the handles of
 * the agents it finds on Modal once the documents are in.
 */
export function createAgentRegistry(deps: LocalActorDeps, options: AgentRegistryOptions = {}): AgentRegistry {
  const handles = new Map<AgentSlug, AgentActor>()
  const readPlacement = options.readPlacement ?? readAgentPlacement

  const get = (slug: AgentSlug): AgentActor => {
    let actor = handles.get(slug)
    if (!actor) {
      const placement = readPlacement(slug)
      actor = placement.runtime === 'modal' ? new ModalAgentActor(slug, deps, placement) : new LocalAgentActor(slug, deps)
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
  get transcripts() {
    return transcriptOps
  },
  get appendInformationalEntry() {
    return appendInformationalEntry
  },
  get appendAssistantEntry() {
    return appendAssistantEntry
  },
  get recordSessionActivity() {
    return recordSessionActivity
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
