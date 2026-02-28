import { Hono } from 'hono'
import Anthropic from '@anthropic-ai/sdk'
import { getDataDir, getAgentsDataDir } from '@shared/lib/config/data-dir'
import { Authenticated, IsAdmin } from '../middleware/auth'
import {
  getSettings,
  updateSettings,
  clearSettingsCache,
  getAnthropicApiKeyStatus,
  getComposioApiKeyStatus,
  getComposioUserId,
  getEffectiveModels,
  getEffectiveAgentLimits,
  getCustomEnvVars,
  type AppSettings,
  type ContainerSettings,
  type GlobalSettingsResponse,
} from '@shared/lib/config/settings'
import { containerManager } from '@shared/lib/container/container-manager'
import { checkAllRunnersAvailability, refreshRunnerAvailability, startRunner, SUPPORTED_RUNNERS, type ContainerRunner } from '@shared/lib/container/client-factory'
import { detectAllProviders } from '../../main/host-browser'
import { db } from '@shared/lib/db'
import { proxyAuditLog, proxyTokens, agentConnectedAccounts, scheduledTasks, notifications, connectedAccounts } from '@shared/lib/db/schema'
import fs from 'fs'

const settings = new Hono()

settings.use('*', Authenticated(), IsAdmin())

// GET /api/settings - Get global settings
settings.get('/', async (c) => {
  try {
    const currentSettings = getSettings()
    // hasRunningAgents uses cached status (no docker process spawned)
    const hasRunningAgents = containerManager.hasRunningAgents()
    // checkAllRunnersAvailability still spawns docker commands, but only on explicit request
    const runnerAvailability = await checkAllRunnersAvailability()

    const response: GlobalSettingsResponse = {
      dataDir: getDataDir(),
      container: currentSettings.container,
      app: currentSettings.app || { showMenuBarIcon: true },
      hasRunningAgents,
      runnerAvailability,
      apiKeyStatus: {
        anthropic: getAnthropicApiKeyStatus(),
        composio: getComposioApiKeyStatus(),
      },
      models: getEffectiveModels(),
      agentLimits: getEffectiveAgentLimits(),
      customEnvVars: getCustomEnvVars(),
      composioUserId: getComposioUserId(),
      setupCompleted: !!currentSettings.app?.setupCompleted,
      hostBrowserStatus: { providers: detectAllProviders() },
      runtimeReadiness: containerManager.getReadiness(),
      auth: currentSettings.auth,
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
    // hasRunningAgents uses cached status (no docker process spawned)
    const hasRunningAgents = containerManager.hasRunningAgents()

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
      app: {
        ...currentSettings.app,
        ...body.app,
      },
      apiKeys: currentSettings.apiKeys,
      models: body.models
        ? {
            ...currentSettings.models,
            ...body.models,
          }
        : currentSettings.models,
      agentLimits: body.agentLimits !== undefined
        ? {
            ...currentSettings.agentLimits,
            ...body.agentLimits,
          }
        : currentSettings.agentLimits,
      customEnvVars: body.customEnvVars !== undefined
        ? body.customEnvVars
        : currentSettings.customEnvVars,
      skillsets: currentSettings.skillsets,
      auth: body.auth !== undefined
        ? { ...currentSettings.auth, ...body.auth }
        : currentSettings.auth,
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

      // Handle Browserbase API key
      if (body.apiKeys.browserbaseApiKey === '') {
        newSettings.apiKeys = { ...newSettings.apiKeys }
        delete newSettings.apiKeys.browserbaseApiKey
      } else if (body.apiKeys.browserbaseApiKey) {
        newSettings.apiKeys = {
          ...newSettings.apiKeys,
          browserbaseApiKey: body.apiKeys.browserbaseApiKey,
        }
      }

      // Handle Browserbase Project ID
      if (body.apiKeys.browserbaseProjectId === '') {
        newSettings.apiKeys = { ...newSettings.apiKeys }
        delete newSettings.apiKeys.browserbaseProjectId
      } else if (body.apiKeys.browserbaseProjectId) {
        newSettings.apiKeys = {
          ...newSettings.apiKeys,
          browserbaseProjectId: body.apiKeys.browserbaseProjectId,
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

    // If container runner changed, clear cached clients so new ones use the updated runner
    if (
      newSettings.container.containerRunner !==
      currentSettings.container.containerRunner
    ) {
      containerManager.clearClients()
    }

    // If image or runner changed, re-check readiness (may need to pull new image)
    if (
      newSettings.container.agentImage !== currentSettings.container.agentImage ||
      newSettings.container.containerRunner !== currentSettings.container.containerRunner
    ) {
      containerManager.ensureImageReady().catch((error) => {
        console.error('Failed to re-check image readiness:', error)
      })
    }

    const runnerAvailability = await checkAllRunnersAvailability()

    return c.json({
      dataDir: getDataDir(),
      container: newSettings.container,
      app: newSettings.app || { showMenuBarIcon: true },
      hasRunningAgents,
      runnerAvailability,
      apiKeyStatus: {
        anthropic: getAnthropicApiKeyStatus(),
        composio: getComposioApiKeyStatus(),
      },
      models: getEffectiveModels(),
      agentLimits: getEffectiveAgentLimits(),
      customEnvVars: getCustomEnvVars(),
      composioUserId: getComposioUserId(),
      setupCompleted: !!newSettings.app?.setupCompleted,
      hostBrowserStatus: { providers: detectAllProviders() },
      runtimeReadiness: containerManager.getReadiness(),
      auth: newSettings.auth,
    })
  } catch (error) {
    console.error('Failed to update settings:', error)
    return c.json({ error: 'Failed to update settings' }, 500)
  }
})

// POST /api/settings/start-runner - Start a container runtime
settings.post('/start-runner', async (c) => {
  try {
    const body = await c.req.json()
    const runner = body.runner as ContainerRunner

    if (!runner || !SUPPORTED_RUNNERS.includes(runner)) {
      return c.json({ error: `Invalid runner. Must be one of: ${SUPPORTED_RUNNERS.join(', ')}` }, 400)
    }

    const result = await startRunner(runner)

    if (result.success) {
      // Wait a bit for the runtime to start, then refresh availability (clears cache first)
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const runnerAvailability = await refreshRunnerAvailability()

      // Re-check image readiness now that a runner is available
      containerManager.ensureImageReady().catch((error) => {
        console.error('Failed to check image after starting runner:', error)
      })

      return c.json({
        ...result,
        runnerAvailability,
      })
    }

    return c.json(result, 400)
  } catch (error) {
    console.error('Failed to start runner:', error)
    return c.json({ error: 'Failed to start runner' }, 500)
  }
})

// POST /api/settings/refresh-availability - Force-refresh runner availability (clears cache)
settings.post('/refresh-availability', async (c) => {
  try {
    const runnerAvailability = await refreshRunnerAvailability()
    // Also re-check image readiness since runner state may have changed
    containerManager.ensureImageReady().catch((error) => {
      console.error('Failed to re-check image readiness:', error)
    })
    return c.json({ runnerAvailability })
  } catch (error) {
    console.error('Failed to refresh runner availability:', error)
    return c.json({ error: 'Failed to refresh runner availability' }, 500)
  }
})

// POST /api/settings/validate-anthropic-key - Validate an Anthropic API key
settings.post('/validate-anthropic-key', async (c) => {
  try {
    const { apiKey } = await c.req.json()
    if (!apiKey || typeof apiKey !== 'string') {
      return c.json({ valid: false, error: 'API key is required' }, 400)
    }

    const client = new Anthropic({ apiKey })
    const { summarizerModel } = getEffectiveModels()
    await client.messages.create({
      model: summarizerModel,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Hi' }],
    })

    return c.json({ valid: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Invalid API key'
    return c.json({ valid: false, error: message })
  }
})

// POST /api/settings/validate-browserbase - Validate Browserbase API key and project ID
settings.post('/validate-browserbase', async (c) => {
  try {
    const { apiKey, projectId } = await c.req.json()
    if (!apiKey || typeof apiKey !== 'string') {
      return c.json({ valid: false, error: 'API key is required' }, 400)
    }
    if (!projectId || typeof projectId !== 'string') {
      return c.json({ valid: false, error: 'Project ID is required' }, 400)
    }

    // Create a test session to validate credentials
    const response = await fetch('https://api.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BB-API-Key': apiKey,
      },
      body: JSON.stringify({ projectId }),
    })

    if (!response.ok) {
      const body = await response.text()
      if (response.status === 401 || response.status === 403) {
        return c.json({ valid: false, error: 'Invalid API key' })
      }
      if (response.status === 404 || response.status === 400) {
        return c.json({ valid: false, error: 'Invalid project ID' })
      }
      return c.json({ valid: false, error: `Browserbase error: ${response.status} ${body}` })
    }

    const session = await response.json() as { id: string }

    // Release the test session immediately
    await fetch(`https://api.browserbase.com/v1/sessions/${session.id}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BB-API-Key': apiKey,
      },
      body: JSON.stringify({ projectId, status: 'REQUEST_RELEASE' }),
    }).catch(() => {
      // Non-critical — session will timeout on its own
    })

    return c.json({ valid: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Validation failed'
    return c.json({ valid: false, error: message })
  }
})

// POST /api/settings/factory-reset - Reset all data
settings.post('/factory-reset', async (c) => {
  try {
    // Stop all running containers
    await containerManager.stopAll()

    // Delete agents directory
    const agentsDir = getAgentsDataDir()
    await fs.promises.rm(agentsDir, { recursive: true, force: true })

    // Clear all DB tables (order matters for FK constraints)
    db.delete(proxyAuditLog).run()
    db.delete(proxyTokens).run()
    db.delete(agentConnectedAccounts).run()
    db.delete(scheduledTasks).run()
    db.delete(notifications).run()
    db.delete(connectedAccounts).run()

    // Delete settings file
    const settingsPath = `${getDataDir()}/settings.json`
    await fs.promises.rm(settingsPath, { force: true })
    clearSettingsCache()

    return c.json({ success: true })
  } catch (error) {
    console.error('Factory reset failed:', error)
    return c.json({ error: 'Factory reset failed' }, 500)
  }
})

export default settings
