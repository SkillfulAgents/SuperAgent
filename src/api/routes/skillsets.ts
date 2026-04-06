import { Hono } from 'hono'
import {
  getSettings,
  updateSettings,
} from '@shared/lib/config/settings'
import { Authenticated, IsAdmin } from '../middleware/auth'
import {
  validateSkillsetUrl,
  urlToSkillsetId,
  refreshSkillset,
  getSkillsetIndex,
  removeSkillsetCache,
  ensureSkillsetCached,
} from '@shared/lib/services/skillset-service'
import { getSkillsetProvider } from '@shared/lib/skillset-provider'
import { getPlatformAuthStatus } from '@shared/lib/services/platform-auth-service'
import type { SkillsetConfig, SkillProvider } from '@shared/lib/types/skillset'
import type { ApiSkillsetConfig } from '@shared/lib/types/api'
import { getSkillsetAccessScope } from '@shared/lib/utils/skillset-helpers'

const skillsets = new Hono()

skillsets.use('*', Authenticated())

function configToApiResponse(config: SkillsetConfig, skillCount: number, agentCount: number = 0): ApiSkillsetConfig {
  return {
    id: config.id,
    url: config.url,
    name: config.name,
    description: config.description,
    skillCount,
    agentCount,
    addedAt: config.addedAt,
    provider: config.provider,
  }
}

// GET /api/skillsets - List configured skillsets
skillsets.get('/', async (c) => {
  try {
    const scope = getSkillsetAccessScope()
    const result: ApiSkillsetConfig[] = []

    for (const config of scope.accessibleSkillsets) {
      const index = await getSkillsetIndex(config.id, {
        platformRepoId: config.platformRepoId,
        provider: config.provider,
      })
      result.push(configToApiResponse(config, index?.skills.length ?? 0, index?.agents?.length ?? 0))
    }

    return c.json(result)
  } catch (error) {
    console.error('Failed to list skillsets:', error)
    return c.json({ error: 'Failed to list skillsets' }, 500)
  }
})

// POST /api/skillsets/validate - Validate a skillset URL
skillsets.post('/validate', IsAdmin(), async (c) => {
  try {
    const { url, provider } = await c.req.json() as { url?: string; provider?: SkillProvider }
    if (!url || typeof url !== 'string') {
      return c.json({ valid: false, error: 'URL is required' }, 400)
    }

    const index = await validateSkillsetUrl(url.trim(), provider)
    return c.json({ valid: true, index })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to validate skillset URL'
    return c.json({ valid: false, error: message })
  }
})

// POST /api/skillsets - Add a skillset (validates first)
skillsets.post('/', IsAdmin(), async (c) => {
  try {
    const { url, provider } = await c.req.json() as { url?: string; provider?: SkillProvider }
    if (!url || typeof url !== 'string') {
      return c.json({ error: 'URL is required' }, 400)
    }

    const trimmedUrl = url.trim()
    const skillsetId = urlToSkillsetId(trimmedUrl)

    // Check for duplicates
    const settings = getSettings()
    const existing = settings.skillsets || []
    if (existing.some((s) => s.id === skillsetId)) {
      return c.json({ error: 'This skillset is already configured' }, 409)
    }

    // Validate and fetch index
    const index = await validateSkillsetUrl(trimmedUrl, provider)

    // Save to settings
    const config: SkillsetConfig = {
      id: skillsetId,
      url: trimmedUrl,
      name: index.skillset_name,
      description: index.description || '',
      addedAt: new Date().toISOString(),
      provider,
    }

    const newSettings = {
      ...settings,
      skillsets: [...existing, config],
    }
    updateSettings(newSettings)

    return c.json(configToApiResponse(config, index.skills.length, index.agents?.length ?? 0), 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to add skillset'
    return c.json({ error: message }, 500)
  }
})

// DELETE /api/skillsets/:id - Remove a skillset
skillsets.delete('/:id', IsAdmin(), async (c) => {
  try {
    const id = c.req.param('id')
    const settings = getSettings()
    const existing = settings.skillsets || []
    const filtered = existing.filter((s) => s.id !== id)

    if (filtered.length === existing.length) {
      return c.json({ error: 'Skillset not found' }, 404)
    }

    // Remove from settings
    updateSettings({ ...settings, skillsets: filtered })

    // Clean up cache
    await removeSkillsetCache(id)

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to remove skillset:', error)
    return c.json({ error: 'Failed to remove skillset' }, 500)
  }
})

// POST /api/skillsets/:id/refresh - Refresh a skillset (git pull)
skillsets.post('/:id/refresh', IsAdmin(), async (c) => {
  try {
    const id = c.req.param('id')
    const settings = getSettings()
    const config = (settings.skillsets || []).find((s) => s.id === id)

    if (!config) {
      return c.json({ error: 'Skillset not found' }, 404)
    }

    const index = await refreshSkillset(id, config.url, config.provider, config.platformRepoId, config.name)
    return c.json({ skills: index.skills })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to refresh skillset'
    return c.json({ error: message }, 500)
  }
})

// GET /api/skillsets/:id/skills - Get skills from a specific skillset
skillsets.get('/:id/skills', async (c) => {
  try {
    const id = c.req.param('id')
    const settings = getSettings()
    const config = (settings.skillsets || []).find((s) => s.id === id)
    const index = await getSkillsetIndex(id, {
      platformRepoId: config?.platformRepoId,
      provider: config?.provider,
    })

    if (!index) {
      return c.json({ error: 'Skillset not found or not cached' }, 404)
    }

    return c.json({ skills: index.skills })
  } catch (error) {
    console.error('Failed to get skillset skills:', error)
    return c.json({ error: 'Failed to get skillset skills' }, 500)
  }
})

// GET /api/skillsets/:id/agents - Get agents from a specific skillset
skillsets.get('/:id/agents', async (c) => {
  try {
    const id = c.req.param('id')
    const settings = getSettings()
    const config = (settings.skillsets || []).find((s) => s.id === id)
    const index = await getSkillsetIndex(id, {
      platformRepoId: config?.platformRepoId,
      provider: config?.provider,
    })

    if (!index) {
      return c.json({ error: 'Skillset not found or not cached' }, 404)
    }

    return c.json({ agents: index.agents || [] })
  } catch (error) {
    console.error('Failed to get skillset agents:', error)
    return c.json({ error: 'Failed to get skillset agents' }, 500)
  }
})

// POST /api/skillsets/sync-platform - Auto-register platform skillsets after connecting
skillsets.post('/sync-platform', IsAdmin(), async (c) => {
  try {
    const platformAuth = getPlatformAuthStatus()
    if (!platformAuth.connected) {
      return c.json({ error: 'Platform not connected' }, 400)
    }

    const platformProvider = getSkillsetProvider('platform')
    const remoteSkillsets = await platformProvider.listRemoteSkillsets()
    if (!remoteSkillsets.length) {
      return c.json({ synced: 0, skillsets: [] })
    }

    const settings = getSettings()
    const currentPlatformOrgId = platformAuth.orgId
    const currentPlatformOrgName = platformAuth.orgName
    const existing = settings.skillsets || []
    const added: SkillsetConfig[] = []
    let updatedExisting = false

    for (const remote of remoteSkillsets) {
      const skillsetId = `platform--${remote.repoId}--${remote.name}`

      const existingConfig = existing.find((s) => s.id === skillsetId)
      if (existingConfig) {
        if (
          existingConfig.platformOrgId !== currentPlatformOrgId
          || existingConfig.name !== remote.name
          || existingConfig.description !== (remote.description || '')
        ) {
          existingConfig.name = remote.name
          existingConfig.description = remote.description || ''
          existingConfig.platformOrgId = currentPlatformOrgId ?? undefined
          existingConfig.platformOrgName = currentPlatformOrgName ?? undefined
          updatedExisting = true
        }
        continue
      }

      const config: SkillsetConfig = {
        id: skillsetId,
        url: platformProvider.getRegistrationUrl('platform://skills/repo'),
        name: remote.name,
        description: remote.description || '',
        addedAt: new Date().toISOString(),
        provider: 'platform',
        platformRepoId: remote.repoId,
        ...(currentPlatformOrgId ? { platformOrgId: currentPlatformOrgId } : {}),
        ...(currentPlatformOrgName ? { platformOrgName: currentPlatformOrgName } : {}),
      }
      existing.push(config)
      added.push(config)
    }

    if (added.length > 0 || updatedExisting) {
      updateSettings({ ...settings, skillsets: existing })
    }

    const allPlatform = existing.filter(
      (s) => s.provider === 'platform' && s.platformRepoId && s.platformOrgId === currentPlatformOrgId,
    )
    const cloned = new Set<string>()
    for (const config of allPlatform) {
      if (!cloned.has(config.platformRepoId!)) {
        cloned.add(config.platformRepoId!)
        await ensureSkillsetCached(config.id, config.url, 'platform', config.platformRepoId, config.name)
      }
    }

    return c.json({ synced: added.length, skillsets: added.map((a) => a.name) })
  } catch (error) {
    console.error('Failed to sync platform skillsets:', error)
    const message = error instanceof Error ? error.message : 'Failed to sync platform skillsets'
    return c.json({ error: message }, 500)
  }
})

export default skillsets
