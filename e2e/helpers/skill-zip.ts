import fs from 'fs'
import path from 'path'
import { writeZipFile } from '@shared/lib/utils/zip'

export interface BuildSkillZipOptions {
  name: string
  extraFiles?: Record<string, string>
}

export async function buildSkillZip(filePath: string, opts: BuildSkillZipOptions): Promise<string> {
  const files: Record<string, string> = {
    'SKILL.md': `---\nname: ${opts.name}\nmetadata:\n  version: "1.0.0"\n---\n\nTest skill for E2E.\n`,
    ...opts.extraFiles,
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  await writeZipFile(filePath, files)
  return filePath
}
