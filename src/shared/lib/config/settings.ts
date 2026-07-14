import fs from 'fs'
import path from 'path'
import os from 'os'
import { getDataDir } from './data-dir'
import { isRunningInKubernetes } from '@shared/lib/container/runtime-env'
import { getDefaultAgentImage, AGENT_IMAGE_REGISTRY } from './version'
import {
  writeFileAtomicSync,
  CorruptFileError,
} from '@shared/lib/utils/file-storage'
import { captureException } from '@shared/lib/error-reporting'
import { persistedSettingsSchema } from './settings-schema'
import { DEFAULT_GLOBAL_DISPATCH_SHORTCUT } from './shortcuts'
import type { SkillsetConfig } from '@shared/lib/types/skillset'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'
import type { ComputerUseSettings } from '@shared/lib/computer-use/types'
import type { EffortLevel } from '@shared/lib/container/types'
import {
  modelCatalogSettingsSchema,
  type ModelCatalogSettings,
} from '../llm-provider/model-catalog-schema'
import {
  capabilityPolicySchema,
  DEFAULT_AGENT_CAPABILITIES,
  type AgentCapabilitySettings,
} from './capability-policy-schema'

export type { AgentCapabilitySettings, CapabilityPolicy } from './capability-policy-schema'

export interface ContainerSettings {
  containerRunner: string
  agentImage: string
  resourceLimits: {
    cpu: number
    memory: string
  }
  /**
   * Per-runtime settings, keyed by runner name.
   * Each runtime can define its own params (VM config, API keys, etc.).
   */
  runtimeSettings?: Record<string, Record<string, string>>
}

export interface ApiKeySettings {
  anthropicApiKey?: string
  openrouterApiKey?: string
  /** Generic (custom baseURL) provider key, sent as ANTHROPIC_AUTH_TOKEN. */
  genericApiKey?: string
  /** Generic provider endpoint (Anthropic-wire-compatible), e.g. a LiteLLM proxy. */
  genericBaseUrl?: string
  bedrockApiKey?: string
  bedrockAccessKeyId?: string
  bedrockSecretAccessKey?: string
  bedrockRegion?: string
  composioApiKey?: string
  composioUserId?: string
  browserbaseApiKey?: string
  browserbaseProjectId?: string
  deepgramApiKey?: string
  openaiApiKey?: string
  nangoSecretKey?: string
  accountProviderUserId?: string
  exaApiKey?: string
}

export type SttProvider = 'deepgram' | 'openai' | 'platform'

export interface VoiceSettings {
  sttProvider?: SttProvider
}

export interface NotificationSettings {
  enabled: boolean
  sessionComplete: boolean
  sessionWaiting: boolean
  sessionScheduled: boolean
  platformNotification?: boolean
  notifyWhenUnfocused?: boolean
}

export interface ModelSettings {
  summarizerModel: string
  agentModel: string
  browserModel: string
  dashboardBuilderModel: string
  /** Default reasoning effort seeded into the composer for new agent sessions. */
  agentEffort?: EffortLevel
}

export interface AgentLimitsSettings {
  maxOutputTokens?: number
  maxThinkingTokens?: number
  maxTurns?: number
  maxBudgetUsd?: number
}

export type HostBrowserProviderId = 'chrome' | 'browserbase' | 'platform'

export type BrowserbaseStealthOs = 'linux' | 'windows' | 'mac' | 'mobile' | 'tablet'

export type AccountProviderType = 'composio' | 'nango'

export interface AppPreferences {
  showMenuBarIcon?: boolean
  notifications?: NotificationSettings
  autoSleepTimeoutMinutes?: number
  autoDeleteInactiveDays?: number
  setupCompleted?: boolean
  accountProvider?: AccountProviderType
  hostBrowserProvider?: HostBrowserProviderId
  chromeProfileId?: string
  chromeHeadless?: boolean
  allowPrereleaseUpdates?: boolean
  theme?: 'system' | 'light' | 'dark'
  /**
   * OS-global accelerator that opens the quick-dispatch launcher (e.g.
   * "CommandOrControl+Shift+Space"). Read by the main process at startup and
   * re-registered live on change. Empty string disables the launcher.
   */
  globalDispatchShortcut?: string
  maxBrowserTabs?: number
  faviconDataUrl?: string
  faviconUpdatedAt?: string

  // Browserbase session settings
  browserbaseAdvancedStealth?: boolean
  browserbaseStealthOs?: BrowserbaseStealthOs
  browserbaseProxies?: boolean
  browserbaseProxyCountry?: string
  browserbaseProxyState?: string
  browserbaseProxyCity?: string
}

export interface AuthSettings {
  trustedOrigins?: string[]

  // Signup & Access
  signupMode?: 'open' | 'domain_restricted' | 'invitation_only' | 'closed'
  allowedSignupDomains?: string[]
  requireAdminApproval?: boolean
  defaultUserRole?: 'member' | 'admin'

  // Auth Methods
  allowLocalAuth?: boolean
  allowSocialAuth?: boolean

  // Password Policy
  passwordMinLength?: number
  passwordMaxLength?: number
  passwordRequireComplexity?: boolean

  // Session
  sessionMaxLifetimeHrs?: number
  sessionIdleTimeoutMin?: number
  maxConcurrentSessions?: number

  // Lockout
  accountLockoutThreshold?: number
  accountLockoutDurationMin?: number
}

export const DEFAULT_AUTH_SETTINGS: AuthSettings = {
  signupMode: 'invitation_only',
  allowedSignupDomains: [],
  requireAdminApproval: true,
  defaultUserRole: 'member',
  allowLocalAuth: true,
  allowSocialAuth: false,
  passwordMinLength: 12,
  passwordMaxLength: 128,
  passwordRequireComplexity: true,
  sessionMaxLifetimeHrs: 24,
  sessionIdleTimeoutMin: 60,
  maxConcurrentSessions: 5,
  accountLockoutThreshold: 10,
  accountLockoutDurationMin: 30,
}

export type ScriptType = 'applescript' | 'shell' | 'powershell'

/** Script types supported on each host platform. Used for validation in both message-persister and the run-script API endpoint. */
export const VALID_SCRIPT_TYPES: Record<string, ScriptType[]> = {
  darwin: ['applescript', 'shell'],
  linux: ['shell'],
  win32: ['powershell'],
}

export type { ComputerUseSettings } from '@shared/lib/computer-use/types'

export type AnalyticsTargetType = 'amplitude' | 'google-analytics' | 'mixpanel'

export interface AnalyticsTarget {
  type: AnalyticsTargetType
  config: Record<string, string>
  enabled: boolean
}

export type { LlmProviderId } from '../llm-provider/base-llm-provider'
import type { LlmProviderId } from '../llm-provider/base-llm-provider'
export type { WebProviderId } from '../web-provider/types'
import type { WebProviderId } from '../web-provider/types'

export interface PlatformAuthSettings {
  token: string
  tokenPreview: string
  email: string | null
  label: string | null
  orgId: string | null
  orgName: string | null
  role: string | null
  /** Global platform user identity (Supabase auth UUID) — used for analytics. */
  userId: string | null
  /** Per-org membership id (sub_…) — used for request attribution. */
  memberId: string | null
  createdAt: string
  updatedAt: string
}

export interface AppSettings {
  container: ContainerSettings
  apiKeys?: ApiKeySettings
  llmProvider?: LlmProviderId
  webProvider?: WebProviderId // unset = Platform when Gamut login present, else native. A stored pin is sticky (no silent fallback). One vendor backs both search + fetch.
  webAllowedSites?: string[] // operator allow list; empty = allow all (host-side must-enforce, §8)
  webBlockedSites?: string[] // operator deny list; wins over allow
  app?: AppPreferences
  models?: ModelSettings
  modelCatalog?: ModelCatalogSettings
  agentLimits?: AgentLimitsSettings
  customEnvVars?: Record<string, string>
  skillsets?: SkillsetConfig[]
  auth?: AuthSettings
  voice?: VoiceSettings
  computerUse?: ComputerUseSettings
  shareAnalytics?: boolean
  analyticsTargets?: AnalyticsTarget[]
  shareErrorReports?: boolean
  platformAuth?: PlatformAuthSettings
  /**
   * Desktop platform-notifications state: the OS-notification dedup watermark
   * (newest created_at already OS-notified). Content is never mirrored locally
   * — the inbox reads live from the platform.
   */
  platformNotifications?: PlatformNotificationsSettings
  /** Anthropic SDK tool search — defaults on; passed as `ENABLE_TOOL_SEARCH` to the container. */
  enableToolSearch?: boolean
  /** Launch policies for subagents (Task/Agent) and workflows (Workflow tool). */
  agentCapabilities?: AgentCapabilitySettings
}

export interface PlatformNotificationsSettings {
  lastNotifiedAt?: string
}

// API key source types
export type ApiKeySource = 'env' | 'settings' | 'none'

export interface ApiKeyStatus {
  isConfigured: boolean
  source: ApiKeySource
}

// Import types for GlobalSettingsResponse
// Note: This creates a type-only dependency, avoiding circular imports
import type { RunnerAvailability } from '@shared/lib/container/client-factory'
import type { RuntimeReadiness } from '@shared/lib/container/types'
import type { ChromeProfile } from '@shared/lib/browser/chrome-profile'
// Canonical provider-info type (catalog + defaultModels) lives with the
// provider layer; import it (type-only, no runtime cycle) so the two never drift.
import type { LlmProviderInfo } from '../llm-provider'

export interface HostBrowserProviderInfo {
  id: string
  name: string
  available: boolean
  reason?: string
  profiles?: ChromeProfile[]
}

export interface HostBrowserStatus {
  providers: HostBrowserProviderInfo[]
}

export type { LlmProviderInfo }

export interface GlobalSettingsResponse {
  dataDir: string
  /** Host machine's total physical memory — lets the UI warn about oversized VM memory picks. */
  hostTotalMemoryBytes?: number
  container: ContainerSettings
  app: AppPreferences
  hasRunningAgents: boolean
  runnerAvailability: RunnerAvailability[]
  llmProvider: LlmProviderId
  llmProviderStatus: LlmProviderInfo[]
  modelCatalog?: ModelCatalogSettings
  // Raw stored id: undefined = unset. `effectiveWebProvider` is the vendor the agent will actually
  // use (the pin when set; Platform-if-login / native when unset). The UI pre-selects it and marks
  // unset as "(default)"; the model-picker web-tools warning reads it.
  webProvider?: WebProviderId
  effectiveWebProvider: WebProviderId
  apiKeyStatus: {
    anthropic: ApiKeyStatus
    openrouter: ApiKeyStatus
    bedrock: ApiKeyStatus
    platform: ApiKeyStatus
    generic: ApiKeyStatus
    composio: ApiKeyStatus
    nango: ApiKeyStatus
    browserbase: ApiKeyStatus
    deepgram: ApiKeyStatus
    openai: ApiKeyStatus
    exa: ApiKeyStatus
  }
  composioUserId?: string
  /** Saved generic-provider endpoint. Not a secret — echoed so the Settings UI can display/edit it. */
  genericBaseUrl?: string
  accountProviderUserId?: string
  voice?: VoiceSettings
  models: ModelSettings
  agentLimits: AgentLimitsSettings
  customEnvVars: Record<string, string>
  setupCompleted: boolean
  hostBrowserStatus?: HostBrowserStatus
  runtimeReadiness: RuntimeReadiness
  auth?: AuthSettings
  tenantId: string
  computerUse?: ComputerUseSettings
  shareAnalytics: boolean
  analyticsTargets?: AnalyticsTarget[]
  shareErrorReports: boolean
  enableToolSearch: boolean
  agentCapabilities: AgentCapabilitySettings
}

/**
 * Default container runner: Lima on macOS (bundled, no install needed),
 * WSL2 on Windows (bundled, no install needed), Docker elsewhere.
 */
function getDefaultContainerRunner(): string {
  if (isRunningInKubernetes()) return 'kubernetes'
  const p = os.platform()
  if (p === 'darwin') return 'lima'
  if (p === 'win32') return 'wsl2'
  return 'docker'
}

const DEFAULT_SETTINGS: AppSettings = {
  container: {
    containerRunner: getDefaultContainerRunner(),
    agentImage: getDefaultAgentImage(),
    resourceLimits: {
      cpu: 2,
      memory: '4g',
    },
    runtimeSettings: {},
  },
  app: {
    showMenuBarIcon: true,
    autoSleepTimeoutMinutes: 30,
    globalDispatchShortcut: DEFAULT_GLOBAL_DISPATCH_SHORTCUT,
    notifications: {
      enabled: true,
      sessionComplete: true,
      sessionWaiting: true,
      sessionScheduled: true,
    },
  },
  models: {
    // Bare family aliases so fresh installs track each family's latest version.
    // The host resolver maps these to a concrete id per active provider.
    summarizerModel: 'haiku',
    agentModel: 'opus',
    browserModel: 'sonnet',
    // Dashboard-builder subagent — a capable tier by default (overridable).
    dashboardBuilderModel: 'opus',
    agentEffort: 'medium',
  },
  enableToolSearch: true,
  agentCapabilities: DEFAULT_AGENT_CAPABILITIES,
  skillsets: [DEFAULT_PUBLIC_SKILLSET],
}

function getSettingsPath(): string {
  return path.join(getDataDir(), 'settings.json')
}

function parseModelCatalogSettings(value: unknown): ModelCatalogSettings | undefined {
  if (value === undefined) return undefined
  const parsed = modelCatalogSettingsSchema.safeParse(value)
  if (!parsed.success) {
    console.warn('Invalid modelCatalog in settings.json; ignoring model catalog overrides:', parsed.error.message)
    return undefined
  }
  return parsed.data
}

/**
 * Load settings from the JSON file.
 * Returns default settings if file doesn't exist.
 */
/**
 * Pre-SUP-275 stored model defaults. Back then the three `models.*` fields were
 * persisted as these concrete ids and version pinning did not exist (the UI
 * version was cosmetic — selections collapsed to a bare alias before hitting the
 * SDK). So any of these on disk is a stale default, never an intentional pin:
 * rewrite it to the bare family alias so it resolves per active provider (a
 * bare-Claude id like 'claude-opus-4-8' has no Bedrock catalog entry and would
 * otherwise pass straight through to the Bedrock SDK and fail) and rides
 * upgrades. Post-275 pins to older versions survive (their ids aren't in this
 * map); a deliberate pin to the current latest normalizes to its family alias —
 * behaviorally identical until the next release in that family ships.
 */
const LEGACY_MODEL_DEFAULTS: Record<string, string> = {
  'claude-opus-4-8': 'opus',
  'claude-sonnet-4-6': 'sonnet',
  'claude-haiku-4-5': 'haiku',
}

function migrateLegacyModelDefault<T extends string | undefined>(value: T): T {
  return (value !== undefined ? (LEGACY_MODEL_DEFAULTS[value] ?? value) : value) as T
}

/**
 * Merge a raw, JSON-parsed settings object onto the defaults. Pure: no IO.
 * Tolerant of missing/partial fields (each is defaulted) — this is where the
 * permissive shape handling lives, so the strict reader can keep its boundary
 * check minimal.
 */
function mergeLoadedSettings(loaded: Record<string, any>): AppSettings {
  // Migrate agent image tag: if the saved image uses the default GHCR registry
  // with a :main or :semver tag, update it to the current version's default.
  // This ensures upgrades automatically pull the matching agent container.
  let agentImage = loaded.container?.agentImage
  if (agentImage && agentImage.startsWith(AGENT_IMAGE_REGISTRY + ':')) {
    const savedTag = agentImage.split(':').pop()
    if (savedTag === 'main' || /^\d+\.\d+\.\d+/.test(savedTag!)) {
      agentImage = getDefaultAgentImage()
    }
  }
  const modelCatalog = parseModelCatalogSettings(loaded.modelCatalog)

  // Merge with defaults to ensure all fields exist
  return {
    container: {
      ...DEFAULT_SETTINGS.container,
      ...loaded.container,
      ...(agentImage && { agentImage }),
      resourceLimits: {
        ...DEFAULT_SETTINGS.container.resourceLimits,
        ...loaded.container?.resourceLimits,
      },
      // Ensure runtimeSettings exists (may be missing in old settings files)
      runtimeSettings: loaded.container?.runtimeSettings ?? {},
    },
    app: {
      ...DEFAULT_SETTINGS.app,
      ...loaded.app,
      notifications: {
        ...DEFAULT_SETTINGS.app?.notifications,
        ...loaded.app?.notifications,
      },
    },
    apiKeys: loaded.apiKeys,
    llmProvider: loaded.llmProvider,
    // Recover a pre-collapse selection: webSearchProvider shipped (v0.4.5-0.4.7) and the single
    // UI select wrote both old fields to the same value, so the legacy webSearchProvider is the
    // user's choice. Read-fallback (not a boot-time migration) keeps this merge pure; the next
    // PUT /settings persists it under webProvider and the stale key lingers harmlessly. An invalid
    // stored value fails the factory's isVendorId narrow and resolves to the automatic default
    // (which may be a vendor, not native).
    webProvider: loaded.webProvider ?? loaded.webSearchProvider,
    webAllowedSites: loaded.webAllowedSites,
    webBlockedSites: loaded.webBlockedSites,
    models: (() => {
      const merged = { ...DEFAULT_SETTINGS.models!, ...loaded.models }
      // One-time normalization of legacy concrete defaults → bare aliases.
      return {
        ...merged,
        summarizerModel: migrateLegacyModelDefault(merged.summarizerModel),
        agentModel: migrateLegacyModelDefault(merged.agentModel),
        browserModel: migrateLegacyModelDefault(merged.browserModel),
        dashboardBuilderModel: migrateLegacyModelDefault(merged.dashboardBuilderModel),
      }
    })(),
    modelCatalog,
    agentLimits: loaded.agentLimits,
    customEnvVars: loaded.customEnvVars,
    // Deep-clone the default when defaulting: callers mutate `s.skillsets` in
    // place (e.g. sync-remote's `current.push(config)`), and returning the shared
    // DEFAULT_SETTINGS.skillsets reference would poison the module constant for a
    // settings.json that merely omits `skillsets`.
    skillsets: loaded.skillsets !== undefined
      ? loaded.skillsets
      : structuredClone(DEFAULT_SETTINGS.skillsets),
    auth: {
      ...DEFAULT_AUTH_SETTINGS,
      ...loaded.auth,
    },
    voice: loaded.voice,
    computerUse: loaded.computerUse,
    shareAnalytics: loaded.shareAnalytics ?? true,
    analyticsTargets: loaded.analyticsTargets,
    shareErrorReports: loaded.shareErrorReports,
    platformAuth: loaded.platformAuth,
    platformNotifications: loaded.platformNotifications,
    enableToolSearch: loaded.enableToolSearch ?? DEFAULT_SETTINGS.enableToolSearch,
    // Sanitize per-field: an unknown tier (hand-edited file, future version)
    // falls back to that field's default instead of poisoning the section —
    // resetting the whole section would silently lift a valid 'block'.
    agentCapabilities: (() => {
      const out = structuredClone(DEFAULT_AGENT_CAPABILITIES)
      for (const key of Object.keys(out) as (keyof AgentCapabilitySettings)[]) {
        const raw = loaded.agentCapabilities?.[key]
        if (raw === undefined) continue
        const parsed = capabilityPolicySchema.safeParse(raw)
        if (parsed.success) out[key] = parsed.data
        else console.warn(`Invalid agentCapabilities.${key} in settings.json; using default:`, raw)
      }
      return out
    })(),
  }
}

/**
 * Strict, fail-closed load. Reads fresh from disk (bypassing
 * the cache) and:
 *   - absent file (ENOENT) → defaults (legitimate first run),
 *   - torn/corrupt JSON or a non-object → THROWS CorruptFileError,
 *   - other IO errors → propagate.
 *
 * This is what every WRITE path re-reads under, so a momentarily unreadable
 * `settings.json` aborts the write instead of being silently replaced by
 * defaults (which would permanently wipe API keys, auth policy, skillsets, …).
 * Never default-then-save here.
 */
export function loadSettingsStrict(): AppSettings {
  const settingsPath = getSettingsPath()
  let content: string
  try {
    content = fs.readFileSync(settingsPath, 'utf-8')
  } catch (err) {
    // Absent file = legitimate first run → bare defaults (preserves the original
    // behavior, which did NOT default-merge auth/analytics for a missing file).
    // Deep-clone: callers (mutateSettings) mutate nested objects in place, and a
    // shallow `{ ...DEFAULT_SETTINGS }` shares `.container`/`.app`/… with the
    // module constant — so a first-run mutation would corrupt DEFAULT_SETTINGS.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return structuredClone(DEFAULT_SETTINGS)
    throw err // other IO error (EACCES/EIO/…) — propagate, never default-then-save
  }
  // Validate the boundary (object shape); torn JSON / non-object → throw.
  const raw = parseJsonStrict(settingsPath, content)
  return mergeLoadedSettings(raw)
}

/** Parse + shape-validate raw settings content; throws CorruptFileError on a
 *  torn file or a non-object value. */
function parseJsonStrict(settingsPath: string, content: string): Record<string, any> {
  let loaded: unknown
  try {
    loaded = JSON.parse(content)
  } catch (err) {
    throw new CorruptFileError(settingsPath, 'settings.json is not valid JSON', { cause: err })
  }
  const validated = persistedSettingsSchema.safeParse(loaded)
  if (!validated.success) {
    throw new CorruptFileError(
      settingsPath,
      `settings.json is not a JSON object: ${validated.error.message}`,
      { cause: validated.error }
    )
  }
  return validated.data as Record<string, any>
}

/**
 * Load settings for READ-ONLY consumers (display, getters). Tolerant: never
 * throws, so a corrupt file degrades to in-memory defaults rather than crashing
 * the app — but it NEVER writes those defaults back (the data-loss
 * amplification). Writes go through {@link mutateSettings}/{@link loadSettingsStrict},
 * which re-throw on corruption, so defaults surfaced here can't overwrite a real
 * but temporarily-unreadable file.
 */
export function loadSettings(): AppSettings {
  try {
    return loadSettingsStrict()
  } catch (error) {
    console.error('Failed to load settings; using in-memory defaults (NOT overwriting the file):', error)
    if (error instanceof CorruptFileError) {
      captureException(error, { tags: { area: 'settings', op: 'load' } })
    }
    // Deep-clone so a caller mutating a nested field can't pollute the module
    // constant (see loadSettingsStrict).
    return structuredClone(DEFAULT_SETTINGS)
  }
}

/**
 * Save settings to the JSON file.
 */
export function saveSettings(settings: AppSettings): void {
  const settingsPath = getSettingsPath()
  const dataDir = getDataDir()

  // Ensure data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  // Atomic temp-file + rename: an interrupted write can never leave a
  // torn settings.json that a later read would mistake for corruption (or that
  // the tolerant loader would mask with defaults). Mode 0o600 (owner-only) since
  // the file holds API keys.
  writeFileAtomicSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 })
}

/**
 * Get current settings (cached for the request).
 */
let cachedSettings: AppSettings | null = null

export function getSettings(): AppSettings {
  if (!cachedSettings) {
    cachedSettings = loadSettings()
  }
  return cachedSettings
}

/**
 * Replace the whole settings object and refresh the cache.
 *
 * Prefer {@link mutateSettings} for partial updates — it re-reads fresh from
 * disk so it can't lose a concurrent writer's change. Use this only when the
 * caller has already merged against a FRESH (strict) read with no `await`
 * between the read and here (so nothing could interleave), e.g. the settings
 * PUT route. The write itself is atomic.
 */
export function updateSettings(settings: AppSettings): void {
  saveSettings(settings)
  cachedSettings = settings
}

/**
 * Serialized, fail-closed read-modify-write of settings.
 *
 * Synchronous on purpose: with no `await` between the fresh strict read and the
 * atomic write, concurrent callers cannot interleave, so this serializes for
 * free and closes the lost-update race across the many background settings
 * writers (runtime auto-switch, token refresh, permission grants, skillset
 * reconcile, …). It re-reads FRESH from disk every call — never the possibly
 * stale/defaulted cache — and {@link loadSettingsStrict} THROWS on a corrupt
 * file, so a torn settings.json aborts the mutation instead of clobbering real
 * API keys/auth with defaults. Returns the persisted settings.
 */
export function mutateSettings(mutator: (settings: AppSettings) => void): AppSettings {
  const fresh = loadSettingsStrict()
  mutator(fresh)
  saveSettings(fresh)
  cachedSettings = fresh
  return fresh
}

/**
 * Clear the settings cache (useful after external modifications).
 */
export function clearSettingsCache(): void {
  cachedSettings = null
}

// TODO - following function are very repetitive - consider refactor to a single generic function that takes the API key name as parameter

/**
 * Get the status of the Anthropic API key configuration.
 * Saved settings take precedence over environment variable.
 */
export function getAnthropicApiKeyStatus(): ApiKeyStatus {
  const settings = getSettings()
  if (settings.apiKeys?.anthropicApiKey) {
    return { isConfigured: true, source: 'settings' }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { isConfigured: true, source: 'env' }
  }
  return { isConfigured: false, source: 'none' }
}

/**
 * Get the effective Anthropic API key to use.
 * Saved settings take precedence over environment variable.
 */
export function getEffectiveAnthropicApiKey(): string | undefined {
  const settings = getSettings()
  // Saved settings take precedence
  if (settings.apiKeys?.anthropicApiKey) {
    return settings.apiKeys.anthropicApiKey
  }
  // Fall back to environment variable
  return process.env.ANTHROPIC_API_KEY
}

/**
 * Get the status of the Composio API key configuration.
 */
export function getComposioApiKeyStatus(): ApiKeyStatus {
  const settings = getSettings()
  if (settings.apiKeys?.composioApiKey) {
    return { isConfigured: true, source: 'settings' }
  }
  if (process.env.COMPOSIO_API_KEY) {
    return { isConfigured: true, source: 'env' }
  }
  return { isConfigured: false, source: 'none' }
}

/**
 * Get the effective Composio API key to use.
 * Saved settings take precedence over environment variable.
 */
export function getEffectiveComposioApiKey(): string | undefined {
  const settings = getSettings()
  if (settings.apiKeys?.composioApiKey) {
    return settings.apiKeys.composioApiKey
  }
  return process.env.COMPOSIO_API_KEY
}

/**
 * Get the Composio user ID.
 * Saved settings take precedence over environment variable.
 */
export function getComposioUserId(): string | undefined {
  const settings = getSettings()
  if (settings.apiKeys?.composioUserId) {
    return settings.apiKeys.composioUserId
  }
  return process.env.COMPOSIO_USER_ID
}

export function getNangoApiKeyStatus(): ApiKeyStatus {
  const settings = getSettings()
  if (settings.apiKeys?.nangoSecretKey) {
    return { isConfigured: true, source: 'settings' }
  }
  if (process.env.NANGO_SECRET_KEY) {
    return { isConfigured: true, source: 'env' }
  }
  return { isConfigured: false, source: 'none' }
}

export function getNangoSecretKey(): string | undefined {
  const settings = getSettings()
  if (settings.apiKeys?.nangoSecretKey) {
    return settings.apiKeys.nangoSecretKey
  }
  return process.env.NANGO_SECRET_KEY
}

export function getAccountProviderUserId(): string | undefined {
  const settings = getSettings()
  if (settings.apiKeys?.accountProviderUserId) {
    return settings.apiKeys.accountProviderUserId
  }
  return getComposioUserId()
}

export function getDefaultAccountProviderType(): AccountProviderType {
  const settings = getSettings()
  return settings.app?.accountProvider ?? 'composio'
}

/**
 * Get the status of the Browserbase API key configuration.
 */
export function getBrowserbaseApiKeyStatus(): ApiKeyStatus {
  const settings = getSettings()
  if (settings.apiKeys?.browserbaseApiKey) {
    return { isConfigured: true, source: 'settings' }
  }
  if (process.env.BROWSERBASE_API_KEY) {
    return { isConfigured: true, source: 'env' }
  }
  return { isConfigured: false, source: 'none' }
}

/**
 * Get the effective Browserbase API key to use.
 * Saved settings take precedence over environment variable.
 */
export function getEffectiveBrowserbaseApiKey(): string | undefined {
  const settings = getSettings()
  if (settings.apiKeys?.browserbaseApiKey) {
    return settings.apiKeys.browserbaseApiKey
  }
  return process.env.BROWSERBASE_API_KEY
}

/**
 * Get the effective Browserbase project ID to use.
 * Saved settings take precedence over environment variable.
 */
export function getEffectiveBrowserbaseProjectId(): string | undefined {
  const settings = getSettings()
  if (settings.apiKeys?.browserbaseProjectId) {
    return settings.apiKeys.browserbaseProjectId
  }
  return process.env.BROWSERBASE_PROJECT_ID
}

/**
 * Get the effective model settings, with defaults applied.
 */
export function getEffectiveModels(): ModelSettings {
  const settings = getSettings()
  return {
    summarizerModel: settings.models?.summarizerModel || DEFAULT_SETTINGS.models!.summarizerModel,
    agentModel: settings.models?.agentModel || DEFAULT_SETTINGS.models!.agentModel,
    browserModel: settings.models?.browserModel || DEFAULT_SETTINGS.models!.browserModel,
    dashboardBuilderModel: settings.models?.dashboardBuilderModel || DEFAULT_SETTINGS.models!.dashboardBuilderModel,
    agentEffort: settings.models?.agentEffort || DEFAULT_SETTINGS.models!.agentEffort,
  }
}

/**
 * Get the effective agent limits settings.
 */
export function getEffectiveAgentLimits(): AgentLimitsSettings {
  const settings = getSettings()
  return settings.agentLimits ?? {}
}

export function getModelCatalogSettings(): ModelCatalogSettings {
  const settings = getSettings()
  return settings.modelCatalog ?? {}
}

/**
 * Get custom environment variables for agent containers.
 */
export function getCustomEnvVars(): Record<string, string> {
  const settings = getSettings()
  return settings.customEnvVars ?? {}
}

export function getVoiceSettings(): VoiceSettings {
  const settings = getSettings()
  return settings.voice ?? {}
}

/** Resolved launch policies for subagents/workflows (defaults applied). */
export function getAgentCapabilitySettings(): AgentCapabilitySettings {
  const settings = getSettings()
  return settings.agentCapabilities ?? DEFAULT_AGENT_CAPABILITIES
}

export { DEFAULT_SETTINGS }
