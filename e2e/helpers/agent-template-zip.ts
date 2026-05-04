import AdmZip from 'adm-zip'
import fs from 'fs'
import path from 'path'

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
export function buildAgentTemplateZip(filePath: string, opts: BuildAgentTemplateZipOptions): string {
  const zip = new AdmZip()

  zip.addFile(
    'CLAUDE.md',
    Buffer.from(`---\nname: ${opts.name}\n---\n\nTest agent template for E2E.\n`, 'utf-8'),
  )

  if (opts.withOnboardingSkill) {
    zip.addFile(
      '.claude/skills/agent-onboarding/SKILL.md',
      Buffer.from(
        `---\nname: agent-onboarding\ndescription: Helps the user configure a freshly-imported agent.\n---\n\nOnboard the agent.\n`,
        'utf-8',
      ),
    )
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  zip.writeZip(filePath)
  return filePath
}
