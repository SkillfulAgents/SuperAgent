import path from 'path'
import { randomUUID } from 'crypto'
import { Hono, type Context } from 'hono'
import { getLlmProvider, getAllProviderInfo, modelCatalogSettingsSchema } from '@shared/lib/llm-provider'
import type { LlmProviderId } from '@shared/lib/llm-provider'
import type { BedrockLlmProvider } from '@shared/lib/llm-provider/bedrock-provider'
import { getDataDir, getAgentsDataDir } from '@shared/lib/config/data-dir'
import { assertPathWithinDir } from '@shared/lib/utils/path-safety'
import { Authenticated, IsAdmin } from '../middleware/auth'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import {
  getSettings,
  loadSettingsStrict,
  updateSettings,
  clearSettingsCache,
  getBrowserbaseApiKeyStatus,
  getComposioApiKeyStatus,
  getNangoApiKeyStatus,
  getComposioUserId,
  getAccountProviderUserId,
  getVoiceSettings,
  getEffectiveModels,
  getEffectiveAgentLimits,
  getCustomEnvVars,
  type AppSettings,
  type AppPreferences,
  type ApiKeySettings,
  type ContainerSettings,
  type GlobalSettingsResponse,
} from '@shared/lib/config/settings'
import { validateFaviconDataUrl } from '@shared/lib/config/favicon'
import { isValidAccelerator } from '@shared/lib/config/shortcuts'
import { getTenantId } from '@shared/lib/analytics/tenant-id'
import { getSttProvider } from '@shared/lib/stt'
import { findWebFetchProvider, findWebSearchProvider, getWebSearchProvider } from '@shared/lib/web-provider'
import { containerManager } from '@shared/lib/container/container-manager'
import { checkAllRunnersAvailability, refreshRunnerAvailability, startRunner, restartRunner, getContainerClientClass, SUPPORTED_RUNNERS, type ContainerRunner } from '@shared/lib/container/client-factory'
import { VALID_LIMA_VM_MEMORY_OPTIONS, EFFORT_LEVELS } from '@shared/lib/container/types'
import { customEnvVarsSchema } from '@shared/lib/container/reserved-env-vars'
import { detectAllProviders } from '../../main/host-browser'
import { revokePlatformToken } from '@shared/lib/services/platform-auth-service'
import { db } from '@shared/lib/db'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import {
  proxyAuditLog,
  proxyTokens,
  agentConnectedAccounts,
  scheduledTasks,
  notifications,
  connectedAccounts,
  userSettings,
  auditLog,
  webhookTriggers,
  chatIntegrations,
  chatIntegrationSessions,
  chatIntegrationAccess,
  remoteMcpServers,
  agentRemoteMcps,
  mcpAuditLog,
  mcpToolPolicies,
  agentAcl,
  messageAuthor,
  xAgentPolicies,
  apiScopePolicies,
} from '@shared/lib/db/schema'
import fs from 'fs'

const settings = new Hono()

const MODEL_ICON_UPLOAD_PREFIX = 'uploaded:'
const MODEL_ICON_UPLOAD_MAX_BYTES = 512 * 1024
const MODEL_ICON_MIME_EXTENSIONS: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}
const MODEL_ICON_EXTENSION_MIME_TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}
const UPLOADED_MODEL_ICON_FILENAME_RE = /^[a-f0-9-]+\.(?:svg|png|jpg|jpeg|webp)$/

function getModelIconsDataDir(): string {
  return path.join(getDataDir(), 'model-icons')
}

function isUploadedFile(value: unknown): value is File {
  return typeof value === 'object' &&
    value !== null &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function' &&
    typeof (value as { size?: unknown }).size === 'number' &&
    typeof (value as { type?: unknown }).type === 'string'
}

function getModelIconMimeType(fileName: string): string | undefined {
  const extension = fileName.split('.').pop()?.toLowerCase()
  if (!extension) return undefined
  return MODEL_ICON_EXTENSION_MIME_TYPES[extension]
}

async function serveUploadedModelIcon(c: Context) {
  try {
    const fileName = c.req.param('fileName')
    if (!fileName) {
      return c.json({ error: 'Invalid model icon filename' }, 400)
    }

    if (!UPLOADED_MODEL_ICON_FILENAME_RE.test(fileName)) {
      return c.json({ error: 'Invalid model icon filename' }, 400)
    }

    const mimeType = getModelIconMimeType(fileName)
    if (!mimeType) {
      return c.json({ error: 'Invalid model icon filename' }, 400)
    }

    // Defense-in-depth: the filename regex already forbids separators/traversal,
    // but contain the join under the icons dir before reading, per house style.
    const iconsDir = getModelIconsDataDir()
    const filePath = assertPathWithinDir(iconsDir, path.join(iconsDir, fileName), 'Invalid model icon filename')
    const bytes = await fs.promises.readFile(filePath)
    c.header('Cache-Control', 'public, max-age=31536000, immutable')
    c.header('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'")
    c.header('Content-Type', mimeType)
    c.header('X-Content-Type-Options', 'nosniff')
    return c.body(bytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return c.json({ error: 'Model icon not found' }, 404)
    }
    console.error('Failed to read model icon:', error)
    return c.json({ error: 'Failed to read model icon' }, 500)
  }
}

/**
 * Canonical set of agent/app-owned relational tables wiped by factory reset.
 *
 * Ordered children-before-parents so deletes succeed regardless of FK-cascade
 * state. Better Auth tables (user, session, account, verification) are
 * intentionally excluded — a factory reset clears app/agent data but does NOT
 * delete user accounts.
 *
 * Keep this reconciled with the per-agent set in agent-cleanup-service.ts. The
 * test in factory-reset.sup206.test.ts enumerates the schema dynamically and
 * fails if a new agent/app-owned table is added without being listed here, so
 * the set cannot silently drift again.
 */
const FACTORY_RESET_TABLES: SQLiteTable[] = [
  // Leaf / no-FK-to-reset-table audit + attribution rows
  proxyAuditLog,
  proxyTokens,
  mcpAuditLog,
  messageAuthor,
  agentAcl,
  xAgentPolicies,
  webhookTriggers,
  notifications,
  scheduledTasks,
  // chat integrations (access + sessions cascade from integrations)
  chatIntegrationAccess,
  chatIntegrationSessions,
  chatIntegrations,
  // connected accounts + dependents (api scope policies + agent mappings cascade)
  agentConnectedAccounts,
  apiScopePolicies,
  connectedAccounts,
  // remote MCP servers + dependents (tool policies + agent mappings cascade)
  agentRemoteMcps,
  mcpToolPolicies,
  remoteMcpServers,
  // per-user settings (user row itself is preserved)
  userSettings,
  // global app audit log
  auditLog,
]

// Custom model icons are used in regular model pickers, so any authenticated
// user may read them. Writes and the rest of settings stay admin-only.
settings.get('/model-icons/:fileName', Authenticated(), serveUploadedModelIcon)

settings.use('*', Authenticated(), IsAdmin())

/** All keys in ApiKeySettings — used to generically handle set/delete in PUT. */
const API_KEY_FIELDS: (keyof ApiKeySettings)[] = [
  'anthropicApiKey',
  'openrouterApiKey',
  'bedrockApiKey',
  'bedrockAccessKeyId',
  'bedrockSecretAccessKey',
  'bedrockRegion',
  'composioApiKey',
  'composioUserId',
  'browserbaseApiKey',
  'browserbaseProjectId',
  'deepgramApiKey',
  'openaiApiKey',
  'nangoSecretKey',
  'accountProviderUserId',
  'exaApiKey',
]

// GET /api/settings/llm-providers/:providerId/models/search - Provider-native model discovery
settings.get('/llm-providers/:providerId/models/search', async (c) => {
  try {
    const providerId = c.req.param('providerId') as LlmProviderId
    const provider = getLlmProvider(providerId)
    if (!provider.supportsModelSearch) {
      return c.json({ error: `${provider.name} does not support model search` }, 400)
    }

    const query = c.req.query('q') ?? ''
    if (query.trim().length < 2) {
      return c.json({ data: [] })
    }

    const data = await provider.searchModels(query)
    return c.json({ data })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unknown LLM provider')) {
      return c.json({ error: error.message }, 404)
    }
    if (error instanceof Error && error.message.includes('API key not configured')) {
      return c.json({ error: error.message }, 400)
    }
    console.error('Failed to search provider models:', error)
    return c.json({ error: 'Failed to search provider models' }, 500)
  }
})

// POST /api/settings/model-icons - Upload a custom model icon into the data dir
settings.post('/model-icons', async (c) => {
  try {
    const body = await c.req.parseBody()
    const maybeFile = Array.isArray(body.file) ? body.file[0] : body.file
    if (!isUploadedFile(maybeFile)) {
      return c.json({ error: 'Icon file is required' }, 400)
    }

    if (maybeFile.size === 0) {
      return c.json({ error: 'Icon file is empty' }, 400)
    }

    if (maybeFile.size > MODEL_ICON_UPLOAD_MAX_BYTES) {
      return c.json({ error: 'Icon file must be 512 KB or smaller' }, 400)
    }

    const contentType = maybeFile.type.toLowerCase()
    const extension = MODEL_ICON_MIME_EXTENSIONS[contentType]
    if (!extension) {
      return c.json({ error: 'Icon file must be SVG, PNG, JPEG, or WebP' }, 400)
    }

    const fileName = `${randomUUID()}.${extension}`
    const dataDir = getModelIconsDataDir()
    await fs.promises.mkdir(dataDir, { recursive: true })
    await fs.promises.writeFile(
      path.join(dataDir, fileName),
      Buffer.from(await maybeFile.arrayBuffer()),
      { mode: 0o600 },
    )

    return c.json({ icon: `${MODEL_ICON_UPLOAD_PREFIX}${fileName}` })
  } catch (error) {
    console.error('Failed to upload model icon:', error)
    return c.json({ error: 'Failed to upload model icon' }, 500)
  }
})

type AppPreferencesPatch = Partial<AppPreferences> & {
  faviconDataUrl?: unknown
  hostBrowserProvider?: unknown
}

/** Build the GlobalSettingsResponse shared by GET and PUT handlers. */
function buildSettingsResponse(
  appSettings: AppSettings,
  hasRunningAgents: boolean,
  runnerAvailability: Awaited<ReturnType<typeof checkAllRunnersAvailability>>,
): GlobalSettingsResponse {
  return {
    dataDir: getDataDir(),
    container: appSettings.container,
    app: appSettings.app || { showMenuBarIcon: true },
    hasRunningAgents,
    runnerAvailability,
    llmProvider: appSettings.llmProvider ?? 'anthropic',
    llmProviderStatus: getAllProviderInfo(),
    modelCatalog: appSettings.modelCatalog ?? {},
    webSearchProvider: appSettings.webSearchProvider ?? 'native',
    webFetchProvider: appSettings.webFetchProvider ?? 'native',
    apiKeyStatus: {
      anthropic: getLlmProvider('anthropic').getApiKeyStatus(),
      openrouter: getLlmProvider('openrouter').getApiKeyStatus(),
      bedrock: getLlmProvider('bedrock').getApiKeyStatus(),
      platform: getLlmProvider('platform').getApiKeyStatus(),
      browserbase: getBrowserbaseApiKeyStatus(),
      composio: getComposioApiKeyStatus(),
      nango: getNangoApiKeyStatus(),
      deepgram: getSttProvider('deepgram').getApiKeyStatus(),
      openai: getSttProvider('openai').getApiKeyStatus(),
      exa: getWebSearchProvider('exa').getApiKeyStatus(),
    },
    models: getEffectiveModels(),
    agentLimits: getEffectiveAgentLimits(),
    customEnvVars: getCustomEnvVars(),
    composioUserId: getComposioUserId(),
    accountProviderUserId: getAccountProviderUserId(),
    setupCompleted: !!appSettings.app?.setupCompleted,
    hostBrowserStatus: { providers: detectAllProviders() },
    runtimeReadiness: containerManager.getReadiness(),
    auth: appSettings.auth,
    voice: getVoiceSettings(),
    tenantId: getTenantId(),
    computerUse: appSettings.computerUse,
    shareAnalytics: appSettings.shareAnalytics !== false,
    analyticsTargets: appSettings.analyticsTargets,
    shareErrorReports: appSettings.shareErrorReports !== false,
    enableToolSearch: appSettings.enableToolSearch !== false,
  }
}

// GET /api/settings - Get global settings
settings.get('/', async (c) => {
  try {
    const currentSettings = getSettings()
    const hasRunningAgents = containerManager.hasRunningAgents()
    const runnerAvailability = await checkAllRunnersAvailability()
    return c.json(buildSettingsResponse(currentSettings, hasRunningAgents, runnerAvailability))
  } catch (error) {
    console.error('Failed to fetch settings:', error)
    return c.json({ error: 'Failed to fetch settings' }, 500)
  }
})

// PUT /api/settings - Update settings
settings.put('/', async (c) => {
  try {
    const body = await c.req.json()
    // Read FRESH and fail-closed: never merge onto the possibly-
    // corruption-defaulted cache (that is what overwrote real API keys/auth). A
    // corrupt settings.json throws here → caught below → 500, instead of being
    // silently replaced with defaults. The write path below this point has no
    // `await`, so the read-merge-write stays atomic (no interleaving).
    const currentSettings = loadSettingsStrict()
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

    // Reject agentImage changes for runners whose image is fixed by the
    // deployment (e.g. lambda-microvm reads only MICROVM_AGENT_IMAGE_ARN).
    if (body.container?.agentImage !== undefined) {
      const newContainer = body.container as Partial<ContainerSettings>
      const effectiveRunner = (newContainer.containerRunner ??
        currentSettings.container.containerRunner) as ContainerRunner
      if (
        newContainer.agentImage !== currentSettings.container.agentImage &&
        !getContainerClientClass(effectiveRunner).supportsCustomAgentImage
      ) {
        return c.json(
          { error: `Agent image is managed by the deployment for the ${effectiveRunner} runner and cannot be changed here.` },
          400
        )
      }
    }

    // Validate enableToolSearch if provided
    if (body.enableToolSearch !== undefined && typeof body.enableToolSearch !== 'boolean') {
      return c.json({ error: 'enableToolSearch must be a boolean' }, 400)
    }

    // Validate agentEffort if provided
    if (body.models?.agentEffort !== undefined && !EFFORT_LEVELS.includes(body.models.agentEffort)) {
      return c.json({ error: `agentEffort must be one of: ${EFFORT_LEVELS.join(', ')}` }, 400)
    }

    // Validate the quick-dispatch global shortcut accelerator. Empty string is
    // allowed and means "disabled"; any other value must be a plausible
    // accelerator (main's globalShortcut.register is the authoritative gate).
    if (body.app?.globalDispatchShortcut !== undefined) {
      const acc = body.app.globalDispatchShortcut
      if (typeof acc !== 'string' || (acc !== '' && !isValidAccelerator(acc))) {
        return c.json(
          { error: 'globalDispatchShortcut must be an accelerator like "CommandOrControl+Shift+Space" (or "" to disable)' },
          400,
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

    // Validate customEnvVars at the write boundary (defense-in-depth for
    // SUP-210): reject payloads that try to set reserved runtime env vars so
    // they never reach persisted settings.
    if (body.customEnvVars !== undefined) {
      const parsed = customEnvVarsSchema.safeParse(body.customEnvVars)
      if (!parsed.success) {
        return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid customEnvVars' }, 400)
      }
    }

    let parsedModelCatalog = currentSettings.modelCatalog
    if (body.modelCatalog !== undefined) {
      const parsed = modelCatalogSettingsSchema.safeParse(body.modelCatalog)
      if (!parsed.success) {
        return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid modelCatalog' }, 400)
      }
      parsedModelCatalog = parsed.data
    }

    let appPatch = body.app as AppPreferencesPatch | undefined
    if (appPatch && Object.prototype.hasOwnProperty.call(appPatch, 'faviconDataUrl')) {
      const validation = validateFaviconDataUrl(appPatch.faviconDataUrl)
      if (!validation.ok) {
        return c.json({ error: validation.error }, 400)
      }

      appPatch = { ...appPatch }
      appPatch.faviconUpdatedAt = new Date().toISOString()
      if (appPatch.faviconDataUrl === null || appPatch.faviconDataUrl === '') {
        appPatch.faviconDataUrl = undefined
      }
    }

    // When the active LLM provider changes, reset model selections to the new
    // provider's defaults (bare aliases) — unless the same request sets `models`
    // explicitly. Prevents a pin from the old provider's catalog (which may not
    // exist for the new one, e.g. a bare-Claude id on Bedrock) from leaking across.
    const currentProvider = currentSettings.llmProvider ?? 'anthropic'
    const providerChanged =
      body.llmProvider !== undefined && body.llmProvider !== currentProvider
    let providerDefaultModels:
      | { summarizerModel: string; agentModel: string; browserModel: string; dashboardBuilderModel: string }
      | undefined
    if (providerChanged && body.models === undefined) {
      try {
        providerDefaultModels = getLlmProvider(body.llmProvider).getDefaultModels()
      } catch {
        // Unknown provider id — leave models as-is; other guards handle validity.
        providerDefaultModels = undefined
      }
    }

    // Merge new settings with current settings
    // TODO refactor - pineapple on pizza level gross
    const newSettings: AppSettings = {
      container: {
        ...currentSettings.container,
        ...body.container,
        resourceLimits: body.container?.resourceLimits
          ? { ...currentSettings.container.resourceLimits, ...body.container.resourceLimits }
          : currentSettings.container.resourceLimits,
        runtimeSettings: body.container?.runtimeSettings
          ? { ...currentSettings.container.runtimeSettings, ...body.container.runtimeSettings }
          : currentSettings.container.runtimeSettings,
      },
      app: {
        ...currentSettings.app,
        ...appPatch,
        // If hostBrowserProvider was explicitly set to null (meaning "use container"),
        // remove it from settings so consumers treat it as "no host provider"
        ...(appPatch && 'hostBrowserProvider' in appPatch && appPatch.hostBrowserProvider == null
          ? { hostBrowserProvider: undefined }
          : {}),
      },
      apiKeys: currentSettings.apiKeys,
      llmProvider: body.llmProvider !== undefined ? body.llmProvider : currentSettings.llmProvider,
      webSearchProvider: body.webSearchProvider !== undefined ? body.webSearchProvider : currentSettings.webSearchProvider,
      webFetchProvider: body.webFetchProvider !== undefined ? body.webFetchProvider : currentSettings.webFetchProvider,
      webAllowedSites: body.webAllowedSites !== undefined ? body.webAllowedSites : currentSettings.webAllowedSites,
      webBlockedSites: body.webBlockedSites !== undefined ? body.webBlockedSites : currentSettings.webBlockedSites,
      models: body.models
        ? { ...currentSettings.models, ...body.models }
        : providerDefaultModels
          ? { ...currentSettings.models, ...providerDefaultModels }
          : currentSettings.models,
      modelCatalog: parsedModelCatalog,
      agentLimits: body.agentLimits !== undefined
        ? { ...currentSettings.agentLimits, ...body.agentLimits }
        : currentSettings.agentLimits,
      customEnvVars: body.customEnvVars !== undefined ? body.customEnvVars : currentSettings.customEnvVars,
      skillsets: currentSettings.skillsets,
      platformAuth: currentSettings.platformAuth,
      auth: body.auth !== undefined ? { ...currentSettings.auth, ...body.auth } : currentSettings.auth,
      voice: body.voice !== undefined ? { ...currentSettings.voice, ...body.voice } : currentSettings.voice,
      shareAnalytics: body.shareAnalytics !== undefined ? body.shareAnalytics : currentSettings.shareAnalytics,
      shareErrorReports: body.shareErrorReports !== undefined ? body.shareErrorReports : currentSettings.shareErrorReports,
      enableToolSearch: body.enableToolSearch !== undefined ? body.enableToolSearch : currentSettings.enableToolSearch,
      computerUse: body.computerUse !== undefined
        ? { ...currentSettings.computerUse, ...body.computerUse }
        : currentSettings.computerUse,
      analyticsTargets: body.analyticsTargets !== undefined ? body.analyticsTargets : currentSettings.analyticsTargets,
    }

    // Handle API key updates: empty string = delete, truthy = set, absent = keep
    if (body.apiKeys !== undefined) {
      for (const field of API_KEY_FIELDS) {
        const value = body.apiKeys[field]
        if (value === '') {
          newSettings.apiKeys = { ...newSettings.apiKeys }
          delete newSettings.apiKeys[field]
        } else if (value) {
          newSettings.apiKeys = { ...newSettings.apiKeys, [field]: value }
        }
      }

      if (newSettings.apiKeys && Object.keys(newSettings.apiKeys).length === 0) {
        delete newSettings.apiKeys
      }
    }

    updateSettings(newSettings)

    // If account provider settings changed, re-register providers
    if (body.apiKeys?.nangoSecretKey !== undefined || body.app?.accountProvider !== undefined) {
      try {
        const { registerAllAccountProviders } = await import('@shared/lib/account-providers/register')
        await registerAllAccountProviders()
      } catch (err) {
        console.error('Failed to re-register account providers:', err)
      }
    }

    // If auth settings changed, reset the Better Auth singleton so it picks up new config
    if (body.auth !== undefined && isAuthMode()) {
      import('@shared/lib/auth/index').then(({ resetAuth }) => resetAuth()).catch(() => {})
    }

    // If container runner changed, clear cached clients so new ones use the updated runner
    if (newSettings.container.containerRunner !== currentSettings.container.containerRunner) {
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
    logAuditEvent({ userId: getCurrentUserId(c), object: 'settings', objectId: 'global', action: 'updated' })
    return c.json(buildSettingsResponse(newSettings, hasRunningAgents, runnerAvailability))
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

// POST /api/settings/validate-nango-key - Validate a Nango secret key
settings.post('/validate-nango-key', async (c) => {
  try {
    const { apiKey } = await c.req.json()
    if (!apiKey || typeof apiKey !== 'string') {
      return c.json({ valid: false, error: 'Secret key is required' }, 400)
    }

    const response = await fetch('https://api.nango.dev/integrations', {
      headers: { Authorization: `Bearer ${apiKey}` },
    })

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return c.json({ valid: false, error: 'Invalid secret key' })
      }
      return c.json({ valid: false, error: `Nango API error: ${response.status}` })
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

// POST /api/settings/validate-web-search-key - Validate a web search vendor API key.
// Dispatches by `provider` through the registry, so a new vendor needs zero changes here.
settings.post('/validate-web-search-key', async (c) => {
  try {
    const { provider, apiKey } = await c.req.json()
    if (!apiKey || typeof apiKey !== 'string') {
      return c.json({ valid: false, error: 'API key is required' }, 400)
    }
    if (!provider || typeof provider !== 'string' || provider === 'native') {
      return c.json({ valid: false, error: 'A web search vendor is required' }, 400)
    }
    const webProvider = findWebSearchProvider(provider)
    if (!webProvider) {
      return c.json({ valid: false, error: `Unknown web search provider: ${provider}` }, 400)
    }
    const result = await webProvider.validateKey(apiKey)
    return c.json(result)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Validation failed'
    return c.json({ valid: false, error: message })
  }
})

// POST /api/settings/validate-web-fetch-key - Validate a web fetch vendor API key.
// Dispatches by `provider` through the registry, so a new vendor needs zero changes here.
settings.post('/validate-web-fetch-key', async (c) => {
  try {
    const { provider, apiKey } = await c.req.json()
    if (!apiKey || typeof apiKey !== 'string') {
      return c.json({ valid: false, error: 'API key is required' }, 400)
    }
    if (!provider || typeof provider !== 'string' || provider === 'native') {
      return c.json({ valid: false, error: 'A web fetch vendor is required' }, 400)
    }
    const webProvider = findWebFetchProvider(provider)
    if (!webProvider) {
      return c.json({ valid: false, error: `Unknown web fetch provider: ${provider}` }, 400)
    }
    const result = await webProvider.validateKey(apiKey)
    return c.json(result)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Validation failed'
    return c.json({ valid: false, error: message })
  }
})

// POST /api/settings/factory-reset - Reset all data
settings.post('/factory-reset', async (c) => {
  try {
    // Revoke platform token remotely before clearing local state
    try {
      await revokePlatformToken({ clearLocal: false })
    } catch {
      // Best-effort: continue with reset even if remote revoke fails
    }

    // Stop all running containers
    await containerManager.stopAll()

    // Delete agents directory
    const agentsDir = getAgentsDataDir()
    await fs.promises.rm(agentsDir, { recursive: true, force: true })

    // Clear every agent/app-owned relational table (children before parents).
    // Better Auth tables (user/session/account/verification) are preserved.
    for (const table of FACTORY_RESET_TABLES) {
      db.delete(table).run()
    }

    // Delete settings file (includes platform auth token)
    const settingsPath = path.join(getDataDir(), 'settings.json')
    await fs.promises.rm(settingsPath, { force: true })
    clearSettingsCache()

    // Remove platform device identity so a fresh key is issued on next login
    const platformDeviceDir = path.join(getDataDir(), '.platform-auth')
    await fs.promises.rm(platformDeviceDir, { recursive: true, force: true })
    return c.json({ success: true })
  } catch (error) {
    console.error('Factory reset failed:', error)
    return c.json({ error: 'Factory reset failed' }, 500)
  }
})

export default settings
