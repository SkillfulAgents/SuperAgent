import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { BaseMountableVolume, type VolumeEntry, type VolumeFile } from './base-mountable-volume'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { dropboxRequest, requireDropboxAccount, withDropboxAccount, type DropboxEndpoint } from './dropbox-client'
import { dropboxBrowseSchema, dropboxListSchema, dropboxMetadataSchema, dropboxSessionSchema, type DropboxList, type DropboxMetadata, type DropboxVolumeConfig } from './dropbox-schema'
import { dropboxReadCache } from './dropbox-read-cache'
import { dropboxHealthCache } from './dropbox-health-cache'
import { DropboxUnavailableError } from './dropbox-error'
import { volumeFolderBrowser } from './volume-folder-browser'
import { serialize } from './remote-listing-cache'
import { uploadChunks, throwIfUploadAborted } from './remote-transfer'
import { guardDelete, guardedUpload } from './guarded-upload'
import { rangedVolumeFile } from './remote-file'

// Platform's Composio route accepts at most 1,000,000 bytes of JSON. Binary
// bodies expand by 4/3 in base64; 512 KiB leaves room for the request envelope,
// escaped paths and headers. The generic raw-binary limit is too large here.
export const DROPBOX_UPLOAD_CHUNK_BYTES = 512 * 1024

/** Serialize namespace commits across overlapping mounts. Body reads and upload
 * staging never hold this lock; Dropbox locks the namespace only at commit too. */
function mutate<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
  return serialize([`dropbox-commit:${accountId}`], operation)
}

/** Invalid upstream JSON is an availability error, not invalid user input. */
async function json<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  try { return schema.parse(await response.json()) } catch { throw new DropboxUnavailableError() }
}

function entryOf(metadata: DropboxMetadata, name = metadata.name): VolumeEntry {
  return metadata['.tag'] === 'folder'
    ? { name, kind: 'directory', size: 0, mtimeMs: 0 }
    : { name, kind: 'file', size: metadata.size, mtimeMs: Date.parse(metadata.server_modified) }
}

export class DropboxMountableVolume extends BaseMountableVolume<DropboxVolumeConfig> {
  static readonly browseFolders = volumeFolderBrowser(dropboxBrowseSchema, async (config, viewer) => {
    await requireDropboxAccount(config.accountId, viewer)
    const entries = await new DropboxMountableVolume('', '', config).list('')
    return { folders: entries.filter(entry => entry.kind === 'directory').map(entry => ({
      id: `${config.path}/${entry.name}`, name: entry.name,
    })) }
  })

  readonly type = 'dropbox'
  readonly cacheMode = 'remote'
  readonly caseInsensitive = true

  constructor(id: string, name: string, config: DropboxVolumeConfig, private readonly agentSlug?: string) {
    super(id, name, config)
  }

  get sourceLabel(): string {
    return `Dropbox · ${this.config.path || '/'}`
  }

  private remotePath(relative: string): string {
    if (relative && relative.split('/').some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part))) {
      throw new WorkspaceFileError('invalid-path')
    }
    return this.config.path + (relative ? `/${relative}` : '')
  }

  private writablePath(relative: string): string {
    if (!relative) throw new WorkspaceFileError('invalid-path', 'The volume root cannot be made, replaced, removed or moved')
    return this.remotePath(relative)
  }

  private request(endpoint: DropboxEndpoint, args: unknown, bytes?: ArrayBuffer, range?: string, signal?: AbortSignal) {
    return dropboxRequest(this.config.accountId, endpoint, args, { agentSlug: this.agentSlug, bytes, range, signal })
  }

  private async metadata(relative: string): Promise<DropboxMetadata> {
    return json(await this.request('get_metadata', { path: this.remotePath(relative) }), dropboxMetadataSchema)
  }

  private async existingFile(relative: string) {
    const metadata = await this.metadata(relative).catch(error => {
      if (error instanceof WorkspaceFileError && error.code === 'not-found') return null
      throw error
    })
    if (metadata?.['.tag'] === 'folder') throw new WorkspaceFileError('not-a-file')
    return metadata
  }

  private async parentOf(relative: string): Promise<void> {
    const parent = path.posix.dirname(relative)
    if ((await this.statFresh(parent === '.' ? '' : parent)).kind !== 'directory') throw new WorkspaceFileError('not-a-directory')
  }

  private async* pages(remotePath: string): AsyncGenerator<DropboxList> {
    let page = await json(await this.request('list_folder', {
      path: remotePath, recursive: false, limit: 2000, include_deleted: false, include_non_downloadable_files: true,
    }), dropboxListSchema)
    yield page
    while (page.has_more) {
      page = await json(await this.request('list_folder/continue', { cursor: page.cursor }), dropboxListSchema)
      yield page
    }
  }

  private async listFresh(relative: string): Promise<DropboxMetadata[]> {
    const entries = new Map<string, DropboxMetadata>()
    // A cursor is a change stream, not an immutable snapshot. Apply pages in
    // order, removing tombstones and replacing repeated/case-aliased entries.
    // Listings are nonrecursive, so each key names one immediate child.
    for await (const page of this.pages(this.remotePath(relative))) {
      for (const entry of page.entries) {
        const key = entry.name.toLowerCase()
        if (entry['.tag'] === 'deleted') entries.delete(key)
        else entries.set(key, entry)
      }
    }
    return [...entries.values()]
  }

  async list(relative: string): Promise<VolumeEntry[]> {
    const remote = this.remotePath(relative)
    // Cache hits must not outlive deletion/revocation of the connected account.
    return withDropboxAccount(this.config.accountId, async () =>
      (await dropboxReadCache.list(this.config.accountId, this.config.path, remote, () => this.listFresh(relative)))
        .map(metadata => entryOf(metadata)))
  }

  private async statFresh(relative: string): Promise<VolumeEntry> {
    if (this.remotePath(relative) === '') {
      // Dropbox get_metadata does not accept the account root. A small listing
      // probes its accessibility without enumerating the account for each stat.
      await json(await this.request('list_folder', { path: '', limit: 1, recursive: false }), dropboxListSchema)
      return { name: '', kind: 'directory', size: 0, mtimeMs: 0 }
    }
    return entryOf(await this.metadata(relative), path.posix.basename(relative))
  }

  async stat(relative: string): Promise<VolumeEntry> {
    const remote = this.remotePath(relative)
    return withDropboxAccount(this.config.accountId, async () => {
      const metadata = relative && dropboxReadCache.metadata(this.config.accountId, this.config.path, remote)
      // Folder metadata saves one call per directory walk. File sizes/revisions
      // must be fresh, just as they are for GET/HEAD, after an external edit.
      if (metadata && metadata['.tag'] === 'folder') return entryOf(metadata, path.posix.basename(relative))
      return this.statFresh(relative)
    })
  }

  override async health(): Promise<VolumeEntry> {
    return withDropboxAccount(this.config.accountId, account => dropboxHealthCache.check(
      this.config.accountId, this.config.path.toLowerCase(), account.updatedAt?.getTime() ?? 0, () => this.statFresh(''),
    ))
  }

  async read(relative: string): Promise<VolumeFile> {
    if (!relative) throw new WorkspaceFileError('not-a-file')
    const metadata = await withDropboxAccount(this.config.accountId, () => this.metadata(relative))
    if (metadata['.tag'] !== 'file') throw new WorkspaceFileError('not-a-file')
    if (metadata.is_downloadable === false || metadata.symlink_info) throw new WorkspaceFileError('not-accessible')
    return rangedVolumeFile(metadata.size, async ({ start, end }) =>
      this.request('download', { path: `rev:${metadata.rev}` }, undefined, `bytes=${start}-${end}`))
  }

  async write(relative: string, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<void> {
    return guardedUpload(this.agentSlug, this.uploadKey(relative), body, signal, async () => {
      const target = this.writablePath(relative)
      await withDropboxAccount(this.config.accountId, async () => {
        const previous = await this.existingFile(relative)
        const commit = {
          path: target, mode: previous ? { '.tag': 'update', update: previous.rev } : 'add',
          autorename: false, strict_conflict: true,
        }
        const chunks = uploadChunks(body, DROPBOX_UPLOAD_CHUNK_BYTES, signal)
        try {
          const first = await chunks.next()
          let next = await chunks.next()
          let session: { session_id: string; offset: number } | undefined
          if (!next.done) {
            const { session_id } = await json(await this.request('upload_session/start', { close: false }, first.value, undefined, signal), dropboxSessionSchema)
            session = { session_id, offset: first.value!.byteLength }
            do {
              throwIfUploadAborted(signal)
              const response = await this.request('upload_session/append_v2', { cursor: session, close: false }, next.value, undefined, signal)
              await response.body?.cancel()
              session.offset += next.value.byteLength
              next = await chunks.next()
            } while (!next.done)
          }
          await this.change([target], settle => withDropboxAccount(this.config.accountId, async () => {
            throwIfUploadAborted(signal)
            await this.parentOf(relative)
            throwIfUploadAborted(signal)
            const response = session
              ? await this.request('upload_session/finish', { cursor: session, commit }, undefined, undefined, signal)
              : await this.request('upload', commit, first.value ?? new ArrayBuffer(0), undefined, signal)
            const stored = await json(response, dropboxMetadataSchema)
            if (signal?.aborted && !previous && stored['.tag'] === 'file') {
              // Only our just-created revision can be removed, never a newer edit.
              await (await this.request('delete_v2', { path: target, parent_rev: stored.rev })).body?.cancel()
              throwIfUploadAborted(signal)
            }
            settle(target, stored)
          }, true))
        } finally { await chunks.return(undefined) }
      })
    })
  }

  private uploadKey(relative: string): string {
    return JSON.stringify([this.id, relative.toLowerCase()])
  }

  private change<T>(paths: string[], operation: (settle: (path: string, entry: DropboxMetadata | null) => void) => Promise<T>): Promise<T> {
    return mutate(this.config.accountId, async () => {
      dropboxHealthCache.invalidate(this.config.accountId)
      try { return await dropboxReadCache.change(this.config.accountId, paths, operation) }
      finally { dropboxHealthCache.invalidate(this.config.accountId) }
    })
  }

  async mkdir(relative: string): Promise<void> {
    const target = this.writablePath(relative)
    await this.change([target], settle => withDropboxAccount(this.config.accountId, async () => {
      await this.parentOf(relative)
      const response = await this.request('create_folder_v2', { path: target, autorename: false })
      const { metadata } = await json(response, z.object({ metadata: dropboxMetadataSchema }))
      settle(target, metadata)
    }))
  }

  async delete(relative: string): Promise<void> {
    const target = this.writablePath(relative)
    await guardDelete(this.agentSlug, this.uploadKey(relative))
    await this.change([target], settle => withDropboxAccount(this.config.accountId, async () => {
      const metadata = await this.metadata(relative)
      // Dropbox delete is recursive. Never intentionally send it a full folder.
      if (metadata['.tag'] === 'folder' && (await this.listFresh(relative)).length) throw new WorkspaceFileError('not-empty')
      const response = await this.request('delete_v2', {
        path: target, ...(metadata['.tag'] === 'file' ? { parent_rev: metadata.rev } : {}),
      })
      await response.body?.cancel()
      settle(target, null)
    }))
  }

  async move(from: string, to: string): Promise<void> {
    const source = this.writablePath(from)
    const target = this.writablePath(to)
    await this.change([source, target], settle => withDropboxAccount(this.config.accountId, async () => {
      const metadata = await this.metadata(from)
      if (from === to) return
      if (metadata['.tag'] === 'folder' && to.toLowerCase().startsWith(`${from.toLowerCase()}/`)) throw new WorkspaceFileError('invalid-path')
      await this.parentOf(to).catch(error => {
        if (error instanceof WorkspaceFileError && error.code === 'not-found') throw new WorkspaceFileError('not-a-directory')
        throw error
      })
      const destination = await this.metadata(to).catch(error => {
        if (error instanceof WorkspaceFileError && error.code === 'not-found') return null
        throw error
      })
      const relocate = async (fromPath: string, toPath: string) => {
        const response = await this.request('move_v2', { from_path: fromPath, to_path: toPath, autorename: false })
        await response.body?.cancel()
      }
      if (!destination || destination.id === metadata.id) {
        // Includes case-only renames on Dropbox's case-insensitive namespace.
        await relocate(source, target)
        settle(source, null)
        settle(target, { ...metadata, name: path.posix.basename(target) })
        return
      }
      // Only replace a regular file with another file; never recursively delete
      // an occupied folder. Preserve the old file until the new move succeeds.
      if (metadata['.tag'] !== 'file' || destination['.tag'] !== 'file') throw new WorkspaceFileError('already-exists')
      const backup = path.posix.join(path.posix.dirname(target), `.gamut-rename-${randomUUID()}`)
      await relocate(target, backup)
      try {
        await relocate(source, target)
      } catch (error) {
        try { await relocate(backup, target) } catch {
          // An external writer or an ambiguous network result can occupy target.
          // Keep the backup rather than overwrite it during rollback.
          if (error instanceof Error) {
            error.message += ` The previous destination is preserved at ${backup}`
            throw error
          }
          throw new Error(`Dropbox rename failed; the previous destination is preserved at ${backup}`, { cause: error })
        }
        throw error
      }
      settle(source, null)
      settle(target, { ...metadata, name: path.posix.basename(target) })
      try {
        const response = await this.request('delete_v2', { path: backup, parent_rev: destination.rev })
        await response.body?.cancel()
      } catch {
        // The rename succeeded. A cleanup failure must not replay it or delete
        // another client's edit to the backup; leave that file recoverable.
        settle(backup, { ...destination, name: path.posix.basename(backup) })
        console.warn(`[volumes] Dropbox rename succeeded; retained backup at ${backup}`)
      }
    }))
  }
}

export async function prepareDropboxVolume(config: DropboxVolumeConfig, creator?: { userId: string | null }) {
  if (!creator) throw new Error('A volume creator is required')
  await requireDropboxAccount(config.accountId, creator)
  const volume = new DropboxMountableVolume('', '', config)
  if ((await volume.stat('')).kind !== 'directory') throw new WorkspaceFileError('not-a-directory', 'Select a Dropbox folder')
  return { name: path.posix.basename(config.path) || 'Dropbox', config }
}
