import type { AppSettings } from '@shared/lib/config/settings'
import {
  settingsAuditDetailsSchema,
  type SettingsAuditChange,
  type SettingsAuditDetails,
} from './settings-audit-schema'

/**
 * Top-level AppSettings keys that PUT /api/settings can change. Keys the
 * handler carries over verbatim (skillsets, platformAuth, …) are excluded so
 * internal bookkeeping never surfaces as a user-made change.
 */
const AUDITED_KEYS: (keyof AppSettings)[] = [
  'container',
  'apiKeys',
  'llmProvider',
  'webProvider',
  'webAllowedSites',
  'webBlockedSites',
  'app',
  'models',
  'modelCatalog',
  'agentLimits',
  'customEnvVars',
  'auth',
  'voice',
  'computerUse',
  'shareAnalytics',
  'analyticsTargets',
  'shareErrorReports',
  'enableToolSearch',
  'agentCapabilities',
]

/**
 * Paths whose values must NEVER reach the audit log — API keys and custom env
 * vars are secrets, the favicon data URL is a multi-KB blob. Only the fact of
 * the change (set/updated/removed) is recorded for these.
 */
const REDACTED_PREFIXES = ['apiKeys.', 'customEnvVars.', 'app.faviconDataUrl']

/** Server-stamped alongside faviconDataUrl — noise next to the change that caused it. */
const IGNORED_PATHS = new Set(['app.faviconUpdatedAt'])

/**
 * Maps a changed path to the settings-UI tab it is edited on, so the audit log
 * can say "LLM Provider" instead of making the reader decode dotted paths.
 * First matching prefix wins — keep specific rules above their catch-alls.
 */
const SECTION_RULES: Array<[prefix: string, label: string]> = [
  ['apiKeys.composio', 'Account Provider'],
  ['apiKeys.nangoSecretKey', 'Account Provider'],
  ['apiKeys.accountProviderUserId', 'Account Provider'],
  ['apiKeys.browserbase', 'Browser Use'],
  ['apiKeys.deepgramApiKey', 'Voice'],
  ['apiKeys.openaiApiKey', 'Voice'],
  ['apiKeys.exaApiKey', 'Web'],
  ['apiKeys.', 'LLM Provider'],
  ['llmProvider', 'LLM Provider'],
  ['models', 'LLM Provider'],
  ['modelCatalog', 'LLM Provider'],
  ['enableToolSearch', 'LLM Provider'],
  ['webProvider', 'Web'],
  ['webAllowedSites', 'Web'],
  ['webBlockedSites', 'Web'],
  ['container', 'Runtime'],
  ['customEnvVars', 'Runtime'],
  ['agentLimits', 'Runtime'],
  ['auth', 'Auth'],
  ['voice', 'Voice'],
  ['computerUse', 'Computer Use'],
  ['agentCapabilities', 'Agent Capabilities'],
  ['shareAnalytics', 'Analytics'],
  ['shareErrorReports', 'Analytics'],
  ['analyticsTargets', 'Analytics'],
  ['app.notifications', 'Notifications'],
  ['app.accountProvider', 'Account Provider'],
  ['app.hostBrowserProvider', 'Browser Use'],
  ['app.chrome', 'Browser Use'],
  ['app.maxBrowserTabs', 'Browser Use'],
  ['app.browserbase', 'Browser Use'],
  ['app.', 'General'],
]

/** Cap logged values so a large list/catalog can't bloat an audit row. */
const MAX_VALUE_LENGTH = 200

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Flattens nested objects to dotted-path leaves; arrays are leaves. */
function flattenLeaves(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue
      flattenLeaves(child, `${prefix}.${key}`, out)
    }
  } else if (value !== undefined) {
    out.set(prefix, value)
  }
}

function leavesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b)
  return Object.is(a, b)
}

function truncate(text: string): string {
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text
}

function formatValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return truncate(value)
  return truncate(JSON.stringify(value) ?? String(value))
}

function isRedacted(path: string): boolean {
  return REDACTED_PREFIXES.some((prefix) => path.startsWith(prefix))
}

function sectionFor(path: string): string {
  const rule = SECTION_RULES.find(([prefix]) => path.startsWith(prefix))
  return rule ? rule[1] : 'Other'
}

/**
 * Diffs two settings snapshots into an audit `details` payload: which
 * settings-UI sections were touched and, per dotted path, what changed.
 * Secret values are reduced to set/updated/removed. Returns undefined when
 * nothing changed.
 */
export function buildSettingsAuditDetails(
  current: AppSettings,
  updated: AppSettings,
): SettingsAuditDetails | undefined {
  const before = new Map<string, unknown>()
  const after = new Map<string, unknown>()
  for (const key of AUDITED_KEYS) {
    flattenLeaves(current[key], key, before)
    flattenLeaves(updated[key], key, after)
  }

  const changes: Record<string, SettingsAuditChange> = {}
  const sections = new Set<string>()

  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (IGNORED_PATHS.has(path)) continue
    const inBefore = before.has(path)
    const inAfter = after.has(path)
    if (inBefore && inAfter && leavesEqual(before.get(path), after.get(path))) continue

    changes[path] = isRedacted(path)
      ? !inBefore ? 'set' : !inAfter ? 'removed' : 'updated'
      : {
          from: inBefore ? formatValue(before.get(path)) : null,
          to: inAfter ? formatValue(after.get(path)) : null,
        }
    sections.add(sectionFor(path))
  }

  if (Object.keys(changes).length === 0) return undefined
  return settingsAuditDetailsSchema.parse({ sections: [...sections].sort(), changes })
}
