import path from 'node:path'
import type { z } from 'zod'
import { BaseMountableVolume, type VolumeEntry, type VolumeFile } from './base-mountable-volume'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { DriveExportTooLargeError, driveRequest, driveUpload, requireGoogleDriveAccount, type DriveRequest } from './google-drive-client'
import pLimit from 'p-limit'
import { DRIVE_FILE_FIELDS, FOLDER_MIME_TYPE, SHORTCUT_MIME_TYPE, driveFileListSchema, driveFileSchema, driveListSchema, driveSchema, type DriveFile, type GoogleDriveVolumeConfig } from './google-drive-schema'
import { googleDriveExportCache, type Export } from './google-drive-export-cache'
import { driveNameOf, folderView, isExport, isFolder, nameTaken, ownId, writeTarget, type VisibleEntry } from './google-drive-folder-view'
import { RemoteListingCache, serialize } from './remote-listing-cache'
import type { ByteRange } from '@shared/lib/agent-actor/types'

/** A file of a known size whose bytes come from `download`, a fetch of one byte range. The
 * download starts before WebDAV sends headers, so an upstream failure keeps its status. The
 * stream honors the range even when upstream ignores it, and fails rather than serve a cut or
 * mismatched file. */
function rangedVolumeFile(size: number, download: (range: ByteRange) => Promise<Response>): VolumeFile {
  let used = false
  return {
    size,
    close: async () => { used = true },
    stream: async range => {
      if (used) throw new Error('Volume file has already been consumed')
      used = true
      const start = range?.start ?? 0
      const end = range?.end ?? size - 1
      let remaining = Math.max(0, end - start + 1)
      const response = remaining ? await download({ start, end }) : null
      if (response?.status === 206 && response.headers.get('content-range') !== `bytes ${start}-${end}/${size}`) {
        await response.body?.cancel()
        throw new Error('File download returned an unexpected byte range')
      }
      let skip = response?.status === 206 ? 0 : start
      const reader = response?.body?.getReader()
      if (remaining && !reader) throw new Error('File download returned no content')
      return new ReadableStream<Uint8Array>({
        pull: async controller => {
          if (!remaining) { controller.close(); return }
          while (reader) {
            const { value, done } = await reader.read()
            if (done) throw new Error('File download ended early')
            const skipped = Math.min(skip, value.length)
            skip -= skipped
            const available = value.subarray(skipped)
            const bytes = available.subarray(0, remaining)
            if (!bytes.length) continue
            // A range reaching the end must find no further bytes, or the file is longer than listed.
            // Check before the last bytes go out, so a reader never sees a complete-looking cut file.
            if (end === size - 1 && bytes.length === remaining && (available.length > remaining || !(await reader.read()).done)) {
              throw new Error('File download returned more than its listed size')
            }
            remaining -= bytes.length
            controller.enqueue(bytes)
            if (!remaining) {
              await reader.cancel()
              controller.close()
            }
            return
          }
        },
        cancel: async () => { await reader?.cancel() },
      })
    },
  }
}

/** Raw children by account and folder ID, so overlapping volumes share listings. */
export const googleDriveListingCache = new RemoteListingCache<DriveFile>()
const keyOf = (accountId: string, folderId: string) => JSON.stringify([accountId, folderId])

/** Every page of a Drive listing. */
export async function drivePages<T extends { nextPageToken?: string }>(
  accountId: string, requestPath: string, query: Record<string, string>, schema: z.ZodType<T>, agentSlug?: string,
): Promise<T[]> {
  const pages: T[] = []
  let pageToken: string | undefined
  do {
    const response = await driveRequest(accountId, { method: 'GET', path: requestPath, query: { ...query, ...(pageToken ? { pageToken } : {}) } }, { agentSlug })
    const page = schema.parse(await response.json())
    pages.push(page)
    pageToken = page.nextPageToken
  } while (pageToken)
  return pages
}

/** A folder's raw children, every page, as Drive lists them. */
export async function driveChildren(accountId: string, folderId: string, options: { agentSlug?: string; foldersOnly?: boolean } = {}): Promise<DriveFile[]> {
  const q = `'${folderId}' in parents and trashed = false${options.foldersOnly ? ` and mimeType = '${FOLDER_MIME_TYPE}'` : ''}`
  const pages = await drivePages(accountId, 'drive/v3/files', {
    q, pageSize: '1000', includeItemsFromAllDrives: 'true', fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
  }, driveFileListSchema, options.agentSlug)
  return pages.flatMap(page => page.files)
}

/** The picker's top level: My Drive and each shared drive. */
export async function driveTopLevel(accountId: string): Promise<{ id: string; name: string }[]> {
  const [root, pages] = await Promise.all([
    driveRequest(accountId, { method: 'GET', path: 'drive/v3/files/root', query: { fields: DRIVE_FILE_FIELDS } }).then(async response => driveFileSchema.parse(await response.json())),
    drivePages(accountId, 'drive/v3/drives', { pageSize: '100' }, driveListSchema),
  ])
  return [{ id: root.id, name: root.name }, ...pages.flatMap(page => page.drives)]
}

/** A visible entry and the folder it was found in. */
interface Located {
  parentId: string
  entry: VisibleEntry
}

export class GoogleDriveMountableVolume extends BaseMountableVolume<GoogleDriveVolumeConfig> {
  readonly type = 'googledrive'
  readonly cacheMode = 'remote'
  // A Google file saved as .md, .xlsx or .pptx is stored as the Google file, at its export size.
  readonly ignoreSize = true

  constructor(id: string, name: string, config: GoogleDriveVolumeConfig, private readonly agentSlug?: string) {
    super(id, name, config)
  }

  get sourceLabel(): string {
    return `Google Drive · ${this.config.driveName} / ${this.config.folderName}`
  }

  private request(request: DriveRequest) {
    return driveRequest(this.config.accountId, request, { agentSlug: this.agentSlug })
  }

  private view(children: DriveFile[]) {
    return folderView(children, file => googleDriveExportCache.tooLarge(this.config.accountId, file))
  }

  private children(folderId: string): Promise<DriveFile[]> {
    return googleDriveListingCache.list(this.config.accountId, keyOf(this.config.accountId, folderId), async () =>
      this.followShortcuts(await driveChildren(this.config.accountId, folderId, { agentSlug: this.agentSlug })))
  }

  /** A shortcut stands in for its target under its own name, like a subfolder or file of the folder it sits in:
   * reads and writes reach the target, delete and move act on the shortcut. One whose target is gone or not
   * accessible stays a shortcut, which the folder view hides. */
  private async followShortcuts(files: DriveFile[]): Promise<DriveFile[]> {
    const limit = pLimit(8)
    return Promise.all(files.map(file => limit(async () => {
      const targetId = file.mimeType === SHORTCUT_MIME_TYPE ? file.shortcutDetails?.targetId : undefined
      if (!targetId) return file
      try {
        const target = driveFileSchema.parse(await (await this.request({ method: 'GET', path: `drive/v3/files/${targetId}`, query: { fields: DRIVE_FILE_FIELDS } })).json())
        return { ...target, name: file.name, shortcutId: file.id }
      } catch (error) {
        if (error instanceof WorkspaceFileError) return file
        throw error
      }
    })))
  }

  /** The entry a path names, walking raw listings from the root by shown name. Exports nothing. */
  private async resolve(relative: string): Promise<Located | null> {
    let parentId = this.config.folderId
    let located: Located | null = null
    const path = new Set([parentId])
    for (const name of relative ? relative.split('/') : []) {
      if (located && !isFolder(located.entry.file)) throw new WorkspaceFileError('not-a-directory')
      const entry = this.view(await this.children(parentId)).entries.find(entry => entry.name === name)
      if (!entry) throw new WorkspaceFileError('not-found')
      // A shortcut to a folder above it would make an endless tree: it is listed but cannot be entered.
      if (isFolder(entry.file) && path.has(entry.file.id)) throw new WorkspaceFileError('not-found')
      path.add(entry.file.id)
      located = { parentId, entry }
      parentId = entry.file.id
    }
    return located
  }

  private async located(relative: string): Promise<Located> {
    const located = await this.resolve(relative)
    if (!located) throw new WorkspaceFileError('invalid-path', 'The volume root cannot be made, replaced, removed or moved')
    return located
  }

  private async folderIdOf(relative: string): Promise<string> {
    const located = await this.resolve(relative)
    if (located && !isFolder(located.entry.file)) throw new WorkspaceFileError('not-a-directory')
    return located?.entry.file.id ?? this.config.folderId
  }

  /** The attached folder, which must still be a folder outside the trash. */
  private async root(): Promise<DriveFile> {
    const root = driveFileSchema.parse(await (await this.request({ method: 'GET', path: `drive/v3/files/${this.config.folderId}`, query: { fields: DRIVE_FILE_FIELDS } })).json())
    // A trashed root is not found, so nothing is ever written into the trash.
    if (!isFolder(root) || root.trashed) throw new WorkspaceFileError('not-found')
    return root
  }

  /** One change at a time per account. Listings it reads through `fresh` are re-read from Drive and
   * dropped from the cache afterwards, including on failure. Other folders keep their cached listings,
   * so a burst of writes does not re-list every ancestor. */
  private change<T>(operation: (fresh: (folderId: string) => Promise<DriveFile[]>) => Promise<T>): Promise<T> {
    const { accountId } = this.config
    const touched = new Set<string>()
    const touch = (folderId: string) => {
      touched.add(folderId)
      googleDriveListingCache.forget(keyOf(accountId, folderId))
    }
    return serialize(accountId, async () => {
      try {
        return await operation(folderId => { touch(folderId); return this.children(folderId) })
      } finally {
        for (const folderId of touched) googleDriveListingCache.forget(keyOf(accountId, folderId))
      }
    })
  }

  /** The folder a new entry goes into. Children of a trashed folder are never listed, so only the root needs a live check. */
  private async parentOf(relative: string): Promise<string> {
    const parent = path.posix.dirname(relative)
    if (parent !== '.') return this.folderIdOf(parent)
    await this.root()
    return this.config.folderId
  }

  private writableName(relative: string): string {
    if (!relative) throw new WorkspaceFileError('invalid-path', 'The volume root cannot be made, replaced, removed or moved')
    return path.posix.basename(relative)
  }

  private async exportFile(file: DriveFile, mimeType: string): Promise<Export> {
    let response: Response
    try {
      response = await this.request({ method: 'GET', path: `drive/v3/files/${file.id}/export`, query: { mimeType } })
    } catch (error) {
      if (error instanceof DriveExportTooLargeError) return 'too-large'
      throw error
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  /** Export each Google file among `entries` once per version. */
  private learn(entries: VisibleEntry[]): Promise<void> {
    return googleDriveExportCache.learn(this.config.accountId, entries.filter(isExport), entry => this.exportFile(entry.file, entry.format.mimeType))
  }

  /** The entry as listed. A Google file's size must already be learned. */
  private entryOf({ name, file, format }: VisibleEntry): VolumeEntry {
    const mtimeMs = Date.parse(file.modifiedTime)
    if (isFolder(file)) return { name, kind: 'directory', size: 0, mtimeMs }
    if (!format) return { name, kind: 'file', size: file.size ?? 0, mtimeMs }
    const size = googleDriveExportCache.size(this.config.accountId, file)
    if (typeof size !== 'number') throw new WorkspaceFileError('not-found')
    return { name, kind: 'file', size, mtimeMs }
  }

  async list(relative: string): Promise<VolumeEntry[]> {
    // Cache hits must not outlive deletion/revocation of the connected account.
    await requireGoogleDriveAccount(this.config.accountId)
    const folderId = await this.folderIdOf(relative)
    const children = await this.children(folderId)
    await this.learn(this.view(children).entries)
    // A second pass hides exports found too large just now.
    const { entries, warnings } = this.view(children)
    for (const warning of warnings) console.warn(`[volumes] Google Drive folder ${folderId}: ${warning}`)
    return entries.map(entry => this.entryOf(entry))
  }

  async stat(relative: string): Promise<VolumeEntry> {
    await requireGoogleDriveAccount(this.config.accountId)
    if (!relative) return { name: '', kind: 'directory', size: 0, mtimeMs: Date.parse((await this.root()).modifiedTime) }
    const { entry } = await this.located(relative)
    await this.learn([entry])
    return this.entryOf(entry)
  }

  async read(relative: string): Promise<VolumeFile> {
    if (!relative) throw new WorkspaceFileError('not-a-file')
    await requireGoogleDriveAccount(this.config.accountId)
    const { entry } = await this.located(relative)
    if (isFolder(entry.file)) throw new WorkspaceFileError('not-a-file')
    const format = entry.format
    if (format) {
      const exported = await googleDriveExportCache.exported(this.config.accountId, entry.file, () => this.exportFile(entry.file, format.mimeType))
      if (exported === 'too-large') throw new WorkspaceFileError('not-found')
      return rangedVolumeFile(exported.length, async () => new Response(exported))
    }
    return rangedVolumeFile(this.entryOf(entry).size, ({ start, end }) =>
      this.request({ method: 'GET', path: `drive/v3/files/${entry.file.id}`, query: { alt: 'media' }, headers: { Range: `bytes=${start}-${end}` } }))
  }

  async write(relative: string, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<void> {
    try {
      const name = this.writableName(relative)
      await this.change(async fresh => {
        const parentId = await this.parentOf(relative)
        const children = await fresh(parentId)
        const target = writeTarget(this.view(children).entries, name)
        if (target.kind === 'refused') throw new WorkspaceFileError('not-a-file')
        if (target.kind === 'update') {
          await this.update(target, body, signal)
        } else {
          await driveUpload(this.config.accountId, { method: 'POST', path: 'upload/drive/v3/files', json: { name, parents: [parentId] } }, body, { agentSlug: this.agentSlug, signal })
        }
      })
    } catch (error) {
      await body.cancel().catch(() => {})
      throw error
    }
  }

  /** Replace a file's content. A converted copy's save goes in as its format, and Drive converts it back. */
  private update(target: { id: string; convertFrom?: string }, body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<void> {
    return driveUpload(this.config.accountId, {
      method: 'PATCH', path: `upload/drive/v3/files/${target.id}`, json: {}, ...(target.convertFrom ? { contentType: target.convertFrom } : {}),
    }, body, { agentSlug: this.agentSlug, signal })
  }

  async mkdir(relative: string): Promise<void> {
    const name = this.writableName(relative)
    await this.change(async fresh => {
      const parentId = await this.parentOf(relative)
      const children = await fresh(parentId)
      if (nameTaken(children, this.view(children).entries, name)) throw new WorkspaceFileError('already-exists')
      const response = await this.request({ method: 'POST', path: 'drive/v3/files', json: { name, mimeType: FOLDER_MIME_TYPE, parents: [parentId] } })
      await response.body?.cancel()
    })
  }

  /** The entry a change acts on, from a fresh listing of its folder, so a file renamed in Drive since the
   * last listing is never mistaken for the name being changed. */
  private async freshEntry(relative: string, fresh: (folderId: string) => Promise<DriveFile[]>): Promise<Located> {
    const name = this.writableName(relative)
    const parentId = await this.parentOf(relative)
    const entry = this.view(await fresh(parentId)).entries.find(entry => entry.name === name)
    if (!entry) throw new WorkspaceFileError('not-found')
    return { parentId, entry }
  }

  async delete(relative: string): Promise<void> {
    await this.change(async fresh => {
      const { entry } = await this.freshEntry(relative, fresh)
      // Trashing a folder trashes its contents: any raw child, shown or hidden, keeps it.
      if (isFolder(entry.file) && (await fresh(entry.file.id)).length) throw new WorkspaceFileError('not-empty')
      const response = await this.request({ method: 'PATCH', path: `drive/v3/files/${ownId(entry.file)}`, json: { trashed: true } })
      await response.body?.cancel()
    })
  }

  async move(from: string, to: string): Promise<void> {
    const name = this.writableName(to)
    await this.change(async fresh => {
      const source = await this.freshEntry(from, fresh)
      if (from === to) return
      if (isFolder(source.entry.file) && to.startsWith(`${from}/`)) throw new WorkspaceFileError('invalid-path')
      const parentId = await this.parentOf(to).catch(error => {
        if (error instanceof WorkspaceFileError && error.code === 'not-found') throw new WorkspaceFileError('not-a-directory')
        throw error
      })
      const driveName = driveNameOf(source.entry, name)
      if (driveName === null) throw new WorkspaceFileError('invalid-path', 'A converted copy keeps its extension')
      const shownName = source.entry.format ? driveName + source.entry.format.extension : name
      const children = await fresh(parentId)
      const entries = this.view(children).entries
      if (nameTaken(children, entries, driveName, shownName, ownId(source.entry.file))) {
        // A save by rename: a regular file moved onto a visible file replaces its content, so the destination keeps
        // its ID, sharing and history, and a converted copy saves into its Google file. The source is trashed only
        // after. Any other taken name keeps both entries.
        const target = writeTarget(entries, name)
        if (target.kind !== 'update' || isFolder(source.entry.file) || source.entry.format) throw new WorkspaceFileError('already-exists')
        // Both names reach the same Drive file (one is a shortcut to it). As in POSIX, the rename does nothing.
        if (target.id === source.entry.file.id) return
        const content = await this.request({ method: 'GET', path: `drive/v3/files/${source.entry.file.id}`, query: { alt: 'media' } })
        await this.update(target, content.body ?? new Blob([]).stream())
        const trashed = await this.request({ method: 'PATCH', path: `drive/v3/files/${ownId(source.entry.file)}`, json: { trashed: true } })
        await trashed.body?.cancel()
        return
      }
      const response = await this.request({
        method: 'PATCH', path: `drive/v3/files/${ownId(source.entry.file)}`, json: { name: driveName },
        query: parentId === source.parentId ? {} : { addParents: parentId, removeParents: source.parentId },
      })
      await response.body?.cancel()
    })
  }
}

export async function prepareGoogleDriveVolume(config: GoogleDriveVolumeConfig, creator?: { userId: string | null }) {
  if (!creator) throw new Error('A volume creator is required')
  await requireGoogleDriveAccount(config.accountId, creator)
  const folder = driveFileSchema.parse(await (await driveRequest(config.accountId, { method: 'GET', path: `drive/v3/files/${config.folderId}`, query: { fields: `${DRIVE_FILE_FIELDS},driveId` } })).json())
  if (!isFolder(folder) || folder.trashed) throw new WorkspaceFileError('not-a-directory', 'Select a Google Drive folder')
  const driveName = folder.driveId
    ? driveSchema.parse(await (await driveRequest(config.accountId, { method: 'GET', path: `drive/v3/drives/${folder.driveId}`, query: { fields: 'id,name' } })).json()).name
    : 'My Drive'
  // Stored names are Drive's, never the client's. Drive names a shared drive's own top folder "Drive".
  const name = folder.id === folder.driveId ? driveName : folder.name
  return { name, config: { ...config, folderName: name, driveName } }
}
