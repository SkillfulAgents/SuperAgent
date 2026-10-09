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
import { GoogleDriveChangeFeed } from './google-drive-changes'
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

/** A listing this app read or changed this recently stands in for a re-read before a write or mkdir.
 * Drive has no conditional create, so a name can be taken behind any check. This widens that window
 * by at most this long. Deletes and moves always re-read, so they never act on a renamed entry. */
const TRUSTED_LISTING_MS = 5_000

/** The latest check that each volume root is alive, by account and folder ID, shared while it runs. */
export const googleDriveRootChecks = new Map<string, { at: number; check: Promise<unknown> }>()

/** Raw children by account and folder ID, so overlapping volumes share listings. */
export const googleDriveListingCache = new RemoteListingCache<DriveFile>()
const keyOf = (accountId: string, folderId: string) => JSON.stringify([accountId, folderId])
export const googleDriveChangeFeed = new GoogleDriveChangeFeed(googleDriveListingCache, key => (JSON.parse(key) as [string, string])[1])

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

/** `child` after an upload stored `file`: a shortcut to it keeps its own name and ID. */
function settled(child: DriveFile, file: DriveFile): DriveFile {
  return child.id === file.id ? { ...file, name: child.name, shortcutId: child.shortcutId } : child
}

/** The upload that replaces a file's content. A converted copy's save goes in as its format, and Drive converts it back. */
function updateSession(target: { id: string; convertFrom?: string }) {
  return { method: 'PATCH' as const, path: `upload/drive/v3/files/${target.id}`, json: {}, ...(target.convertFrom ? { contentType: target.convertFrom } : {}) }
}

/** When an overwrite of each volume path last failed, so rclone's cleanup delete after it can be told apart. */
const failedWrites = new Map<string, number>()
const FAILED_WRITE_CLEANUP_MS = 5_000

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
  // People edit Drive files in Google's editors while agents work. Until the mount re-lists a folder, a changed
  // file's read is refused rather than cut short, so the window stays short.
  readonly dirCacheSeconds = 30

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
    const key = keyOf(this.config.accountId, folderId)
    googleDriveChangeFeed.keepFresh(this.config.accountId)
    return googleDriveListingCache.list(this.config.accountId, key, async () =>
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

  /** One change at a time per folder, across every mount of the account: a change holds the folders it
   * reads or changes, and waits for earlier changes to any of them. A folder it reads through `fresh` is
   * re-read from Drive once per change, unless a listing of it is younger than `trustedMs`, and `settle`
   * records what the change did to it. On success those listings are cached as settled, so the next change
   * through them lists nothing. On failure they are dropped, since what Drive committed is unknown. */
  private change<T>(folderIds: string[], operation: (
    fresh: (folderId: string, trustedMs?: number) => Promise<DriveFile[]>,
    settle: (folderId: string, update: (children: DriveFile[]) => DriveFile[]) => void,
  ) => Promise<T>): Promise<T> {
    const { accountId } = this.config
    googleDriveChangeFeed.keepFresh(accountId)
    // `cached` is the listing a change started from, when it came from the cache rather than Drive.
    const touched = new Map<string, { entries: DriveFile[]; readAt: number; checkedAt: number; cached?: { readAt: number; checkedAt: number } }>()
    const fresh = async (folderId: string, trustedMs?: number) => {
      if (!folderIds.includes(folderId)) throw new Error('A change reads only the folders it holds')
      const held = touched.get(folderId)
      if (held) return held.entries
      const cached = trustedMs ? googleDriveListingCache.recent(keyOf(accountId, folderId), trustedMs) : undefined
      if (cached) {
        touched.set(folderId, { entries: cached.entries, readAt: cached.readAt, checkedAt: cached.checkedAt, cached })
        return cached.entries
      }
      googleDriveListingCache.forget(keyOf(accountId, folderId))
      const readAt = Date.now()
      const entries = await this.children(folderId)
      touched.set(folderId, { entries, readAt, checkedAt: readAt })
      return entries
    }
    const settle = (folderId: string, update: (children: DriveFile[]) => DriveFile[]) => {
      const listing = touched.get(folderId)
      if (!listing) throw new Error('A change settles only folders it read')
      touched.set(folderId, { ...listing, entries: update(listing.entries) })
    }
    return serialize(folderIds.map(folderId => keyOf(accountId, folderId)), async () => {
      try {
        const result = await operation(fresh, settle)
        for (const [folderId, { entries, readAt, checkedAt, cached }] of touched) {
          const key = keyOf(accountId, folderId)
          // The change feed dropped the listing this change started from, so Drive changed the folder meanwhile.
          if (cached && googleDriveListingCache.recent(key, Infinity) !== cached) googleDriveListingCache.forget(key)
          // A poll may have vouched for it since, so it keeps the cache's times.
          else googleDriveListingCache.put(accountId, key, entries, cached?.readAt ?? readAt, cached?.checkedAt ?? checkedAt)
        }
        return result
      } catch (error) {
        for (const folderId of touched.keys()) googleDriveListingCache.forget(keyOf(accountId, folderId))
        throw error
      }
    })
  }

  /** The folder a new entry goes into. Children of a trashed folder are never listed, so only the root needs a live check. */
  private async parentOf(relative: string): Promise<string> {
    const parent = path.posix.dirname(relative)
    if (parent !== '.') return this.folderIdOf(parent)
    // A root found alive as recently as a listing is trusted counts as alive, so a burst of top-level writes checks it once.
    const key = keyOf(this.config.accountId, this.config.folderId)
    let latest = googleDriveRootChecks.get(key)
    if (!latest || latest.at < Date.now() - TRUSTED_LISTING_MS) {
      const started = { at: Date.now(), check: this.root() }
      // A failed check is never reused: the next write checks again.
      started.check.catch(() => { if (googleDriveRootChecks.get(key) === started) googleDriveRootChecks.delete(key) })
      googleDriveRootChecks.set(key, started)
      latest = started
    }
    await latest.check
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
    let overwriting = false
    try {
      const name = this.writableName(relative)
      const parentId = await this.parentOf(relative)
      const planned = writeTarget(this.view(await this.children(parentId)).entries, name)
      if (planned.kind === 'refused') throw new WorkspaceFileError('not-a-file')
      overwriting = planned.kind === 'update'
      // The bytes go up outside the folder's lock. Only the last piece, which makes the change,
      // waits for it, once the target is checked again.
      await driveUpload(this.config.accountId, planned.kind === 'update'
        ? updateSession(planned)
        : { method: 'POST', path: 'upload/drive/v3/files', json: { name, parents: [parentId] } }, body, {
        agentSlug: this.agentSlug, signal,
        publish: send => this.change([parentId], async (fresh, settle) => {
          const target = writeTarget(this.view(await fresh(parentId, TRUSTED_LISTING_MS)).entries, name)
          if (target.kind !== planned.kind || (target.kind === 'update' && planned.kind === 'update' && target.id !== planned.id)) {
            throw new Error('The file changed in Google Drive during the upload')
          }
          const stored = await send()
          if (signal?.aborted && target.kind === 'create') {
            // rclone cancelled this upload while Drive committed it (the file was renamed mid-upload) and sends it
            // again under the new name. Its cleanup delete raced the commit, so the copy made here is a stray.
            const trashed = await this.request({ method: 'PATCH', path: `drive/v3/files/${stored.id}`, json: { trashed: true } })
            await trashed.body?.cancel()
            return stored
          }
          settle(parentId, children => target.kind === 'update' ? children.map(child => settled(child, stored)) : [...children, stored])
          return stored
        }),
      })
    } catch (error) {
      if (overwriting) failedWrites.set(`${this.id}:${relative}`, Date.now())
      await body.cancel().catch(() => {})
      throw error
    }
  }

  async mkdir(relative: string): Promise<void> {
    const name = this.writableName(relative)
    const parentId = await this.parentOf(relative)
    const madeAt = Date.now()
    const made = await this.change([parentId], async (fresh, settle) => {
      const children = await fresh(parentId, TRUSTED_LISTING_MS)
      if (nameTaken(children, this.view(children).entries, name)) throw new WorkspaceFileError('already-exists')
      const response = await this.request({ method: 'POST', path: 'drive/v3/files', query: { fields: DRIVE_FILE_FIELDS }, json: { name, mimeType: FOLDER_MIME_TYPE, parents: [parentId] } })
      const made = driveFileSchema.parse(await response.json())
      settle(parentId, children => [...children, made])
      return made
    })
    // The folder is empty when made, so its first listing costs no Drive call.
    googleDriveListingCache.seed(this.config.accountId, keyOf(this.config.accountId, made.id), [], madeAt)
  }

  /** Where a delete or move starts. A name the cached listing lacks is looked up in Drive again, so an
   * entry renamed there since the last listing is still found. */
  private async planned(relative: string): Promise<Located> {
    try {
      return await this.located(relative)
    } catch (error) {
      if (!(error instanceof WorkspaceFileError) || error.code !== 'not-found') throw error
      googleDriveListingCache.forget(keyOf(this.config.accountId, await this.parentOf(relative)))
      return this.located(relative)
    }
  }

  /** The entry a change acts on, found by its name in a fresh listing of its folder, so a file renamed in
   * Drive since the last listing is never mistaken for it. */
  private async freshEntry(planned: Located, fresh: (folderId: string) => Promise<DriveFile[]>): Promise<VisibleEntry> {
    const entry = this.view(await fresh(planned.parentId)).entries.find(entry => entry.name === planned.entry.name)
    if (!entry) throw new WorkspaceFileError('not-found')
    return entry
  }

  async delete(relative: string): Promise<void> {
    // rclone deletes a file one second after its overwrite fails or is cancelled ("Remove failed upload", rclone's
    // webdav.go). On Drive that would trash the file it meant to update, so the file keeps its old content instead.
    const failedAt = failedWrites.get(`${this.id}:${relative}`)
    failedWrites.delete(`${this.id}:${relative}`)
    if (failedAt !== undefined && Date.now() - failedAt < FAILED_WRITE_CLEANUP_MS) return
    const planned = await this.planned(relative)
    // A folder is held too, so nothing is written into it while it is checked empty and trashed.
    await this.change([planned.parentId, ...(isFolder(planned.entry.file) ? [planned.entry.file.id] : [])], async (fresh, settle) => {
      const entry = await this.freshEntry(planned, fresh)
      if (isFolder(entry.file) && ownId(entry.file) !== ownId(planned.entry.file)) throw new Error('A different folder took this name in Google Drive during the change')
      // Trashing a folder trashes its contents: any raw child, shown or hidden, keeps it.
      if (isFolder(entry.file) && (await fresh(entry.file.id)).length) throw new WorkspaceFileError('not-empty')
      const response = await this.request({ method: 'PATCH', path: `drive/v3/files/${ownId(entry.file)}`, json: { trashed: true } })
      await response.body?.cancel()
      settle(planned.parentId, children => children.filter(child => ownId(child) !== ownId(entry.file)))
    })
  }

  async move(from: string, to: string): Promise<void> {
    const name = this.writableName(to)
    const planned = await this.planned(from)
    if (from === to) return
    if (isFolder(planned.entry.file) && to.startsWith(`${from}/`)) throw new WorkspaceFileError('invalid-path')
    const parentId = await this.parentOf(to).catch(error => {
      if (error instanceof WorkspaceFileError && error.code === 'not-found') throw new WorkspaceFileError('not-a-directory')
      throw error
    })
    await this.change([...new Set([planned.parentId, parentId])], async (fresh, settle) => {
      const source = { parentId: planned.parentId, entry: await this.freshEntry(planned, fresh) }
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
        const stored = await driveUpload(this.config.accountId, updateSession(target), content.body ?? new Blob([]).stream(), { agentSlug: this.agentSlug })
        const trashed = await this.request({ method: 'PATCH', path: `drive/v3/files/${ownId(source.entry.file)}`, json: { trashed: true } })
        await trashed.body?.cancel()
        settle(source.parentId, children => children.filter(child => ownId(child) !== ownId(source.entry.file)))
        settle(parentId, children => children.map(child => settled(child, stored)))
        return
      }
      const response = await this.request({
        method: 'PATCH', path: `drive/v3/files/${ownId(source.entry.file)}`, json: { name: driveName },
        query: { fields: DRIVE_FILE_FIELDS, ...(parentId === source.parentId ? {} : { addParents: parentId, removeParents: source.parentId }) },
      })
      const moved = driveFileSchema.parse(await response.json())
      // Drive answers a shortcut's move with the shortcut, so the listing keeps the target it stands in for.
      const listed = source.entry.file.shortcutId ? { ...source.entry.file, name: moved.name } : moved
      settle(source.parentId, children => children.filter(child => ownId(child) !== ownId(listed)))
      settle(parentId, children => [...children, listed])
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
