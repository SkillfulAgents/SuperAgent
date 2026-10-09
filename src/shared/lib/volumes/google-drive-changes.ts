import { z } from 'zod'
import { driveRequest } from './google-drive-client'
import { DRIVE_FILE_FIELDS, driveFileSchema, driveIdSchema, type DriveFile } from './google-drive-schema'
import type { RemoteListingCache } from './remote-listing-cache'

/** Changes reached Drive's feed 2-5 s after Drive confirmed them, so a poll vouches for listings only as of this long before it. */
const FEED_LAG_MS = 10_000
const POLL_EVERY_MS = 3_000
/** A feed unpolled this long starts again from now rather than paging through what it missed. */
const IDLE_MS = 60_000
/** The feed covers the whole account. Past this many pages since the last poll, every listing is read again instead. */
const MAX_PAGES = 3

const changeSchema = z.object({
  fileId: driveIdSchema.optional(),
  removed: z.boolean().optional(),
  file: driveFileSchema.extend({ parents: z.array(driveIdSchema).optional() }).optional(),
})
export type DriveChange = z.infer<typeof changeSchema>
const changePageSchema = z.object({ changes: z.array(changeSchema), nextPageToken: z.string().optional(), newStartPageToken: z.string().optional() })
const startSchema = z.object({ startPageToken: z.string() })
const CHANGE_FIELDS = `nextPageToken,newStartPageToken,changes(fileId,removed,file(${DRIVE_FILE_FIELDS},parents))`

/** Whether a folder's cached children no longer match Drive after `change`. A followed shortcut stands in for
 * its target, so a change to either drops the listing. */
export function staleAfter(folderId: string, entries: DriveFile[], change: DriveChange): boolean {
  const listed = entries.find(entry => entry.id === change.fileId || entry.shortcutId === change.fileId)
  if (change.removed || !change.file) return listed !== undefined
  const { file } = change
  const inFolder = !file.trashed && (file.parents ?? []).includes(folderId)
  if (!listed) return inFolder
  return !inFolder || listed.shortcutId !== undefined || listed.name !== file.name || listed.modifiedTime !== file.modifiedTime
    || listed.size !== file.size || listed.mimeType !== file.mimeType
}

interface Feed { token: string; coveredFrom: number; polledAt: number }

/** Drive's account-wide change feed, polled while the account's listings are read. A poll that finds nothing
 * touching a cached folder keeps its listing current, so a walk over many folders costs one call instead of a
 * listing each. A listing a change touches is dropped and read again. Writes, deletes and moves keep their
 * own checks: a vouched listing is never young enough for them. */
export class GoogleDriveChangeFeed {
  private readonly feeds = new Map<string, Feed>()
  private readonly polls = new Map<string, Promise<void>>()

  constructor(private readonly listings: RemoteListingCache<DriveFile>, private readonly folderOf: (key: string) => string) {}

  /** Poll in the background when the listing under `key` is older than a poll interval. Never waits. */
  keepFresh(accountId: string, key: string): void {
    const listing = this.listings.recent(key, Infinity)
    if (!listing || listing.readAt > Date.now() - POLL_EVERY_MS || this.polls.has(accountId)) return
    const feed = this.feeds.get(accountId)
    if (feed && feed.polledAt > Date.now() - POLL_EVERY_MS) return
    const poll = (feed && feed.polledAt > Date.now() - IDLE_MS ? this.poll(accountId, feed) : this.start(accountId))
      .catch((error: unknown) => {
        // Listings checked against the dropped feed are never vouched for again, so they expire as before.
        this.feeds.delete(accountId)
        console.warn(`[volumes] Google Drive change feed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => this.polls.delete(accountId))
    this.polls.set(accountId, poll)
  }

  private async start(accountId: string): Promise<void> {
    const polledAt = Date.now()
    const { startPageToken } = startSchema.parse(await (await driveRequest(accountId, { method: 'GET', path: 'drive/v3/changes/startPageToken' })).json())
    // A listing read after this answer arrived sees every change the feed reports from this token on.
    this.feeds.set(accountId, { token: startPageToken, coveredFrom: Date.now(), polledAt })
  }

  private async poll(accountId: string, feed: Feed): Promise<void> {
    const polledAt = Date.now()
    const changes: DriveChange[] = []
    let token = feed.token
    for (let page = 0; ; page++) {
      if (page === MAX_PAGES) {
        this.listings.invalidate(accountId)
        return this.start(accountId)
      }
      const response = await driveRequest(accountId, { method: 'GET', path: 'drive/v3/changes', query: { pageToken: token, pageSize: '1000', includeItemsFromAllDrives: 'true', fields: CHANGE_FIELDS } })
      const body = changePageSchema.parse(await response.json())
      changes.push(...body.changes)
      if (body.newStartPageToken) { token = body.newStartPageToken; break }
      if (!body.nextPageToken) throw new Error('A change page ended without a token')
      token = body.nextPageToken
    }
    const checkedAt = Date.now()
    this.listings.confirm(accountId, feed.coveredFrom, polledAt - FEED_LAG_MS, checkedAt,
      (key, entries) => changes.some(change => staleAfter(this.folderOf(key), entries, change)))
    this.feeds.set(accountId, { token, coveredFrom: checkedAt, polledAt })
  }
}
