import { containerManager } from '@shared/lib/container/container-manager'
import { messagePersister } from '@shared/lib/container/message-persister'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'
import { reviewManager } from '@shared/lib/proxy/review-manager'
import { computerUsePermissionManager } from '@shared/lib/computer-use/permission-manager'
import { mcpReauthManager } from '@shared/lib/proxy/mcp-reauth-manager'
import * as sessionService from '@shared/lib/services/session-service'
import { appendInformationalEntry } from '@shared/lib/services/session-transcript-append'
import { getAgentWorkspaceDir } from '@shared/lib/utils/file-storage'
import {
  updateConnectedAccountsEnvironment,
  updateRemoteMcpEnvironment,
} from '@shared/lib/container/connection-runtime-sync'
import { LocalAgentActor, type LocalActorDeps } from './local-agent-actor'
import type { AgentActor, AgentRegistry, AgentSlug } from './types'

/**
 * Build a registry whose handles delegate to `deps`. Handles hold no state of
 * their own yet — the container client and per-agent caches still live in the
 * container manager — so a handle is cheap and is created on first `get`.
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
    all: () => deps.containerManager.getRunningAgentIds().map(get),
    evict: (slug) => {
      deps.containerManager.removeClient(slug)
      handles.delete(slug)
    },
    evictAll: () => {
      deps.containerManager.clearClients()
      handles.clear()
    },
  }
}

// Getters, not values: each dependency is read when an actor method runs, not
// when this module loads. A test that mocks one of these modules therefore
// intercepts exactly the call it always intercepted, and the others are never
// touched — the same as when the consumer imported the module directly.
export const agentRegistry: AgentRegistry = createAgentRegistry({
  get containerManager() {
    return containerManager
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
  get updateConnectedAccountsEnvironment() {
    return updateConnectedAccountsEnvironment
  },
  get updateRemoteMcpEnvironment() {
    return updateRemoteMcpEnvironment
  },
})
