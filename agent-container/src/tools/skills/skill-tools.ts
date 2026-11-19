/**
 * Team skill tools: search the team's skillsets for skills this agent does not have, and
 * install one. The host owns the skillsets; both tools call it.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callHost, textResult, XAgentError } from '../agents/host-client'

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
