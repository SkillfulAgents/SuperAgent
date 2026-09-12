/**
 * Cold skillset unpack + template install under the NFS shim.
 * Wall budgets are the onboarding targets at BUDGET_LATENCY_MS (10 ms/op).
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { createZipBuffer } from '@shared/lib/utils/zip'
import { extractZipToDir } from '@shared/lib/skillset-provider/public-provider'
import { expectWithinBudget, measure } from './harness'

const EXTRACT_ENTRIES = 770
const INSTALL_FILES = 40

function buildExtractZip(): Promise<Buffer> {
  const files: Record<string, string> = {}
  for (let i = 0; i < EXTRACT_ENTRIES; i++) {
    const name = `file-${String(i).padStart(4, '0')}.txt`
    files[`owner-repo-abc123/${name}`] = `entry-${i}\n`
  }
  return createZipBuffer(files)
}

describe('skillset install', () => {
  let dataDir: string
  let extractZip: Buffer
  let previousDataDir: string | undefined
  let installAgentFromSkillset: typeof import('@shared/lib/services/agent-template-service').installAgentFromSkillset
  let getSkillsetRepoDir: typeof import('@shared/lib/services/skillset-service').getSkillsetRepoDir

  beforeAll(async () => {
    previousDataDir = process.env.SUPERAGENT_DATA_DIR
    dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'superagent-perf-skillset-'))
    process.env.SUPERAGENT_DATA_DIR = dataDir
    extractZip = await buildExtractZip()
    ;({ installAgentFromSkillset } = await import('@shared/lib/services/agent-template-service'))
    ;({ getSkillsetRepoDir } = await import('@shared/lib/services/skillset-service'))
  })

  afterAll(async () => {
    if (previousDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = previousDataDir
    await fs.promises.rm(dataDir, { recursive: true, force: true })
  })

  it('extracts a 770-entry zip within the catalog budget', async () => {
    const dest = path.join(dataDir, 'extract-dest')
    const { measurement } = await measure(() => extractZipToDir(extractZip, dest))
    expectWithinBudget('skillset extractZipToDir', measurement, {
      totalOps: 10_000,
      wallMs: 1500,
    })
  })

  it('installs from a seeded cache within the install budget', async () => {
    const skillsetId = 'perf-skillset'
    const agentPath = 'agents/perf-template/'
    const repoDir = getSkillsetRepoDir(skillsetId)
    const templateDir = path.join(repoDir, 'agents', 'perf-template')
    await fs.promises.mkdir(templateDir, { recursive: true })
    await fs.promises.writeFile(
      path.join(templateDir, 'CLAUDE.md'),
      '---\nname: Perf Template\n---\n# Perf\n',
      'utf-8',
    )
    for (let i = 0; i < INSTALL_FILES; i++) {
      await fs.promises.writeFile(
        path.join(templateDir, `skill-${String(i).padStart(2, '0')}.md`),
        `# skill ${i}\n`,
        'utf-8',
      )
    }
    await fs.promises.writeFile(
      path.join(repoDir, '.skillset-cache-meta.json'),
      JSON.stringify({ provider: 'public', cachedAt: new Date().toISOString() }),
      'utf-8',
    )

    const { measurement } = await measure(() =>
      installAgentFromSkillset(
        {
          skillsetId,
          skillsetUrl: 'https://github.com/example/perf-skillset',
          provider: 'public',
          skillsetName: 'Perf',
        },
        agentPath,
        'Perf Agent',
        '1.0.0',
      ),
    )
    expectWithinBudget('skillset installAgentFromSkillset', measurement, {
      totalOps: 10_000,
      wallMs: 500,
    })
  })
})
