import path from 'node:path'
import { BaseMountableVolume, type VolumeEntry, type VolumeFile } from './base-mountable-volume'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { githubBrowseSchema, type GithubVolumeConfig } from './github-schema'
import { githubBranches, githubFolder, githubHead, githubRepo, githubRepos, requireGithubAccount } from './github-client'
import { githubSync } from './github-sync'
import { volumeFolderBrowser } from './volume-folder-browser'

export class GithubMountableVolume extends BaseMountableVolume<GithubVolumeConfig> {
  static readonly browseFolders = volumeFolderBrowser(githubBrowseSchema, async (query, viewer) => {
    await requireGithubAccount(query.accountId, viewer)
    if (query.repoId === undefined) {
      return { folders: (await githubRepos(query.accountId)).map(repo => ({ id: String(repo.id), name: `${repo.owner.login}/${repo.name}` })) }
    }
    if (!query.branch) return { folders: (await githubBranches({ accountId: query.accountId, repoId: query.repoId })).map(branch => ({ id: branch.name, name: branch.name })) }
    const config = { accountId: query.accountId, repoId: query.repoId, branch: query.branch, path: query.path ?? '' }
    const head = await githubHead(config)
    const entries = await githubFolder(config, head)
    return { folders: entries.filter(entry => entry.type === 'tree')
      .map(entry => ({ id: entry.path, name: path.posix.basename(entry.path) })) }
  })

  readonly type = 'github'
  readonly cacheMode = 'local'
  readonly readOnly = true
  readonly sync

  constructor(id: string, name: string, config: GithubVolumeConfig, volumeId = id) {
    super(id, name, config)
    this.sync = githubSync({ id: volumeId, name, config })
  }

  override get sourceLabel(): string { return `GitHub · ${this.config.owner}/${this.config.repo}@${this.config.branch}${this.config.path ? `/${this.config.path}` : ''}` }

  async list(name: string): Promise<VolumeEntry[]> {
    this.sync.keepFresh()
    await this.sync.ready()
    return this.sync.local.list(name)
  }

  override health(): Promise<VolumeEntry> {
    if (!this.sync.isReady) this.sync.keepFresh()
    return this.stat('')
  }

  async stat(name: string): Promise<VolumeEntry> {
    await this.sync.ready()
    return this.sync.local.stat(name)
  }

  async read(name: string): Promise<VolumeFile> {
    this.sync.keepFresh()
    await this.sync.ready()
    return this.sync.local.read(name)
  }

  async write(_name: string, body: ReadableStream<Uint8Array>): Promise<void> {
    await body.cancel().catch(() => {})
    return refuseMutation()
  }

  async delete(_name: string): Promise<void> { return refuseMutation() }
  async mkdir(_name: string): Promise<void> { return refuseMutation() }
  async move(_from: string, _to: string): Promise<void> { return refuseMutation() }
}

export async function prepareGithubVolume(config: GithubVolumeConfig, creator?: { userId: string | null }) {
  if (!creator) throw new Error('A volume creator is required')
  await requireGithubAccount(config.accountId, creator)
  const head = await githubHead(config)
  if (config.path) await githubFolder(config, head)
  const repo = await githubRepo(config)
  return { name: path.posix.basename(config.path) || repo.name, config: { ...config, owner: repo.owner.login, repo: repo.name } }
}

function refuseMutation(): never {
  throw new WorkspaceFileError('not-accessible', 'GitHub drives are read-only')
}
