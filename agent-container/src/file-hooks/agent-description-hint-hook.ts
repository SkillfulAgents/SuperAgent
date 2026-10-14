import { FileHook, type FileHookWriteResult } from './file-hook'

const INSTRUCTIONS_PATHS = new Set(['/workspace/AGENTS.md', '/workspace/CLAUDE.md'])
const SKILL_PATH = /^\/workspace\/\.claude\/skills\/[^/]+\/SKILL\.md$/

export const DESCRIPTION_HINT = `Are the agent name and description up to date? They are the "name" and "description" fields in the frontmatter of /workspace/AGENTS.md. The description is one sentence on what this agent is for; other agents and the todo picker read it. If this change alters what the agent does, update it; otherwise leave it. Change the name only if the user asked for a new name or the current one is a placeholder such as "Untitled".`

/** Nudges the agent to keep its own name and description current when it changes its instructions or skills. */
export class AgentDescriptionHintFileHook extends FileHook {
  pattern(): string {
    return '/workspace/AGENTS.md, /workspace/.claude/skills/*/SKILL.md'
  }

  matches(filePath: string): boolean {
    return INSTRUCTIONS_PATHS.has(filePath) || SKILL_PATH.test(filePath)
  }

  onWrite(): FileHookWriteResult {
    return { warning: DESCRIPTION_HINT }
  }

  onEdit(): FileHookWriteResult {
    return { warning: DESCRIPTION_HINT }
  }
}
