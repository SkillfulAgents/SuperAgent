/**
 * The upload guard (see `VolumeUploadGuard`) as a volume reaches it: through
 * the actor of the agent the attachment belongs to. A volume opened for no
 * agent (setup, validation) never serves rclone, so it has nothing to guard.
 */
import type { VolumeUploadOps } from '@shared/lib/agent-actor'
import { VolumeError } from './volume-error'
import { throwIfUploadAborted } from './remote-transfer'

/**
 * The agent's upload guard. Imported when used: the actor package reaches
 * the volumes through the container runtime's mounts, so a static import
 * would close that cycle while the volume modules load.
 */
async function uploadsOf(agentSlug: string): Promise<VolumeUploadOps> {
  const { agentRegistry } = await import('@shared/lib/agent-actor')
  return agentRegistry.get(agentSlug).volumeUploads
}

/** Write `body` with `operation`, recording how the upload ended for the delete that may follow it. */
export async function guardedUpload<T>(
  agentSlug: string | undefined,
  key: string,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  // Noted with the agent while the provider work starts: the round trip to the
  // actor never delays the upload, so the version the write is checked against
  // is read as soon as the request arrives. `end` waits for it, so each
  // upload's end follows its own begin.
  const begun = agentSlug === undefined
    ? undefined
    : uploadsOf(agentSlug).then(async (uploads) => ({ uploads, upload: await uploads.begin(key) }))
  let outcome: 'stored' | 'failed' | 'cancelled' = 'stored'
  try {
    throwIfUploadAborted(signal)
    const result = await operation()
    // The peer may have disconnected while an already-sent commit finished.
    // Its cleanup DELETE is still unsafe even though the provider stored it.
    throwIfUploadAborted(signal)
    return result
  } catch (error) {
    outcome = signal?.aborted ? 'cancelled' : 'failed'
    await body.cancel().catch(() => {})
    throw error
  } finally {
    const started = await begun
    if (started) await started.uploads.end(key, started.upload, outcome)
  }
}

/** Refuse a delete that may be rclone cleaning up after an unfinished upload of `key`. */
export async function guardDelete(agentSlug: string | undefined, key: string): Promise<void> {
  if (agentSlug === undefined) return
  if (await (await uploadsOf(agentSlug)).allowDelete(key)) return
  throw new VolumeError('File preserved after an unfinished upload. Retry the deletion if it was intentional.', 409)
}
