import { Hono } from 'hono'
import {
  getSettings,
  updateSettings,
} from '@shared/lib/config/settings'
import {
  validateSkillsetUrl,
  urlToSkillsetId,
  refreshSkillset,
  getSkillsetIndex,
  removeSkillsetCache,
} from '@shared/lib/services/skillset-service'
import type { SkillsetConfig } from '@shared/lib/types/skillset'
import type { ApiSkillsetConfig } from '@shared/lib/types/api'

const skillsets = new Hono()

function configToApiResponse(config: SkillsetConfig, skillCount: number, agentCount: number = 0): ApiSkillsetConfig {
  return {
    id: config.id,
    url: config.url,
    name: config.name,
    description: config.description,
    skillCount,
    agentCount,
    addedAt: config.addedAt,
  }
}

// GET /api/skillsets - List configured skillsets
skillsets.get('/', async (c) => {
  try {
    const settings = getSettings()
    const configs = settings.skillsets || []
    const result: ApiSkillsetConfig[] = []

    for (const config of configs) {
      const index = await getSkillsetIndex(config.id)
      result.push(configToApiResponse(config, index?.skills.length ?? 0, index?.agents?.length ?? 0))
    }

    return c.json(result)
  } catch (error) {
    console.error('Failed to list skillsets:', error)
    return c.json({ error: 'Failed to list skillsets' }, 500)
  }
})

// POST /api/skillsets/validate - Validate a skillset URL
skillsets.post('/validate', async (c) => {
  try {
    const { url } = await c.req.json()
    if (!url || typeof url !== 'string') {
      return c.json({ valid: false, error: 'URL is required' }, 400)
    }

    const index = await validateSkillsetUrl(url.trim())
    return c.json({ valid: true, index })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to validate skillset URL'
    return c.json({ valid: false, error: message })
  }
})

// POST /api/skillsets - Add a skillset (validates first)
skillsets.post('/', async (c) => {
  try {
    const { url } = await c.req.json()
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
    const index = await validateSkillsetUrl(trimmedUrl)

    // Save to settings
    const config: SkillsetConfig = {
      id: skillsetId,
      url: trimmedUrl,
      name: index.skillset_name,
      description: index.description || '',
      addedAt: new Date().toISOString(),
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
skillsets.delete('/:id', async (c) => {
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
skillsets.post('/:id/refresh', async (c) => {
  try {
    const id = c.req.param('id')
    const settings = getSettings()
    const config = (settings.skillsets || []).find((s) => s.id === id)

    if (!config) {
      return c.json({ error: 'Skillset not found' }, 404)
    }

    const index = await refreshSkillset(id, config.url)
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
    const index = await getSkillsetIndex(id)

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
    const index = await getSkillsetIndex(id)

    if (!index) {
      return c.json({ error: 'Skillset not found or not cached' }, 404)
    }

    return c.json({ agents: index.agents || [] })
  } catch (error) {
    console.error('Failed to get skillset agents:', error)
    return c.json({ error: 'Failed to get skillset agents' }, 500)
  }
})

export default skillsets
