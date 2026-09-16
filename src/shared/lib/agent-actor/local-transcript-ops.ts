/**
 * Transcript-adjacent reads over an agent's session store: subagent and
 * workflow transcripts beside the session's own, the raw transcript bytes,
 * media referenced from it, and the copy a fork makes.
 *
 * These are the places that used to build a transcript path themselves.
 * Every function here takes the store; the actor binds it.
 */
import { Readable } from 'stream'
import pLimit from 'p-limit'
import { z } from 'zod'
import { openMediaBlob, type MediaRef } from '@shared/lib/services/session-media'
import { buildWorkflowTree } from '@shared/lib/workflows/workflow-tree'
import type { WorkflowTree } from '@shared/lib/workflows/workflow-schemas'
import type { JsonlEntry } from '@shared/lib/types/agent'
import { captureException } from '@shared/lib/error-reporting'
import { isAbsentFile, readJsonl, streamJsonl } from './jsonl-files'
import { sessionDirPath, sessionFilePath, transcriptPath, type SessionStore } from './session-store'
import type { FileEntry, MediaBlob, SubagentRef } from './types'
import { WorkspaceFileError, joinWorkspacePath } from './workspace-path'

const SUBAGENT_ID = /^[\w-]+$/
const WORKFLOW_RUN_ID = /^wf_[\w-]+$/

/** The sidecar the container writes beside each subagent transcript. */
const subagentMetaSchema = z.object({ toolUseId: z.string().optional() }).loose()

/**
 * The one transcript read that also checks its real location, as its route
 * always did: the transcripts directory sits inside the workspace the
 * container mounts, so the agent can plant links there. The store's
 * `resolve` anchors the check on the WORKSPACE, the mount point the
 * container cannot replace: a link swapped in for the transcripts directory
 * still resolves outside it. An escaped link reads as not found, so nothing
 * about the target is disclosed. Doing the same for every read here is
 * tracked separately.
 */
async function reallyInsideWorkspace(store: SessionStore, target: string): Promise<string> {
  try {
    await store.files.resolve(target)
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw new WorkspaceFileError('not-found')
    throw error
  }
  return target
}

export async function listSubagents(
  store: SessionStore,
  sessionId: string,
  options?: { except?: ReadonlySet<string> },
): Promise<SubagentRef[]> {
  const subagentsDir = sessionFilePath(store, sessionId, 'subagents')
  let entries: FileEntry[]
  try {
    entries = await store.files.list(subagentsDir)
  } catch {
    return [] // No subagents directory
  }
  const ids: string[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.startsWith('agent-') || !entry.name.endsWith('.meta.json')) continue
    const id = entry.name.slice('agent-'.length, -'.meta.json'.length)
    if (!options?.except?.has(id)) ids.push(id)
  }
  // The sidecars are independent small files: read a few at a time rather
  // than one after another, in the listing's order.
  const limit = pLimit(8)
  return Promise.all(
    ids.map((id) =>
      limit(async (): Promise<SubagentRef> => {
        try {
          const raw = await store.files.getDoc(joinWorkspacePath(subagentsDir, `agent-${id}.meta.json`))
          if (raw === null) return { id }
          const meta = subagentMetaSchema.parse(JSON.parse(Buffer.from(raw).toString('utf8')))
          return meta.toolUseId ? { id, toolUseId: meta.toolUseId } : { id }
        } catch {
          return { id } // an unreadable sidecar still names a subagent
        }
      }),
    ),
  )
}

export async function readSubagentTranscript(store: SessionStore, sessionId: string, subagentId: string): Promise<JsonlEntry[]> {
  if (!SUBAGENT_ID.test(subagentId)) throw new WorkspaceFileError('invalid-path')
  const jsonlPath = await reallyInsideWorkspace(
    store,
    sessionFilePath(store, sessionId, 'subagents', `agent-${subagentId}.jsonl`),
  )
  return readJsonl<JsonlEntry>(store.files, jsonlPath)
}

export async function readWorkflowTree(store: SessionStore, sessionId: string, runId: string): Promise<WorkflowTree | null> {
  if (!WORKFLOW_RUN_ID.test(runId)) throw new WorkspaceFileError('invalid-path')
  // The tree builder reads below the run's directory; that directory is
  // checked here the same way every other read checks its path.
  sessionFilePath(store, sessionId, 'subagents', 'workflows', runId)
  return buildWorkflowTree({ files: store.files, transcriptsDir: store.transcriptsDir, sessionId, runId })
}

export async function readWorkflowAgentTranscript(
  store: SessionStore,
  sessionId: string,
  runId: string,
  workflowAgentId: string,
): Promise<JsonlEntry[]> {
  if (!WORKFLOW_RUN_ID.test(runId) || !SUBAGENT_ID.test(workflowAgentId)) throw new WorkspaceFileError('invalid-path')
  const jsonlPath = sessionFilePath(store, sessionId, 'subagents', 'workflows', runId, `agent-${workflowAgentId}.jsonl`)
  return readJsonl<JsonlEntry>(store.files, jsonlPath)
}

/** Copy a directory tree within the workspace: every file streamed across, every directory created. */
async function copyTree(store: SessionStore, source: string, target: string): Promise<void> {
  await store.files.mkdir(target)
  const entries = await store.files.list(source)
  const limit = pLimit(8)
  await Promise.all(
    entries.map((entry) =>
      limit(async () => {
        const destination = joinWorkspacePath(target, entry.name)
        if (entry.kind === 'directory') {
          await copyTree(store, entry.path, destination)
          return
        }
        const stat = await store.files.stat(entry.path)
        await store.files.write(destination, await store.files.read(entry.path), stat?.mode === undefined ? undefined : { mode: stat.mode })
      }),
    ),
  )
}

/**
 * Copy a session's derived files (subagents, workflows) to a new session id.
 * Nothing to copy is a no-op, and so is a session directory that is a link:
 * only what the container wrote beside the transcript is copied, never what
 * a link points at.
 */
export async function copyDerivedSessionFiles(store: SessionStore, sourceSessionId: string, targetSessionId: string): Promise<void> {
  const source = sessionDirPath(store, sourceSessionId)
  const target = sessionDirPath(store, targetSessionId)
  let real: string | null
  try {
    real = await store.files.resolve(source)
  } catch (error) {
    if (error instanceof WorkspaceFileError) return
    throw error
  }
  if (real !== source) return
  if ((await store.files.stat(source))?.kind !== 'directory') return
  await copyTree(store, source, target)
}

export function streamRawEntries(store: SessionStore, sessionId: string): AsyncIterable<unknown> {
  return streamJsonl(store.files, transcriptPath(store, sessionId))
}

function isBenignStreamError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'ABORT_ERR' || code === 'ERR_STREAM_PREMATURE_CLOSE'
}

/**
 * The transcript's bytes, bounded to its size at open so the byte count always
 * matches what is streamed even while the agent appends. Null when there is
 * no transcript file.
 */
export async function openRawLog(store: SessionStore, sessionId: string): Promise<{ size: number; stream: ReadableStream<Uint8Array> } | null> {
  const jsonlPath = transcriptPath(store, sessionId)
  let file: Awaited<ReturnType<typeof store.files.open>>
  try {
    file = await store.files.open(jsonlPath)
  } catch (error) {
    if (isAbsentFile(error)) return null
    throw error
  }
  let size: number
  try {
    size = await file.size()
  } catch (error) {
    await file.close().catch(() => {})
    throw error
  }
  if (size === 0) {
    await file.close().catch(() => {})
    return { size: 0, stream: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }) }
  }
  // Through a Node stream so a failure mid-download is reported, not thrown
  // at the response: a client hanging up is the normal case, not a fault.
  const source = Readable.fromWeb(file.stream({ start: 0, end: size - 1 }) as import('stream/web').ReadableStream<Uint8Array>)
  source.on('error', (error) => {
    if (isBenignStreamError(error)) return
    console.error('Failed to stream raw log:', error)
    captureException(error, { tags: { component: 'agent-actor', operation: 'stream-raw-log' } })
  })
  return { size, stream: Readable.toWeb(source) as ReadableStream<Uint8Array> }
}

export async function openMedia(store: SessionStore, sessionId: string, ref: MediaRef, signal?: AbortSignal): Promise<MediaBlob | undefined> {
  const blob = await openMediaBlob(store.files, transcriptPath(store, sessionId), ref, signal)
  if (!blob) return undefined
  return { stream: Readable.toWeb(blob.stream) as ReadableStream<Uint8Array>, mimeType: blob.mimeType, bytes: blob.bytes }
}
