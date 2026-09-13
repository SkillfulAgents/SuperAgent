import type { containerManager } from '@shared/lib/container/container-manager'

/**
 * The container host: what is not per-agent — runtime readiness, image pulls,
 * the status-sync and health-monitor loops, start-all/stop-all, and shutdown.
 *
 * For now this is the container manager itself. The next PR extracts these
 * methods into their own class and the per-agent methods move into the actor.
 */
export type ContainerHost = typeof containerManager
