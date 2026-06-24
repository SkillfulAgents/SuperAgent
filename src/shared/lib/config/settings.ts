import fs from 'fs'
import path from 'path'
import os from 'os'
import { getDataDir } from './data-dir'
import { isRunningInKubernetes } from '@shared/lib/container/runtime-env'
import { getDefaultAgentImage, AGENT_IMAGE_REGISTRY } from './version'
import type { SkillsetConfig } from '@shared/lib/types/skillset'
import { DEFAULT_PUBLIC_SKILLSET } from '@shared/lib/skillset-provider/default-public-skillset'
import type { ComputerUseSettings } from '@shared/lib/computer-use/types'
import type { EffortLevel } from '@shared/lib/container/types'
import {
  modelCatalogSettingsSchema,
  type ModelCatalogSettings,
} from '../llm-provider/model-catalog-schema'

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
  /** Anthropic SDK tool search — defaults on; passed as `ENABLE_TOOL_SEARCH` to the container. */
  enableToolSearch?: boolean
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
  container: ContainerSettings
  app: AppPreferences
  hasRunningAgents: boolean
  runnerAvailability: RunnerAvailability[]
  llmProvider: LlmProviderId
  llmProviderStatus: LlmProviderInfo[]
  modelCatalog?: ModelCatalogSettings
  apiKeyStatus: {
    anthropic: ApiKeyStatus
    openrouter: ApiKeyStatus
    bedrock: ApiKeyStatus
    platform: ApiKeyStatus
    composio: ApiKeyStatus
    nango: ApiKeyStatus
    browserbase: ApiKeyStatus
    deepgram: ApiKeyStatus
    openai: ApiKeyStatus
  }
  composioUserId?: string
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

export function loadSettings(): AppSettings {
  const settingsPath = getSettingsPath()

  try {
    if (fs.existsSync(settingsPath)) {
      const content = fs.readFileSync(settingsPath, 'utf-8')
      const loaded = JSON.parse(content)

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
        skillsets: loaded.skillsets !== undefined
          ? loaded.skillsets
          : DEFAULT_SETTINGS.skillsets,
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
        enableToolSearch: loaded.enableToolSearch ?? DEFAULT_SETTINGS.enableToolSearch,
      }
    }
  } catch (error) {
    console.error('Failed to load settings, using defaults:', error)
  }

  return { ...DEFAULT_SETTINGS }
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

  // Use mode 0o600 for security (owner read/write only) since file may contain API keys
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: 'utf-8', mode: 0o600 })
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
 * Update settings and clear cache.
 */
export function updateSettings(settings: AppSettings): void {
  saveSettings(settings)
  cachedSettings = settings
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

export { DEFAULT_SETTINGS }
