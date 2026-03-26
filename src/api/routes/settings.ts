import path from 'path'
import { Hono } from 'hono'
import { getLlmProvider, getAllProviderInfo } from '@shared/lib/llm-provider'
import type { BedrockLlmProvider } from '@shared/lib/llm-provider/bedrock-provider'
import { getDataDir, getAgentsDataDir } from '@shared/lib/config/data-dir'
import { Authenticated, IsAdmin } from '../middleware/auth'
import { isAuthMode } from '@shared/lib/auth/mode'
import {
  getSettings,
  updateSettings,
  clearSettingsCache,
  getBrowserbaseApiKeyStatus,
  getComposioApiKeyStatus,
  getComposioUserId,
  getVoiceSettings,
  getEffectiveModels,
  getEffectiveAgentLimits,
  getCustomEnvVars,
  type AppSettings,
  type ContainerSettings,
  type GlobalSettingsResponse,
} from '@shared/lib/config/settings'
import { getTenantId } from '@shared/lib/analytics/tenant-id'
import { getSttProvider } from '@shared/lib/stt'
import { containerManager } from '@shared/lib/container/container-manager'
import { checkAllRunnersAvailability, refreshRunnerAvailability, startRunner, restartRunner, SUPPORTED_RUNNERS, type ContainerRunner } from '@shared/lib/container/client-factory'
import { VALID_LIMA_VM_MEMORY_OPTIONS } from '@shared/lib/container/types'
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
      llmProvider: currentSettings.llmProvider ?? 'anthropic',
      llmProviderStatus: getAllProviderInfo(),
      apiKeyStatus: {
        anthropic: getLlmProvider('anthropic').getApiKeyStatus(),
        openrouter: getLlmProvider('openrouter').getApiKeyStatus(),
        bedrock: getLlmProvider('bedrock').getApiKeyStatus(),
        datawizz: getLlmProvider('datawizz').getApiKeyStatus(),
        browserbase: getBrowserbaseApiKeyStatus(),
        composio: getComposioApiKeyStatus(),
        deepgram: getSttProvider('deepgram').getApiKeyStatus(),
        openai: getSttProvider('openai').getApiKeyStatus(),
      },
      models: getEffectiveModels(),
      agentLimits: getEffectiveAgentLimits(),
      customEnvVars: getCustomEnvVars(),
      composioUserId: getComposioUserId(),
      setupCompleted: !!currentSettings.app?.setupCompleted,
      hostBrowserStatus: { providers: detectAllProviders() },
      runtimeReadiness: containerManager.getReadiness(),
      auth: currentSettings.auth,
      voice: getVoiceSettings(),
      tenantId: getTenantId(),
      hostShellUse: currentSettings.hostShellUse,
      shareAnalytics: !!currentSettings.shareAnalytics,
      analyticsTargets: currentSettings.analyticsTargets,
    }

    return c.json(response)
  } catch (error) {
    console.error('Failed to fetch settings:', error)
    return c.json({ error: 'Failed to fetch settings' }, 500)
  }
})

// PUT /api/settings - Update settings
// todo this is a disgusting function - rewrite!
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

    // Validate runtimeSettings if provided
    if (body.container?.runtimeSettings) {
      const limaSettings = body.container.runtimeSettings.lima
      if (limaSettings?.vmMemory && !VALID_LIMA_VM_MEMORY_OPTIONS.includes(limaSettings.vmMemory)) {
        return c.json({ error: `Invalid VM memory setting. Must be one of: ${VALID_LIMA_VM_MEMORY_OPTIONS.join(', ')}` }, 400)
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
        runtimeSettings: body.container?.runtimeSettings
          ? {
              ...currentSettings.container.runtimeSettings,
              ...body.container.runtimeSettings,
            }
          : currentSettings.container.runtimeSettings,
      },
      app: {
        ...currentSettings.app,
        ...body.app,
        // If hostBrowserProvider was explicitly set to null (meaning "use container"),
        // remove it from settings so consumers treat it as "no host provider"
        ...(body.app && 'hostBrowserProvider' in body.app && body.app.hostBrowserProvider == null
          ? { hostBrowserProvider: undefined }
          : {}),
      },
      apiKeys: currentSettings.apiKeys,
      llmProvider: body.llmProvider !== undefined
        ? body.llmProvider
        : currentSettings.llmProvider,
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
      platformAuth: currentSettings.platformAuth,
      auth: body.auth !== undefined
        ? { ...currentSettings.auth, ...body.auth }
        : currentSettings.auth,
      voice: body.voice !== undefined
        ? { ...currentSettings.voice, ...body.voice }
        : currentSettings.voice,
      shareAnalytics: body.shareAnalytics !== undefined
        ? body.shareAnalytics
        : currentSettings.shareAnalytics,
      hostShellUse: body.hostShellUse !== undefined
        ? { ...currentSettings.hostShellUse, ...body.hostShellUse }
        : currentSettings.hostShellUse,
      analyticsTargets: body.analyticsTargets !== undefined
        ? body.analyticsTargets
        : currentSettings.analyticsTargets,
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

      // Handle OpenRouter API key
      if (body.apiKeys.openrouterApiKey === '') {
        newSettings.apiKeys = { ...newSettings.apiKeys }
        delete newSettings.apiKeys.openrouterApiKey
      } else if (body.apiKeys.openrouterApiKey) {
        newSettings.apiKeys = {
          ...newSettings.apiKeys,
          openrouterApiKey: body.apiKeys.openrouterApiKey,
        }
      }

      // Handle Bedrock credentials
      for (const field of ['bedrockApiKey', 'bedrockAccessKeyId', 'bedrockSecretAccessKey', 'bedrockRegion'] as const) {
        if (body.apiKeys[field] === '') {
          newSettings.apiKeys = { ...newSettings.apiKeys }
          delete newSettings.apiKeys[field]
        } else if (body.apiKeys[field]) {
          newSettings.apiKeys = {
            ...newSettings.apiKeys,
            [field]: body.apiKeys[field],
          }
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

      // Handle Deepgram API key
      if (body.apiKeys.deepgramApiKey === '') {
        newSettings.apiKeys = { ...newSettings.apiKeys }
        delete newSettings.apiKeys.deepgramApiKey
      } else if (body.apiKeys.deepgramApiKey) {
        newSettings.apiKeys = {
          ...newSettings.apiKeys,
          deepgramApiKey: body.apiKeys.deepgramApiKey,
        }
      }

      // Handle OpenAI API key
      if (body.apiKeys.openaiApiKey === '') {
        newSettings.apiKeys = { ...newSettings.apiKeys }
        delete newSettings.apiKeys.openaiApiKey
      } else if (body.apiKeys.openaiApiKey) {
        newSettings.apiKeys = {
          ...newSettings.apiKeys,
          openaiApiKey: body.apiKeys.openaiApiKey,
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

    // If auth settings changed, reset the Better Auth singleton so it picks up new config
    if (body.auth !== undefined && isAuthMode()) {
      import('@shared/lib/auth/index').then(({ resetAuth }) => resetAuth()).catch(() => {})
    }

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
      llmProvider: newSettings.llmProvider ?? 'anthropic',
      llmProviderStatus: getAllProviderInfo(),
      apiKeyStatus: {
        anthropic: getLlmProvider('anthropic').getApiKeyStatus(),
        openrouter: getLlmProvider('openrouter').getApiKeyStatus(),
        bedrock: getLlmProvider('bedrock').getApiKeyStatus(),
        browserbase: getBrowserbaseApiKeyStatus(),
        composio: getComposioApiKeyStatus(),
        deepgram: getSttProvider('deepgram').getApiKeyStatus(),
        openai: getSttProvider('openai').getApiKeyStatus(),
      },
      models: getEffectiveModels(),
      agentLimits: getEffectiveAgentLimits(),
      customEnvVars: getCustomEnvVars(),
      composioUserId: getComposioUserId(),
      setupCompleted: !!newSettings.app?.setupCompleted,
      hostBrowserStatus: { providers: detectAllProviders() },
      runtimeReadiness: containerManager.getReadiness(),
      auth: newSettings.auth,
      voice: getVoiceSettings(),
      tenantId: getTenantId(),
      hostShellUse: newSettings.hostShellUse,
      shareAnalytics: !!newSettings.shareAnalytics,
      analyticsTargets: newSettings.analyticsTargets,
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

    // Immediately broadcast CHECKING state so the frontend shows the starting banner
    containerManager.resetReadiness(`Starting ${runner} runtime...`)

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

// POST /api/settings/restart-runner - Restart a container runtime (e.g., after changing runtime settings)
settings.post('/restart-runner', async (c) => {
  try {
    const body = await c.req.json()
    const runner = body.runner as ContainerRunner

    if (!runner || !SUPPORTED_RUNNERS.includes(runner)) {
      return c.json({ error: `Invalid runner. Must be one of: ${SUPPORTED_RUNNERS.join(', ')}` }, 400)
    }

    // Immediately broadcast CHECKING state so the frontend blocks agent creation
    // and shows the "restarting" banner before the actual restart begins
    containerManager.resetReadiness(`Restarting ${runner} runtime...`)

    const result = await restartRunner(runner)

    if (result.success) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const runnerAvailability = await refreshRunnerAvailability()

      containerManager.ensureImageReady().catch((error) => {
        console.error('Failed to check image after restarting runner:', error)
      })

      return c.json({ ...result, runnerAvailability })
    }

    return c.json(result, 400)
  } catch (error) {
    console.error('Failed to restart runner:', error)
    return c.json({ error: 'Failed to restart runner' }, 500)
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

// POST /api/settings/validate-anthropic-key - Validate an Anthropic API key (kept for backward compat)
settings.post('/validate-anthropic-key', async (c) => {
  try {
    const { apiKey } = await c.req.json()
    if (!apiKey || typeof apiKey !== 'string') {
      return c.json({ valid: false, error: 'API key is required' }, 400)
    }

    const result = await getLlmProvider('anthropic').validateKey(apiKey)
    return c.json(result)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Invalid API key'
    return c.json({ valid: false, error: message })
  }
})

// POST /api/settings/validate-llm-key - Validate an API key for any LLM provider
settings.post('/validate-llm-key', async (c) => {
  try {
    const { provider, apiKey } = await c.req.json()
    if (!apiKey || typeof apiKey !== 'string') {
      return c.json({ valid: false, error: 'API key is required' }, 400)
    }
    if (!provider || typeof provider !== 'string') {
      return c.json({ valid: false, error: 'Provider is required' }, 400)
    }
    if (provider !== 'anthropic' && provider !== 'openrouter' && provider !== 'bedrock') {
      return c.json({ valid: false, error: `Unknown provider: ${provider}` }, 400)
    }

    const llmProvider = getLlmProvider(provider)
    const result = await llmProvider.validateKey(apiKey)
    return c.json(result)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Invalid API key'
    return c.json({ valid: false, error: message })
  }
})

// POST /api/settings/validate-bedrock - Validate AWS credentials for Bedrock
settings.post('/validate-bedrock', async (c) => {
  try {
    const { accessKeyId, secretAccessKey, region } = await c.req.json()
    if (!accessKeyId || !secretAccessKey) {
      return c.json({ valid: false, error: 'Access Key ID and Secret Access Key are required' }, 400)
    }
    const bedrockProvider = getLlmProvider('bedrock') as BedrockLlmProvider
    const result = await bedrockProvider.validateAwsCredentials(
      accessKeyId,
      secretAccessKey,
      region || 'us-east-1'
    )
    return c.json(result)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Invalid credentials'
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

// POST /api/settings/validate-composio-key - Validate a Composio API key
settings.post('/validate-composio-key', async (c) => {
  try {
    const { apiKey } = await c.req.json()
    if (!apiKey || typeof apiKey !== 'string') {
      return c.json({ valid: false, error: 'API key is required' }, 400)
    }

    const response = await fetch('https://backend.composio.dev/api/v3/auth_configs', {
      headers: {
        'x-api-key': apiKey,
      },
    })

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return c.json({ valid: false, error: 'Invalid API key' })
      }
      return c.json({ valid: false, error: `Composio API error: ${response.status}` })
    }

    return c.json({ valid: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Validation failed'
    return c.json({ valid: false, error: message })
  }
})

// POST /api/settings/validate-stt-key - Validate an STT provider API key
settings.post('/validate-stt-key', async (c) => {
  try {
    const { provider, apiKey } = await c.req.json()
    if (!apiKey || typeof apiKey !== 'string') {
      return c.json({ valid: false, error: 'API key is required' }, 400)
    }
    if (!provider || (provider !== 'deepgram' && provider !== 'openai')) {
      return c.json({ valid: false, error: 'Invalid provider' }, 400)
    }

    const result = await getSttProvider(provider).validateKey(apiKey)
    return c.json(result)
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
    const settingsPath = path.join(getDataDir(), 'settings.json')
    await fs.promises.rm(settingsPath, { force: true })
    clearSettingsCache()

    return c.json({ success: true })
  } catch (error) {
    console.error('Factory reset failed:', error)
    return c.json({ error: 'Factory reset failed' }, 500)
  }
})

export default settings
