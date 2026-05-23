import fs from 'fs'
import path from 'path'
import { writeZipFile } from '@shared/lib/utils/zip'

export interface BuildSkillZipOptions {
  name: string
  withEnvVars?: boolean
  extraFiles?: Record<string, string>
}

export async function buildSkillZip(filePath: string, opts: BuildSkillZipOptions): Promise<string> {
  const envVarsBlock = opts.withEnvVars
    ? `  required_env_vars:\n    - name: E2E_TEST_KEY\n      description: A test key\n`
    : ''

  const files: Record<string, string> = {
    'SKILL.md': `---\nname: ${opts.name}\nmetadata:\n  version: "1.0.0"\n${envVarsBlock}---\n\nTest skill for E2E.\n`,
    ...opts.extraFiles,
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  await writeZipFile(filePath, files)
  return filePath
}
