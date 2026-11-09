/**
 * `session-metadata.json`: the portable form of an agent's session index.
 *
 * The index is the agent's own storage and does not travel with its
 * workspace, so a full export writes this file into the archive and an
 * import reads it back. It is also the form the index had before it existed:
 * a workspace from an older build carries one, which a data migration
 * ingests the same way. Nothing reads the file at runtime, and it is gone
 * from a workspace once ingested.
 */
import { CONFIG_DOCS, ConfigDocError } from '@shared/lib/agent-actor/config-schema'
import type { SessionIndexEntry } from '@shared/lib/agent-actor/session-index'
import { isSessionIdWellFormed, type SessionStore } from '@shared/lib/agent-actor/session-store'
import { captureException } from '@shared/lib/error-reporting'
import { portableSessionMetadataSchema, type PortableSessionMetadataMap } from './session-metadata-schema'

/** Workspace path of the file, and its name in an archive. */
export const SESSION_METADATA_FILE = CONFIG_DOCS.sessionMetadata.path

/** What a full export carries as `session-metadata.json`: each session's metadata and when its transcript was last written. */
export async function exportSessionMetadata(store: SessionStore): Promise<PortableSessionMetadataMap> {
  const entries = await store.index.entries()
  return Object.fromEntries(
    entries.flatMap(({ sessionId, meta, transcript }) =>
      meta
        ? [[sessionId, transcript ? { ...meta, lastActivityAt: new Date(transcript.mtimeMs).toISOString() } : meta]]
        : []),
  )
}

/** The entries of a file that does not fit as a whole; none when it is not a JSON object. */
function entriesThatFit(bytes: Uint8Array): PortableSessionMetadataMap {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const entries: PortableSessionMetadataMap = {}
  for (const [sessionId, value] of Object.entries(parsed)) {
    const entry = portableSessionMetadataSchema.safeParse(value)
    if (entry.success) entries[sessionId] = entry.data as PortableSessionMetadataMap[string]
  }
  return entries
}

/**
 * Take the workspace's `session-metadata.json` into the index, then remove
 * it. Metadata the index already holds wins, so running this again over a
 * half-ingested file (a crash before the removal) changes nothing.
 *
 * An entry that says when its transcript was last written is trusted on
 * that: the transcript is not statted, whose mtime after an import is the
 * time of the import. The index's own reconciliation covers the rest: a
 * transcript without an entry is statted when first listed, and an entry
 * whose transcript is not there is dropped.
 *
 * A file that does not fit is set aside under another name rather than
 * removed, and every entry of it that does fit is still taken: the file was
 * the agent's to edit, and one bad entry must not cost every other session
 * its name. The sessions it says nothing usable about list from their
 * transcripts, without names.
 */
export async function ingestSessionMetadataFile(store: SessionStore): Promise<void> {
  let file: PortableSessionMetadataMap | null
  try {
    file = await store.config.get('sessionMetadata')
  } catch (error) {
    if (!(error instanceof ConfigDocError && error.code === 'corrupt')) throw error
    console.error(`Corrupt ${SESSION_METADATA_FILE} for agent ${store.slug}; setting it aside`, error)
    captureException(error, { tags: { area: 'session-index', op: 'ingest' }, extra: { agentSlug: store.slug } })
    const bytes = await store.files.getDoc(SESSION_METADATA_FILE)
    if (bytes !== null) await store.files.putDoc(`session-metadata.corrupt-${Date.now()}.json`, bytes)
    file = bytes === null ? null : entriesThatFit(bytes)
  }
  if (file === null) return

  const entries: SessionIndexEntry[] = []
  for (const [sessionId, { lastActivityAt, ...meta }] of Object.entries(file)) {
    if (!isSessionIdWellFormed(sessionId)) continue
    // An archive from before the commands became one list per agent.
    delete meta.slashCommands
    const activityAtMs = lastActivityAt === undefined ? NaN : new Date(lastActivityAt).getTime()
    entries.push({
      sessionId,
      meta,
      // Registered, so its size is never consulted; 1 says "not empty".
      transcript: Number.isNaN(activityAtMs) ? null : { mtimeMs: activityAtMs, birthtimeMs: 0, size: 1 },
    })
  }
  await store.index.fill(entries)
  await store.files.delete(SESSION_METADATA_FILE)
}
