/**
 * An agent whose container runs somewhere other than this machine (a sandbox
 * provider) and whose workspace lives with that container.
 *
 * It is a `LocalAgentActor` in everything but its session store: the
 * container, session, message and input ops act through the agent's
 * `ContainerRuntime`, whose client is the provider's, and through the state
 * this process holds for the agent, exactly as for a local agent. What
 * differs is where the files are, and since the transcripts, the config
 * documents and the memories are all read and written through the store's
 * files, they follow:
 *
 * - while the container runs, through the container's workspace routes;
 * - while it is down, in the provider's store (`RemoteWorkspace.asleep`).
 *
 * See `switchingFileOps` for the rule at the moments in between.
 *
 * The provider brings the store and keeps it and the container's workspace
 * the same: the container restores the store on start, saves to it before it
 * stops, and a write made to the store while it was down is in the next
 * restore.
 */
import { SessionSummaryCache } from '@shared/lib/services/session-summary-slot'
import type { AgentState } from './agent-state'
import { createConfigOps } from './config-ops'
import { createContainerFileOps } from './container-file-ops'
import { LocalAgentActor, type LocalActorDeps } from './local-agent-actor'
import { CLI_TRANSCRIPTS_DIR, type SessionStore } from './session-store'
import { switchingFileOps, type WorkspacePhase } from './switching-file-ops'
import type { AgentSlug, StoreFileOps } from './types'

/** Where a provider keeps an agent's workspace. */
export interface RemoteWorkspace {
  /** The workspace while the agent's container is down. */
  readonly asleep: StoreFileOps
  /** Identifies the storage, so state cached per workspace (the session summary) follows it. */
  readonly key: string
  /** Where the CLI writes transcripts, when the container mounts the workspace somewhere other than `/workspace`. */
  readonly transcriptsDir?: string
}

export function createRemoteSessionStore(
  slug: AgentSlug,
  deps: Pick<LocalActorDeps, 'containerHost'>,
  workspace: RemoteWorkspace,
  hooks: Pick<SessionStore, 'onActivity'> = {},
): SessionStore {
  const runtime = () => deps.containerHost.runtime(slug)
  const phase = (): WorkspacePhase => {
    const current = runtime()
    if (current.isStarting() || current.isStopping()) return 'changing'
    return current.getCachedInfo().status === 'running' ? 'awake' : 'asleep'
  }
  const files = switchingFileOps({
    phase,
    awake: createContainerFileOps((path, init) => runtime().getClient().fetch(path, init)),
    asleep: workspace.asleep,
  })
  return {
    slug,
    files,
    // Updates serialize within this process only. A document the container
    // also writes (`.env`) is not under the on-disk lock a local workspace
    // shares with the container: an update here can race one made inside it.
    config: createConfigOps(files),
    transcriptsDir: workspace.transcriptsDir ?? CLI_TRANSCRIPTS_DIR,
    key: workspace.key,
    summaryCache: new SessionSummaryCache(),
    onActivity: hooks.onActivity,
  }
}

export class RemoteAgentActor extends LocalAgentActor {
  constructor(slug: AgentSlug, deps: LocalActorDeps, workspace: RemoteWorkspace, state?: AgentState) {
    super(slug, deps, state, (hooks) => createRemoteSessionStore(slug, deps, workspace, hooks))
  }
}
