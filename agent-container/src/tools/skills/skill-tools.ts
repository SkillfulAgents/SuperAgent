/**
 * Team skill tools: search the team's skillsets for skills this agent does not have, install
 * one, and ask to publish one of this agent's own. The host owns the skillsets; every tool
 * calls it.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callHost, textResult, XAgentError } from '../agents/host-client'
import { proposeToHost, signalOf } from '../host-proposals'

const searchResponseSchema = z.object({
  skills: z.array(z.object({
    skillsetId: z.string(),
    skillsetName: z.string(),
    name: z.string(),
    description: z.string(),
    version: z.string(),
    path: z.string(),
  })),
  total: z.number(),
})

const installResponseSchema = z.object({ name: z.string(), directory: z.string() })

const errorText = (error: unknown) => (error instanceof XAgentError ? error.message : String(error))

export const searchTeamSkillsTool = tool(
  'search_team_skills',
  `Search the skills your team has published for skills this agent has not installed. Use it before you write a new skill. Pass a few keywords, or no query to list every available skill. Install a result with install_team_skill.`,
  {
    query: z.string().optional().describe('Keywords to match against skill names and descriptions. Omit to list all.'),
  },
  async ({ query }) => {
    try {
      const data = await callHost('skills/search', query ? { query } : {}, searchResponseSchema)
      if (data.skills.length === 0) {
        return textResult(query
          ? `No team skill matches "${query}". Call with no query to list all.`
          : 'The team has no published skill that this agent does not already have.')
      }
      const lines = data.skills.flatMap((skill) => [
        `- ${skill.name} v${skill.version} (skillset: ${skill.skillsetName}) - ${skill.description}`,
        `  skillset_id: ${skill.skillsetId}, skill_path: ${skill.path}`,
      ])
      const shown = data.total > data.skills.length
        ? `Showing ${data.skills.length} of ${data.total} skills. Add keywords to narrow the list.`
        : `Found ${data.total} skill(s).`
      return textResult(`${shown}\n\n${lines.join('\n')}\n\nInstall one with install_team_skill.`)
    } catch (error) {
      return textResult(`Failed to search team skills: ${errorText(error)}`, true)
    }
  },
)

export const installTeamSkillTool = tool(
  'install_team_skill',
  `Install a skill found by search_team_skills into this agent's /workspace/.claude/skills. Pass skillset_id and skill_path exactly as search_team_skills returned them.`,
  {
    skillset_id: z.string().describe('The skillset_id of the search_team_skills result'),
    skill_path: z.string().describe('The skill_path of the search_team_skills result'),
  },
  async ({ skillset_id, skill_path }) => {
    try {
      const data = await callHost('skills/install', { skillsetId: skillset_id, skillPath: skill_path }, installResponseSchema)
      const skillFile = `/workspace/.claude/skills/${data.directory}/SKILL.md`
      return textResult(`Installed "${data.name}". Read ${skillFile} and follow it.`)
    } catch (error) {
      return textResult(`Failed to install team skill: ${errorText(error)}`, true)
    }
  },
)

export const publishTeamSkillTool = tool(
  'publish_team_skill',
  `Ask to publish a skill from this agent's /workspace/.claude/skills to the team's skillset, so teammates' agents can install it. Use it for a skill you wrote, or for changes you made to a skill installed from the team. The user sees an approval card with the skill's description and files, and this call waits until they decide (up to 5 minutes). Nothing is published without their approval. Call it once per skill.`,
  {
    skill: z.string().describe('The skill directory name under /workspace/.claude/skills'),
    title: z.string().describe('A short title for this publish'),
    note: z.string().describe('What the skill does or what changed, and why teammates would want it'),
    skillset_id: z.string().optional().describe('Only when the team has several skillsets; the error lists them'),
  },
  async ({ skill, title, note, skillset_id }, extra) => {
    const result = await proposeToHost(
      'skills',
      'publish',
      { skillDirectory: skill, title, note, ...(skillset_id ? { skillsetId: skillset_id } : {}) },
      signalOf(extra),
    )
    const data = result.data as { message?: string; error?: string; url?: string } | null
    const text = data?.message ?? data?.error ?? `HTTP ${result.status}`
    if (!result.ok) return textResult(`Not published: ${text}`, true)
    return textResult(data?.url ? `${text} ${data.url}` : text)
  },
)
