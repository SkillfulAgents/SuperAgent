import fs from 'fs'
import path from 'path'
import { validateAgentTemplate, MAX_COMPRESSED_SIZE } from '@shared/lib/services/agent-template-service'
import { validateSkillZip, SKILL_MAX_COMPRESSED_SIZE } from '@shared/lib/services/skillset-service'
import { SKILL_PACKAGE_EXTENSION, type ClassifiedImportPackage } from '@shared/lib/utils/package-extensions'

export type { ClassifiedImportPackage }

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/**
 * Classify an opened .agent/.skill package straight from disk, in the main
 * process — the bytes never cross to the renderer just to answer "agent or
 * skill?". Routing is content-based (root CLAUDE.md → agent template, root
 * SKILL.md → skill); the extension only ORDERS the validators, so the right
 * diagnostic surfaces for a broken package and a pathological zip carrying
 * both root markers resolves to what its name claims. A renamed file still
 * imports as what its content says it is.
 *
 * Size limits are enforced here, per kind, so the user is told "too large"
 * before picking a target agent rather than after (the skill cap is far
 * smaller than the template cap).
 */
export async function classifyImportPackage(filePath: string): Promise<ClassifiedImportPackage> {
  const base = { path: filePath, fileName: path.basename(filePath) }
  try {
    const skillFirst = base.fileName.toLowerCase().endsWith(SKILL_PACKAGE_EXTENSION)
    const stat = await fs.promises.stat(filePath)
    if (stat.size > MAX_COMPRESSED_SIZE) {
      // Over every cap — reject before reading anything. Quote the cap for
      // the kind the file claims to be, so a huge .skill isn't told "max
      // 500MB" only to hit the real 100MB skill cap after trimming.
      const cap = skillFirst ? SKILL_MAX_COMPRESSED_SIZE : MAX_COMPRESSED_SIZE
      return { ...base, error: `File too large (${formatMb(stat.size)}, max ${cap / 1024 / 1024}MB)` }
    }
    const buffer = await fs.promises.readFile(filePath)

    // Each attempt returns a final result (classified) or a diagnostic string
    // meaning "not this kind — try the other".
    const asTemplate = async (): Promise<ClassifiedImportPackage | string> => {
      const result = await validateAgentTemplate(buffer)
      if (!result.valid) return result.error ?? 'Invalid agent template'
      return { ...base, kind: 'agent-template', name: result.agentName ?? null }
    }
    const asSkill = async (): Promise<ClassifiedImportPackage | string> => {
      // Checked before validating: an over-cap file can never import as a
      // skill, so the full zip walk would be wasted work. A diagnostic (not a
      // hard error) so an oversized agent template renamed .skill still
      // classifies by its content.
      if (buffer.length > SKILL_MAX_COMPRESSED_SIZE) {
        return `Skill packages are limited to ${SKILL_MAX_COMPRESSED_SIZE / 1024 / 1024}MB (this file is ${formatMb(buffer.length)})`
      }
      const result = await validateSkillZip(buffer)
      if (!result.valid) return result.error ?? 'Invalid skill package'
      return { ...base, kind: 'skill', name: result.skillName ?? null }
    }

    let firstDiagnostic: string | undefined
    for (const attempt of skillFirst ? [asSkill, asTemplate] : [asTemplate, asSkill]) {
      const result = await attempt()
      if (typeof result !== 'string') return result
      firstDiagnostic ??= result
    }
    return { ...base, error: `Not a recognizable agent template or skill package. ${firstDiagnostic ?? ''}`.trim() }
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : 'Failed to read package file' }
  }
}
