import { Hono } from 'hono'

import {
  listPlatformSkillsets,
  getPlatformSkillset,
  getPlatformSkillContent,
  listPlatformSkillFiles,
  getPlatformAgentTemplate,
  installSkillFromPlatform,
  installAgentFromPlatform,
} from '@shared/lib/services/platform-skills-service'

const platformSkills = new Hono()

// GET /api/platform-skills/skillsets
platformSkills.get('/skillsets', async (c) => {
  try {
    const skillsets = await listPlatformSkillsets()
    return c.json({ skillsets })
  } catch (error) {
    const status = (error as any)?.status ?? 500
    const message = error instanceof Error ? error.message : 'Failed to fetch platform skillsets'
    return c.json({ error: message }, status)
  }
})

// GET /api/platform-skills/skillsets/:name
platformSkills.get('/skillsets/:name', async (c) => {
  try {
    const name = c.req.param('name')
    const skillset = await getPlatformSkillset(name)
    return c.json({ skillset })
  } catch (error) {
    const status = (error as any)?.status ?? 500
    const message = error instanceof Error ? error.message : 'Failed to fetch skillset'
    return c.json({ error: message }, status)
  }
})

// GET /api/platform-skills/skillsets/:name/skills/:skill
platformSkills.get('/skillsets/:name/skills/:skill', async (c) => {
  try {
    const { name, skill } = c.req.param()
    const content = await getPlatformSkillContent(name, skill)
    return c.json(content)
  } catch (error) {
    const status = (error as any)?.status ?? 500
    const message = error instanceof Error ? error.message : 'Failed to fetch skill content'
    return c.json({ error: message }, status)
  }
})

// GET /api/platform-skills/skillsets/:name/skills/:skill/files
platformSkills.get('/skillsets/:name/skills/:skill/files', async (c) => {
  try {
    const { name, skill } = c.req.param()
    const files = await listPlatformSkillFiles(name, skill)
    return c.json({ files })
  } catch (error) {
    const status = (error as any)?.status ?? 500
    const message = error instanceof Error ? error.message : 'Failed to fetch skill files'
    return c.json({ error: message }, status)
  }
})

// GET /api/platform-skills/skillsets/:name/agents/:agent
platformSkills.get('/skillsets/:name/agents/:agent', async (c) => {
  try {
    const { name, agent } = c.req.param()
    const template = await getPlatformAgentTemplate(name, agent)
    return c.json({ template })
  } catch (error) {
    const status = (error as any)?.status ?? 500
    const message = error instanceof Error ? error.message : 'Failed to fetch agent template'
    return c.json({ error: message }, status)
  }
})

// POST /api/platform-skills/install
platformSkills.post('/install', async (c) => {
  try {
    const { agentSlug, skillsetName, skillName, displayName } = await c.req.json()

    if (!agentSlug || !skillsetName || !skillName) {
      return c.json({ error: 'agentSlug, skillsetName, and skillName are required' }, 400)
    }

    const result = await installSkillFromPlatform(
      agentSlug,
      skillsetName,
      skillName,
      displayName || skillName,
    )
    return c.json(result, 201)
  } catch (error) {
    const status = (error as any)?.status ?? 500
    const message = error instanceof Error ? error.message : 'Failed to install skill from platform'
    return c.json({ error: message }, status)
  }
})

// POST /api/platform-skills/install-agent
platformSkills.post('/install-agent', async (c) => {
  try {
    const { skillsetName, agentName, displayName } = await c.req.json()

    if (!skillsetName || !agentName) {
      return c.json({ error: 'skillsetName and agentName are required' }, 400)
    }

    const result = await installAgentFromPlatform(
      skillsetName,
      agentName,
      displayName || agentName,
    )
    return c.json(result, 201)
  } catch (error) {
    const status = (error as any)?.status ?? 500
    const message = error instanceof Error ? error.message : 'Failed to install agent from platform'
    return c.json({ error: message }, status)
  }
})

export default platformSkills
