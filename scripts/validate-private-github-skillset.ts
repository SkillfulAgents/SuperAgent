/**
 * Live private-GitHub validation harness.
 *
 * Reads a GitHub token from stdin so it never appears in argv or shell history:
 *   gh auth token | E2E_PRIVATE_SKILLSET_URL=https://github.com/owner/repo \
 *     npx tsx scripts/validate-private-github-skillset.ts
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

async function readTokenFromStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

async function main(): Promise<void> {
  const repoUrl = process.env.E2E_PRIVATE_SKILLSET_URL?.trim()
  if (!repoUrl) throw new Error('E2E_PRIVATE_SKILLSET_URL is required.')

  const token = await readTokenFromStdin()
  if (!token) throw new Error('A GitHub token must be provided on stdin.')

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamut-private-skillset-e2e-'))
  process.env.SUPERAGENT_DATA_DIR = dataDir

  try {
    const settings = await import('../src/shared/lib/config/settings')
    const service = await import('../src/shared/lib/services/skillset-service')

    const skillsetId = service.urlToSkillsetId(repoUrl)
    const credentialId = `skillcred_${crypto.randomUUID()}`
    const credential = {
      id: credentialId,
      type: 'token' as const,
      token,
      tokenPreview: `••••${token.slice(-4)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const initialIndex = await service.validateSkillsetUrl(
      repoUrl,
      'github',
      { type: 'token', token },
    )

    const config = {
      id: skillsetId,
      url: repoUrl,
      name: initialIndex.skillset_name,
      description: initialIndex.description || '',
      addedAt: new Date().toISOString(),
      provider: 'github' as const,
      providerData: { credentialId },
    }

    settings.mutateSettings((current) => {
      current.skillsets = [config]
      current.skillsetCredentials = { [credentialId]: credential }
    })

    // Force a second clone so the persisted opaque reference—not the transient
    // request credential—is what authenticates Git.
    await service.removeSkillsetCache({ skillsetId, provider: 'github', providerData: config.providerData })
    const repoDir = await service.ensureSkillsetCached({
      skillsetId,
      skillsetUrl: repoUrl,
      skillsetName: config.name,
      provider: 'github',
      providerData: config.providerData,
    })
    const refreshedIndex = await service.refreshSkillset({
      skillsetId,
      skillsetUrl: repoUrl,
      skillsetName: config.name,
      provider: 'github',
      providerData: config.providerData,
    })

    const persisted = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')
    const publicConfig = JSON.stringify(config)
    if (publicConfig.includes(token) || repoUrl.includes(token)) {
      throw new Error('Token leaked into public skillset metadata.')
    }

    let localExtraHeader = ''
    try {
      const result = await execFileAsync('git', ['config', '--local', '--get-regexp', 'extraheader'], {
        cwd: repoDir,
        timeout: 5000,
      })
      localExtraHeader = result.stdout.trim()
    } catch {
      // Expected: authentication is process-scoped, not persisted in .git/config.
    }
    if (localExtraHeader) throw new Error('Git authentication header was persisted in .git/config.')
    if (!persisted.includes(token)) throw new Error('Credential was not persisted in the private settings store.')

    const settingsMode = process.platform === 'win32'
      ? null
      : (fs.statSync(path.join(dataDir, 'settings.json')).mode & 0o777).toString(8)

    console.log(JSON.stringify({
      validated: true,
      clonedFromStoredCredential: true,
      refreshed: true,
      skillCount: refreshedIndex.skills.length,
      agentCount: refreshedIndex.agents?.length ?? 0,
      tokenAbsentFromPublicMetadata: true,
      tokenAbsentFromGitConfig: true,
      settingsMode,
    }))
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
    delete process.env.SUPERAGENT_DATA_DIR
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Private GitHub skillset validation failed.')
  process.exitCode = 1
})
