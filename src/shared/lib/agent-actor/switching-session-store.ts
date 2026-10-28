/**
 * A session store that reads and writes where the agent's files are right
 * now: in its running container, or in the deployment's own storage while
 * the agent sleeps. Every file and config call picks its side when it runs,
 * so a handle kept across a start or a stop follows the agent.
 *
 * Moving the files between the two (the container syncing its workspace to
 * the blob store as it stops, and back as it starts) is the deployment's: the
 * two sides must hold the same files at every switch.
 */
import { SessionSummaryCache } from '@shared/lib/services/session-summary-slot'
import type { SessionStore } from './session-store'
import type { AgentSlug } from './types'

export interface SwitchingSessionStoreOptions {
  slug: AgentSlug
  /** The storage key both sides share, so the session summary survives a switch. */
  key: string
  running: Pick<SessionStore, 'files' | 'config' | 'transcriptsDir'>
  sleeping: Pick<SessionStore, 'files' | 'config' | 'transcriptsDir'>
  isRunning(): boolean
  onActivity?: (activityAtMs: number) => void
}

function follow<T extends object>(pick: () => T): T {
  return new Proxy({} as T, {
    get(_target, key) {
      const side = pick()
      const value = Reflect.get(side, key)
      return typeof value === 'function' ? value.bind(side) : value
    },
  })
}

export function createSwitchingSessionStore(options: SwitchingSessionStoreOptions): SessionStore {
  if (options.running.transcriptsDir !== options.sleeping.transcriptsDir) {
    throw new Error('Both sides of a switching session store must keep transcripts in the same directory')
  }
  const side = () => (options.isRunning() ? options.running : options.sleeping)
  return {
    slug: options.slug,
    files: follow(() => side().files),
    config: follow(() => side().config),
    transcriptsDir: options.running.transcriptsDir,
    key: options.key,
    summaryCache: new SessionSummaryCache(),
    onActivity: options.onActivity,
  }
}
