import fs from 'fs'
import path from 'path'
import { getDataDir } from './data-dir'

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
}

export interface AppSettings {
  container: ContainerSettings
  apiKeys?: ApiKeySettings
}

// API key source types
export type ApiKeySource = 'env' | 'settings' | 'none'

export interface ApiKeyStatus {
  isConfigured: boolean
  source: ApiKeySource
}

const DEFAULT_SETTINGS: AppSettings = {
  container: {
    containerRunner: 'docker',
    agentImage: 'superagent-container:latest',
    resourceLimits: {
      cpu: 1,
      memory: '512m',
    },
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
      // Merge with defaults to ensure all fields exist
      return {
        container: {
          ...DEFAULT_SETTINGS.container,
          ...loaded.container,
          resourceLimits: {
            ...DEFAULT_SETTINGS.container.resourceLimits,
            ...loaded.container?.resourceLimits,
          },
        },
        apiKeys: loaded.apiKeys,
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

export { DEFAULT_SETTINGS }
