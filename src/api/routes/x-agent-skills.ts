/**
 * Container-to-host team skill routes. An agent searches its team's skillsets for skills it
 * does not have yet, installs one into its own workspace, and asks to publish one of its own.
 *
 * Auth: the calling agent's proxy token (Bearer). Every route acts on the caller only.
 *
 * Publishing waits on a person: the host raises an approval card and publishes only what the
 * card showed, after an owner of the agent approves it. The route answers at once with a
 * proposal id (202) and the agent polls /wait, because one request held for the whole decision
 * does not survive the proxies between a cloud agent and the host.
 */
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { requireAgentCaller, type AgentCallerVariables } from '../middleware/agent-caller'
import { agentRegistry } from '@shared/lib/agent-actor'
import { getSettings } from '@shared/lib/config/settings'
import { captureException } from '@shared/lib/error-reporting'
import { awaitReview } from '@shared/lib/proxy/review-request'
import { RuleJobs, TooManyJobsError } from '@shared/lib/proxy/rules/jobs'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { matchSkills } from '@shared/lib/services/skill-search'
import {
  BACKGROUND_SKILLSET_REFRESH_MAX_AGE_MS,
  getDiscoverableSkills,
  installDiscoverableSkill,
  planTeamSkillPublish,
  publishPlannedTeamSkill,
  pullSkillsets,
  SkillPublishRefusal,
  type TeamSkillPublishPlan,
} from '@shared/lib/services/skillset-service'
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
    // Pulls each skillset that was not refreshed lately, so the search sees what was published
    // since. Only the caches: the agent's installed skills are not reconciled on its own request.
    await pullSkillsets(skillsets, { maxAgeMs: BACKGROUND_SKILLSET_REFRESH_MAX_AGE_MS })
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

interface PublishOutcome {
  status: ContentfulStatusCode
  body: Record<string, unknown>
}

const PUBLISH_WAIT_MS = 20_000
const publishes = new RuleJobs<PublishOutcome>({ leaseMs: 60_000, keepMs: 10 * 60_000, maxRunningPerOwner: 3 })

const publishBodySchema = z.object({
  skillDirectory: z.string().min(1).max(200),
  skillsetId: z.string().min(1).optional(),
  title: z.string().min(1).max(200),
  note: z.string().min(1).max(2000),
})
type PublishRequest = z.infer<typeof publishBodySchema>

const proposalSchema = z.object({ proposalId: z.string().min(1) })

// Reading the skill, the card and the publish all run in the job, so the route answers at once
// and the limit on waiting jobs applies before the host reads anything from the workspace.
router.post('/publish', zValidator('json', publishBodySchema), (c) => {
  const callerSlug = c.get('callerSlug')
  const request = c.req.valid('json')
  let proposalId: string
  try {
    proposalId = publishes.start(callerSlug, (signal) => proposePublish(callerSlug, request, signal))
  } catch (error) {
    if (!(error instanceof TooManyJobsError)) throw error
    return c.json({ error: 'too_many_pending', message: 'This agent already has several publish requests waiting. Wait for those first.' }, 429)
  }
  return c.json({ proposalId, status: 'pending' }, 202)
})

/** Waits (briefly) for a publish proposal: 202 while it is pending, else its final answer. */
router.post('/wait', zValidator('json', proposalSchema), async (c) => {
  const { proposalId } = c.req.valid('json')
  const outcome = await publishes.wait(proposalId, c.get('callerSlug'), PUBLISH_WAIT_MS, c.req.raw.signal)
  if (!outcome) {
    return c.json({ error: 'unknown_proposal', message: 'No such publish request. It expired or the app restarted; ask again.' }, 404)
  }
  if (outcome.state === 'running') return c.json({ proposalId, status: 'pending' }, 202)
  if (outcome.state === 'failed') return c.json({ error: 'publish_failed', message: 'Publishing failed on the host.' }, 500)
  return c.json(outcome.value.body, outcome.value.status)
})

/** Withdraws a pending publish proposal and its approval card. */
router.post('/cancel', zValidator('json', proposalSchema), (c) => {
  return c.json({ ok: publishes.cancel(c.req.valid('json').proposalId, c.get('callerSlug')) })
})

async function proposePublish(callerSlug: string, request: PublishRequest, signal: AbortSignal): Promise<PublishOutcome> {
  let plan: TeamSkillPublishPlan
  try {
    const skillsets = await getTeamSkillsets()
    // Only the caches, as in search: the plan's name check reads the skillset index.
    await pullSkillsets(skillsets, { maxAgeMs: BACKGROUND_SKILLSET_REFRESH_MAX_AGE_MS })
    plan = await planTeamSkillPublish(callerSlug, request.skillDirectory, skillsets, request.skillsetId)
  } catch (error) {
    // Nothing reaches a person until the host can say what would be published, and where.
    if (error instanceof SkillPublishRefusal) return { status: 422, body: { error: 'cannot_publish', message: error.message } }
    captureException(error, { tags: { component: 'agent-skills', operation: 'publish-plan' } })
    throw error
  }

  let decision: 'allow' | 'deny'
  try {
    const reviews = agentRegistry.get(callerSlug).inputs.reviews
    decision = (await awaitReview(reviews, (raise) => reviews.request({
      accountId: plan.skillsetId,
      toolkit: 'Team skills',
      method: 'PUBLISH',
      targetPath: `team-skills/${plan.skillDirectory}`,
      matchedScopes: [],
      scopeDescriptions: {},
      endpointDescription: plan.updatesPublishedSkill
        ? `Update skill "${plan.skillName}" in ${plan.skillsetName}?`
        : `Publish skill "${plan.skillName}" to ${plan.skillsetName}?`,
      skillPublish: {
        skillName: plan.skillName,
        skillDirectory: plan.skillDirectory,
        skillsetName: plan.skillsetName,
        description: plan.description,
        agentNote: request.note,
        files: plan.files,
        updatesPublishedSkill: plan.updatesPublishedSkill,
      },
    }, raise), { signal })).decision
  } catch {
    return { status: 408, body: { error: 'review_timeout', message: 'Publishing needed approval but nobody decided in time. Nothing was published.' } }
  }
  if (decision === 'deny') {
    return { status: 403, body: { error: 'denied_by_user', message: 'The user rejected publishing this skill. Nothing was published.' } }
  }

  // One audit row for every approved request, whatever came of it: a failure after the
  // skillset took the files must not leave an approved publish with no record.
  let outcome: 'published' | 'not_published' | 'failed' = 'failed'
  try {
    const result = await publishPlannedTeamSkill(callerSlug, plan, await getTeamSkillsets(), { title: request.title, body: request.note })
    outcome = 'published'
    return { status: 200, body: { ok: true, message: result.successMessage, ...(result.prUrl ? { url: result.prUrl } : {}) } }
  } catch (error) {
    if (error instanceof SkillPublishRefusal) {
      outcome = 'not_published'
      return { status: 409, body: { error: 'not_published', message: error.message } }
    }
    captureException(error, { tags: { component: 'agent-skills', operation: 'publish' } })
    const reason = error instanceof Error ? error.message : 'unknown error'
    return {
      status: 500,
      body: {
        error: 'publish_failed',
        message: `Publishing failed after the approval: ${reason}. The skill may have reached the team skillset, so search for it before you ask again.`,
      },
    }
  } finally {
    await logAuditEvent({
      object: 'skill',
      objectId: `${callerSlug}/${plan.skillDirectory}`,
      action: 'exported',
      details: { method: 'publish', skillsetId: plan.skillsetId, title: request.title, by: 'agent', agentSlug: callerSlug, outcome },
    })
  }
}

export default router
