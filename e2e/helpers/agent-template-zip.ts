import fs from 'fs'
import path from 'path'
import { writeZipFile } from '@shared/lib/utils/zip'

export interface BuildAgentTemplateZipOptions {
  /** Agent display name written into CLAUDE.md frontmatter. */
  name: string
  /** When true, include `.claude/skills/agent-onboarding/SKILL.md` so the import is detected as an onboarding template. */
  withOnboardingSkill?: boolean
}

/**
 * Build a minimal agent template .zip on disk and return its path.
 * Caller is responsible for cleanup (write to a tmp dir).
 *
 * Layout when `withOnboardingSkill` is true:
 *   CLAUDE.md
 *   .claude/skills/agent-onboarding/SKILL.md
 */
export async function buildAgentTemplateZip(filePath: string, opts: BuildAgentTemplateZipOptions): Promise<string> {
  const files: Record<string, string> = {
    'CLAUDE.md': `---\nname: ${opts.name}\n---\n\nTest agent template for E2E.\n`,
  }

  if (opts.withOnboardingSkill) {
    files['.claude/skills/agent-onboarding/SKILL.md'] =
      `---\nname: agent-onboarding\ndescription: Helps the user configure a freshly-imported agent.\n---\n\nOnboard the agent.\n`
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  await writeZipFile(filePath, files)
  return filePath
}
