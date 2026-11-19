/**
 * Container-to-host team skill discovery. An agent searches its team's skillsets for skills
 * it does not have yet, and installs one into its own workspace.
 *
 * Auth: the calling agent's proxy token (Bearer). Both routes act on the caller only.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { requireAgentCaller, type AgentCallerVariables } from '../middleware/agent-caller'
import { getSettings } from '@shared/lib/config/settings'
import { captureException } from '@shared/lib/error-reporting'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { matchSkills } from '@shared/lib/services/skill-search'
import { getDiscoverableSkills, installDiscoverableSkill, refreshAgentSkills } from '@shared/lib/services/skillset-service'
import { getSkillsetProvider } from '@shared/lib/skillset-provider'

const MAX_RESULTS = 25

async function getTeamSkillsets() {
  const skillsets = (await getSettings()).skillsets ?? []
  return skillsets.filter((skillset) => getSkillsetProvider(skillset.provider).holdsTeamSkills)
}

const router = new Hono<{ Variables: AgentCallerVariables }>()
router.use('*', requireAgentCaller)

router.post('/search', zValidator('json', z.object({ query: z.string().max(200).optional() })), async (c) => {
  try {
    const callerSlug = c.get('callerSlug')
    const skillsets = await getTeamSkillsets()
    // Pulls each skillset that was not refreshed lately, so the search sees what was published since.
    await refreshAgentSkills(callerSlug, skillsets, { background: true })
    const matches = matchSkills(await getDiscoverableSkills(callerSlug, skillsets), c.req.valid('json').query)
    return c.json({ skills: matches.slice(0, MAX_RESULTS), total: matches.length })
  } catch (error) {
    captureException(error, { tags: { component: 'agent-skills', operation: 'search' } })
    return c.json({ error: 'Failed to search team skills' }, 500)
  }
})

const installBodySchema = z.object({ skillsetId: z.string().min(1), skillPath: z.string().min(1) })

router.post('/install', zValidator('json', installBodySchema), async (c) => {
  try {
    const callerSlug = c.get('callerSlug')
    const { skillsetId, skillPath } = c.req.valid('json')
    const installed = await installDiscoverableSkill(callerSlug, await getTeamSkillsets(), skillsetId, skillPath)
    if (!installed) {
      return c.json({ error: 'No such skill to install: the team skillset does not list it, or this agent already has it' }, 404)
    }
    await logAuditEvent({
      object: 'skill',
      objectId: `${callerSlug}/${skillPath}`,
      action: 'created',
      details: { skillsetId, skillName: installed.name, by: 'agent', agentSlug: callerSlug },
    })
    return c.json(installed)
  } catch (error) {
    captureException(error, { tags: { component: 'agent-skills', operation: 'install' } })
    return c.json({ error: error instanceof Error ? error.message : 'Failed to install skill' }, 500)
  }
})

export default router
