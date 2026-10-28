/**
 * The container host: what is not per-agent — runtime readiness, image pulls,
 * the status-sync and health-monitor loops, start-all/stop-all, and shutdown.
 *
 * Per-agent container state lives in the host's `ContainerRuntime` objects,
 * reached only through each agent's actor.
 */
export { containerHost, type ContainerHost } from '@shared/lib/container/container-host'
