import { FileHook, type FileHookWriteResult } from './file-hook'

const INSTRUCTIONS_PATHS = new Set(['/workspace/AGENTS.md', '/workspace/CLAUDE.md'])
const SKILL_PATH = /^\/workspace\/\.claude\/skills\/[^/]+\/SKILL\.md$/

export const DESCRIPTION_HINT = `Is the agent description up to date? It is the "description" field in the frontmatter of /workspace/AGENTS.md: one sentence on what this agent is for. Other agents and the todo picker read it. If this change alters what the agent does, update it there; otherwise leave it.`

/** Nudges the agent to keep its own description current when it changes its instructions or skills. */
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
