import { Hono } from 'hono'
import { getDataDir } from '@shared/lib/config/data-dir'
import {
  getSettings,
  updateSettings,
  getAnthropicApiKeyStatus,
  getComposioApiKeyStatus,
  getComposioUserId,
  type AppSettings,
  type ContainerSettings,
  type GlobalSettingsResponse,
} from '@shared/lib/config/settings'
import { containerManager } from '@shared/lib/container/container-manager'
import { checkAllRunnersAvailability } from '@shared/lib/container/client-factory'

const settings = new Hono()

// GET /api/settings - Get global settings
settings.get('/', async (c) => {
  try {
    const currentSettings = getSettings()
    const [hasRunningAgents, runnerAvailability] = await Promise.all([
      containerManager.hasRunningAgents(),
      checkAllRunnersAvailability(),
    ])

    const response: GlobalSettingsResponse = {
      dataDir: getDataDir(),
      container: currentSettings.container,
      hasRunningAgents,
      runnerAvailability,
      apiKeyStatus: {
        anthropic: getAnthropicApiKeyStatus(),
        composio: getComposioApiKeyStatus(),
      },
      composioUserId: getComposioUserId(),
    }

    return c.json(response)
  } catch (error) {
    console.error('Failed to fetch settings:', error)
    return c.json({ error: 'Failed to fetch settings' }, 500)
  }
})

// PUT /api/settings - Update settings
settings.put('/', async (c) => {
  try {
    const body = await c.req.json()
    const currentSettings = getSettings()
    const hasRunningAgents = await containerManager.hasRunningAgents()

    // Check if trying to change restricted settings while agents are running
    if (hasRunningAgents && body.container) {
      const newContainer = body.container as Partial<ContainerSettings>

      if (
        (newContainer.containerRunner !== undefined &&
          newContainer.containerRunner !==
            currentSettings.container.containerRunner) ||
        (newContainer.resourceLimits !== undefined &&
          JSON.stringify(newContainer.resourceLimits) !==
            JSON.stringify(currentSettings.container.resourceLimits))
      ) {
        return c.json(
          {
            error:
              'Cannot change container runner or resource limits while agents are running. Please stop all agents first.',
            runningAgents: await containerManager.getRunningAgentIds(),
          },
          409
        )
      }
    }

    // Merge new settings with current settings
    const newSettings: AppSettings = {
      container: {
        ...currentSettings.container,
        ...body.container,
        resourceLimits: body.container?.resourceLimits
          ? {
              ...currentSettings.container.resourceLimits,
              ...body.container.resourceLimits,
            }
          : currentSettings.container.resourceLimits,
      },
      apiKeys: currentSettings.apiKeys,
    }

    // Handle API key updates
    if (body.apiKeys !== undefined) {
      // Handle Anthropic API key
      if (body.apiKeys.anthropicApiKey === '') {
        newSettings.apiKeys = { ...newSettings.apiKeys }
        delete newSettings.apiKeys.anthropicApiKey
      } else if (body.apiKeys.anthropicApiKey) {
        newSettings.apiKeys = {
          ...newSettings.apiKeys,
          anthropicApiKey: body.apiKeys.anthropicApiKey,
        }
      }

      // Handle Composio API key
      if (body.apiKeys.composioApiKey === '') {
        newSettings.apiKeys = { ...newSettings.apiKeys }
        delete newSettings.apiKeys.composioApiKey
      } else if (body.apiKeys.composioApiKey) {
        newSettings.apiKeys = {
          ...newSettings.apiKeys,
          composioApiKey: body.apiKeys.composioApiKey,
        }
      }

      // Handle Composio User ID
      if (body.apiKeys.composioUserId === '') {
        newSettings.apiKeys = { ...newSettings.apiKeys }
        delete newSettings.apiKeys.composioUserId
      } else if (body.apiKeys.composioUserId) {
        newSettings.apiKeys = {
          ...newSettings.apiKeys,
          composioUserId: body.apiKeys.composioUserId,
        }
      }

      // Clean up empty object
      if (
        newSettings.apiKeys &&
        Object.keys(newSettings.apiKeys).length === 0
      ) {
        delete newSettings.apiKeys
      }
    }

    updateSettings(newSettings)

    const runnerAvailability = await checkAllRunnersAvailability()

    return c.json({
      dataDir: getDataDir(),
      container: newSettings.container,
      hasRunningAgents,
      runnerAvailability,
      apiKeyStatus: {
        anthropic: getAnthropicApiKeyStatus(),
        composio: getComposioApiKeyStatus(),
      },
      composioUserId: getComposioUserId(),
    })
  } catch (error) {
    console.error('Failed to update settings:', error)
    return c.json({ error: 'Failed to update settings' }, 500)
  }
})

export default settings
