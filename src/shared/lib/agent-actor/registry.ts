import { containerHost } from '@shared/lib/container/container-host'
import { messagePersister } from '@shared/lib/container/message-persister'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'
import { reviewManager } from '@shared/lib/proxy/review-manager'
import { accountReauthManager } from '@shared/lib/proxy/account-reauth-manager'
import { computerUsePermissionManager } from '@shared/lib/computer-use/permission-manager'
import { mcpReauthManager } from '@shared/lib/proxy/mcp-reauth-manager'
import * as sessionService from '@shared/lib/services/session-service'
import { appendAssistantEntry, appendInformationalEntry } from '@shared/lib/services/session-transcript-append'
import { recordSessionActivity } from '@shared/lib/services/session-summary-cache'
import * as transcriptOps from './local-transcript-ops'
import { getAgentWorkspaceDir } from '@shared/lib/utils/file-storage'
import {
  syncAgentConnectionEnvironment,
  updateConnectedAccountsEnvironment,
  updateRemoteMcpEnvironment,
} from '@shared/lib/container/connection-runtime-sync'
import { loadDailyUsageData, loadSessionUsageTotals } from '@shared/lib/services/usage-service'
import { LocalAgentActor, type LocalActorDeps } from './local-agent-actor'
import type { AgentState } from './agent-state'
import type { AgentStoreDirectory } from './store-directory'
import type { AgentActor, AgentRegistry, AgentSlug } from './types'

/**
 * Build a registry whose handles delegate to `deps`. A handle is created on
 * first `get` and holds the agent's in-memory state (see `AgentState`); the
 * container state behind it is the agent's `ContainerRuntime`, held by the
 * container host and created on first use. Evicting a handle releases both.
 *
 * The registry also hands the message persister the way to each agent's
 * session store: the persister is inside the actor and cannot ask the
 * registry, and the store it stats and appends to must be the one the
 * agent's actor reads. In the same way it hands the user-input, review,
 * re-auth and computer-use routers the way to each actor's stores.
 */
export function createAgentRegistry(deps: LocalActorDeps): AgentRegistry {
  const handles = new Map<AgentSlug, LocalAgentActor>()

  const get = (slug: AgentSlug): LocalAgentActor => {
    let actor = handles.get(slug)
    if (!actor) {
      actor = new LocalAgentActor(slug, deps)
      handles.set(slug, actor)
    }
    return actor
  }

  const evict = (slug: AgentSlug): void => {
    // Release what the handle owns while its runtime still exists: settling
    // a parked request may still want to recompute the agent's awaiting state.
    handles.get(slug)?.dispose()
    deps.containerHost.dropRuntime(slug)
    handles.delete(slug)
  }

  // The container layer reaches an agent's workspace only through its actor;
  // this is where it gets the way in. Wired here, by the package that owns
  // the actors, so no entry point has to remember to.
  deps.containerHost.attachAgentWorkspaces({
    files: (slug) => get(slug).files,
    instructions: (slug) => get(slug).config.get('instructions'),
  })

  // The persister's way to the agents' session stores is attached on first
  // use, not at construction: this module and the persister import each
  // other, and the persister is not initialized while this module evaluates.
  // Every path that gives the persister a session to work on goes through a
  // handle first. A test double of the persister may not carry the port; the
  // real one does.
  let attached = false
  const attach = () => {
    if (attached) return
    attached = true
    deps.messagePersister.attachSessionStores?.((slug) => get(slug).store)
  }

  // The routers over the actors' stores get the same: one directory each,
  // reading through the handles, so nothing is stored anywhere but on them.
  // A router creating a handle is a first use like any other, so the
  // persister is attached then too. A test double may not carry the port;
  // the real routers do.
  const directory = <T>(pick: (state: AgentState) => T): AgentStoreDirectory<T> => ({
    get: (slug) => {
      attach()
      return pick(get(slug).state)
    },
    peek: (slug) => {
      const actor = handles.get(slug)
      return actor ? pick(actor.state) : undefined
    },
    all: () => [...handles.values()].map((actor) => pick(actor.state)),
  })
  deps.userInputRequestManager.attachAgents?.(directory((state) => state.inputRequests))
  deps.reviewManager.attachAgents?.(directory((state) => state.reviews))
  deps.accountReauthManager.attachAgents?.(directory((state) => state.accountReauth))
  deps.mcpReauthManager.attachAgents?.(directory((state) => state.mcpReauth))
  deps.computerUsePermissionManager.attachAgents?.(directory((state) => state.computerUse))

  return {
    get: (slug): AgentActor => {
      attach()
      return get(slug)
    },
    peek: (slug) => handles.get(slug),
    running: () => {
      attach()
      return deps.containerHost.getRunningAgentIds().map(get)
    },
    evict,
    evictAll: () => {
      // Release every handle first, while the runtimes still exist, then let
      // the host forget the runtimes its own way: one whose container is
      // starting is kept, so the start still lands somewhere the host knows.
      for (const actor of handles.values()) actor.dispose()
      handles.clear()
      deps.containerHost.clearRuntimes()
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
  get accountReauthManager() {
    return accountReauthManager
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
