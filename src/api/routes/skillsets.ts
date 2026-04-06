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
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { getPlatformAccessToken, getPlatformAuthStatus } from '@shared/lib/services/platform-auth-service'
import type { SkillsetConfig, SkillProvider } from '@shared/lib/types/skillset'
import type { ApiSkillsetConfig } from '@shared/lib/types/api'
import { buildSkillsetAccessScope } from '@shared/lib/utils/skillset-helpers'

const skillsets = new Hono()

skillsets.use('*', Authenticated())

function getSkillsetAccessScope() {
  return buildSkillsetAccessScope(getSettings().skillsets || [], getPlatformAuthStatus().orgId)
}

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
    console.log('[GET /:id/skills] id=%s configFound=%s provider=%s platformRepoId=%s', id, !!config, config?.provider, config?.platformRepoId)
    const index = await getSkillsetIndex(id, {
      platformRepoId: config?.platformRepoId,
    })

    if (!index) {
      console.log('[GET /:id/skills] index is null — returning 404')
      return c.json({ error: 'Skillset not found or not cached' }, 404)
    }

    console.log('[GET /:id/skills] returning %d skills', index.skills?.length ?? 0)
    return c.json({ skills: index.skills })
  } catch (error) {
    console.error('[GET /:id/skills] FAILED:', error)
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
  console.log('[sync-platform] START')
  try {
    const proxyBase = getPlatformProxyBaseUrl()
    const token = getPlatformAccessToken()
    console.log('[sync-platform] proxyBase=%s tokenPresent=%s', proxyBase, !!token)
    if (!proxyBase || !token) {
      return c.json({ error: 'Platform not connected' }, 400)
    }

    const fetchUrl = `${proxyBase}/v1/skills/skillsets`
    console.log('[sync-platform] fetching skillsets from %s', fetchUrl)
    const res = await fetch(fetchUrl, {
      headers: { Authorization: `Bearer ${token}` },
    })
    console.log('[sync-platform] response status=%d ok=%s', res.status, res.ok)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error('[sync-platform] error body: %s', body)
      return c.json({ error: `Failed to fetch platform skillsets: ${res.status}` }, 502)
    }

    const data = await res.json() as {
      skillsets: Array<{ name: string; path: string; repoId: string; description: string; skill_count: number; agent_count: number }>
    }
    console.log('[sync-platform] received %d skillsets: %s', data.skillsets?.length ?? 0, JSON.stringify(data.skillsets?.map(s => ({ name: s.name, path: s.path, repoId: s.repoId }))))

    if (!data.skillsets?.length) {
      console.log('[sync-platform] no skillsets from platform, done')
      return c.json({ synced: 0, skillsets: [] })
    }

    const settings = getSettings()
    const platformAuth = getPlatformAuthStatus()
    const currentPlatformOrgId = platformAuth.orgId
    const currentPlatformOrgName = platformAuth.orgName
    const existing = settings.skillsets || []
    const added: SkillsetConfig[] = []
    let updatedExisting = false

    for (const remote of data.skillsets) {
      const skillsetId = `platform--${remote.repoId}--${remote.name}`
      console.log('[sync-platform] processing remote: name=%s repoId=%s → skillsetId=%s', remote.name, remote.repoId, skillsetId)

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
          console.log('[sync-platform] updated existing config: %s', JSON.stringify(existingConfig))
        } else {
          console.log('[sync-platform] already registered, skip')
        }
        continue
      }

      const config: SkillsetConfig = {
        id: skillsetId,
        url: `${proxyBase}/v1/skills/repo`,
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
      console.log('[sync-platform] added new config: %s', JSON.stringify(config))
    }

    if (added.length > 0 || updatedExisting) {
      updateSettings({ ...settings, skillsets: existing })
      console.log('[sync-platform] saved config changes to settings (added=%d updated=%s)', added.length, updatedExisting)
    }

    const allPlatform = existing.filter(
      (s) => s.provider === 'platform' && s.platformRepoId && s.platformOrgId === currentPlatformOrgId,
    )
    console.log('[sync-platform] will ensure clone for %d platform skillsets', allPlatform.length)
    const cloned = new Set<string>()
    for (const config of allPlatform) {
      if (!cloned.has(config.platformRepoId!)) {
        cloned.add(config.platformRepoId!)
        console.log('[sync-platform] cloning: id=%s platformRepoId=%s url=%s', config.id, config.platformRepoId, config.url)
        await ensureSkillsetCached(config.id, config.url, 'platform', config.platformRepoId, config.name)
        console.log('[sync-platform] clone done for %s', config.platformRepoId)
      }
    }

    console.log('[sync-platform] DONE — synced=%d', added.length)
    return c.json({ synced: added.length, skillsets: added.map((a) => a.name) })
  } catch (error) {
    console.error('[sync-platform] FAILED:', error)
    const message = error instanceof Error ? error.message : 'Failed to sync platform skillsets'
    return c.json({ error: message }, 500)
  }
})

export default skillsets
