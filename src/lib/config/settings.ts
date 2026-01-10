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

export interface AppSettings {
  container: ContainerSettings
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

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
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

export { DEFAULT_SETTINGS }
