import fs from 'fs'
import path from 'path'
import { getDataDir } from './data-dir'
import { getDefaultAgentImage, AGENT_IMAGE_REGISTRY } from './version'

export interface ContainerSettings {
  containerRunner: string
  agentImage: string
  resourceLimits: {
    cpu: number
    memory: string
  }
}

export interface ApiKeySettings {
  anthropicApiKey?: string
  composioApiKey?: string
  composioUserId?: string
}

export interface NotificationSettings {
  enabled: boolean
  sessionComplete: boolean
  sessionWaiting: boolean
  sessionScheduled: boolean
}

export interface ModelSettings {
  summarizerModel: string
  agentModel: string
}

export interface AppPreferences {
  showMenuBarIcon?: boolean
  notifications?: NotificationSettings
  autoSleepTimeoutMinutes?: number
  setupCompleted?: boolean
  useHostBrowser?: boolean
  chromeProfileId?: string
  allowPrereleaseUpdates?: boolean
  theme?: 'system' | 'light' | 'dark'
}

export interface AppSettings {
  container: ContainerSettings
  apiKeys?: ApiKeySettings
  app?: AppPreferences
  models?: ModelSettings
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

export interface HostBrowserStatus {
  available: boolean
  browser: string | null
  path: string | null
  profiles?: Array<{ id: string; name: string }>
}

export interface GlobalSettingsResponse {
  dataDir: string
  container: ContainerSettings
  app: AppPreferences
  hasRunningAgents: boolean
  runnerAvailability: RunnerAvailability[]
  apiKeyStatus: {
    anthropic: ApiKeyStatus
    composio: ApiKeyStatus
  }
  composioUserId?: string
  models: ModelSettings
  setupCompleted: boolean
  hostBrowserStatus?: HostBrowserStatus
  runtimeReadiness: RuntimeReadiness
}

const DEFAULT_SETTINGS: AppSettings = {
  container: {
    containerRunner: 'docker',
    agentImage: getDefaultAgentImage(),
    resourceLimits: {
      cpu: 1,
      memory: '512m',
    },
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
    summarizerModel: 'claude-haiku-4-5',
    agentModel: 'claude-opus-4-5',
  },
}

function getSettingsPath(): string {
  return path.join(getDataDir(), 'settings.json')
}

/**
 * Load settings from the JSON file.
 * Returns default settings if file doesn't exist.
 */
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
        models: {
          ...DEFAULT_SETTINGS.models,
          ...loaded.models,
        },
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

/**
 * Get the effective model settings, with defaults applied.
 */
export function getEffectiveModels(): ModelSettings {
  const settings = getSettings()
  return {
    summarizerModel: settings.models?.summarizerModel || DEFAULT_SETTINGS.models!.summarizerModel,
    agentModel: settings.models?.agentModel || DEFAULT_SETTINGS.models!.agentModel,
  }
}

export { DEFAULT_SETTINGS }
