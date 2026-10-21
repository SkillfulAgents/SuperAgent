import path from 'node:path'
import { BaseMountableVolume, type VolumeEntry, type VolumeFile } from './base-mountable-volume'
import { githubBrowseSchema, type GithubVolumeConfig } from './github-schema'
import { githubBranches, githubFolder, githubHead, githubRepo, githubRepos, requireGithubAccount } from './github-client'
import { githubSync } from './github-sync'
import { volumeFolderBrowser } from './volume-folder-browser'
import { volumeUploads } from './volume-upload-guard'

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
  override readonly readOnly: boolean
  readonly sync

  constructor(id: string, name: string, config: GithubVolumeConfig, volumeId = id, private readonly agentSlug = '') {
    super(id, name, config)
    this.sync = githubSync({ id: volumeId, name, config })
    this.readOnly = this.sync.stopped !== null
  }

  override get attention(): string | null { return this.sync.attention }
  override unsynced(): Promise<number | null> { return this.sync.unsynced() }

  override get sourceLabel(): string { return `GitHub · ${this.config.owner}/${this.config.repo}@${this.config.branch}${this.config.path ? `/${this.config.path}` : ''}` }

  async list(name: string): Promise<VolumeEntry[]> {
    await this.sync.fresh()
    await this.sync.ready()
    return this.sync.local.list(name)
  }

  override health(): Promise<VolumeEntry> {
    if (!this.sync.isReady || this.sync.unpushed) this.sync.keepFresh()
    return this.stat('')
  }

  async stat(name: string): Promise<VolumeEntry> {
    await this.sync.ready()
    return this.sync.local.stat(name)
  }

  async read(name: string): Promise<VolumeFile> {
    await this.sync.fresh()
    return this.sync.read(this.id, name)
  }

  async write(name: string, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<void> {
    return volumeUploads.write(JSON.stringify([this.id, name]), body, signal, () => this.sync.write(this.id, this.agentSlug, name, body, signal))
  }

  async delete(name: string): Promise<void> {
    volumeUploads.beforeDelete(JSON.stringify([this.id, name]))
    return this.sync.delete(this.id, this.agentSlug, name)
  }

  mkdir(name: string): Promise<void> { return this.sync.mkdir(name) }
  move(from: string, to: string): Promise<void> { return this.sync.move(this.id, this.agentSlug, from, to) }
}

export async function prepareGithubVolume(config: GithubVolumeConfig, creator?: { userId: string | null }) {
  if (!creator) throw new Error('A volume creator is required')
  await requireGithubAccount(config.accountId, creator)
  const head = await githubHead(config)
  if (config.path) await githubFolder(config, head)
  const repo = await githubRepo(config)
  return { name: path.posix.basename(config.path) || repo.name, config: { ...config, owner: repo.owner.login, repo: repo.name } }
}
