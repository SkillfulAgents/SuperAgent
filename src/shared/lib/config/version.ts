declare const __APP_VERSION__: string

/**
 * Application version, injected at build time via `define` in vite/tsup/electron-vite configs.
 * Falls back to '0.0.0-dev' in development if the define is not set.
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev'

export const AGENT_IMAGE_REGISTRY = 'ghcr.io/skilfulagents/superagent-agent-container-base'

/**
 * Get the default agent container image for the current app version.
 * Production builds use the version tag (e.g. :0.2.0).
 * Development uses :main.
 */
export function getDefaultAgentImage(): string {
  const tag = APP_VERSION === '0.0.0-dev' ? 'main' : APP_VERSION
  return `${AGENT_IMAGE_REGISTRY}:${tag}`
}
