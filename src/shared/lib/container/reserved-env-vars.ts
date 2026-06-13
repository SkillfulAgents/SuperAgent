import { z } from 'zod'

/**
 * Reserved environment variable keys that ContainerManager.doStartContainer()
 * computes and injects into the agent container to wire up required runtime
 * behaviour (proxy auth, agent identity, connected accounts, remote MCPs, host
 * browser, timezone, platform flags, attribution header).
 *
 * User-defined `customEnvVars` from global settings must never clobber these,
 * or they could break proxy authentication, point the agent at the wrong proxy
 * URL, misidentify the agent slug, or spoof connected-account metadata.
 *
 * Keys are reserved UNCONDITIONALLY — even ones only set on some code paths
 * (e.g. REMOTE_MCPS or the host-browser vars) — so a custom config can never
 * spoof them by exploiting a branch where the runtime did not set them.
 */
export const RESERVED_ENV_VAR_KEYS: ReadonlySet<string> = new Set([
  // Proxy authentication
  'PROXY_BASE_URL',
  'PROXY_TOKEN',
  // Cross-agent / host API wiring
  'SUPERAGENT_HOST_API_URL',
  'SUPERAGENT_AGENT_SLUG',
  // Account + MCP metadata
  'CONNECTED_ACCOUNTS',
  'REMOTE_MCPS',
  // Host browser
  'AGENT_BROWSER_USE_HOST',
  'HOST_APP_URL',
  'AGENT_ID',
  // Runtime environment
  'TZ',
  'HOST_PLATFORM',
  'COMPOSIO_PLATFORM_MODE',
  'CLAUDE_CODE_ATTRIBUTION_HEADER',
])

/** True when `key` is a reserved runtime env var that custom config must not override. */
export function isReservedEnvVar(key: string): boolean {
  return RESERVED_ENV_VAR_KEYS.has(key)
}

/**
 * Merge user-defined custom env vars into the computed runtime env map without
 * letting them override reserved keys. Reserved keys are skipped (with a
 * console.warn) so the required runtime wiring always wins; non-reserved keys
 * pass through unchanged. Mutates and returns `target`.
 */
export function mergeCustomEnvVars(
  target: Record<string, string>,
  customEnvVars: Record<string, string> | undefined,
): Record<string, string> {
  if (!customEnvVars) return target
  for (const [key, value] of Object.entries(customEnvVars)) {
    if (isReservedEnvVar(key)) {
      console.warn(
        `[ContainerManager] Ignoring custom env var "${key}": it is a reserved runtime variable and cannot be overridden.`
      )
      continue
    }
    target[key] = value
  }
  return target
}

/**
 * Return the subset of `customEnvVars` keys that collide with reserved runtime
 * variables. Used at the settings write boundary to reject/strip reserved keys.
 */
export function findReservedEnvVarKeys(
  customEnvVars: Record<string, string> | undefined,
): string[] {
  if (!customEnvVars) return []
  return Object.keys(customEnvVars).filter(isReservedEnvVar)
}

/**
 * Zod schema for the `customEnvVars` map at the settings write boundary.
 * Defense-in-depth (per CLAUDE.md's validate-at-boundary rule): rejects any
 * payload that tries to set a reserved runtime key so it never even reaches
 * persisted settings. The container merge (mergeCustomEnvVars) is the primary
 * guard; this stops the bad config at the door.
 */
export const customEnvVarsSchema = z
  .record(z.string(), z.string())
  .superRefine((vars, ctx) => {
    const reserved = findReservedEnvVarKeys(vars)
    if (reserved.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `customEnvVars may not override reserved runtime variables: ${reserved.join(', ')}`,
      })
    }
  })
