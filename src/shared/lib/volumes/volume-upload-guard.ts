import { VolumeError } from './volume-error'
import { throwIfUploadAborted } from './remote-transfer'

/** rclone sends DELETE after a failed PUT, even when the original file was never
 * changed. That DELETE has no identifying header. Refuse one delete per failed
 * upload with a conflict, rather than deleting the original or claiming that an
 * intentional delete succeeded. No five-second expiry: delayed cleanup is unsafe
 * too. A subsequent intentional delete can be retried. State is per attachment,
 * shared by its request-scoped adapters, and consumed by the cleanup attempts.
 * rclone sends no cleanup DELETE for an upload it cancelled, and sends any other
 * cleanup before it uploads that file again, so a newer upload clears cancellations,
 * including one whose server-side work ends after the newer upload started. */
export class VolumeUploadGuard {
  private readonly paths = new Map<string, { active: number; failed: number; cancelled: boolean; latest: number }>()

  async write<T>(key: string, body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const state = this.paths.get(key) ?? { active: 0, failed: 0, cancelled: false, latest: 0 }
    this.paths.set(key, state)
    const upload = ++state.latest
    state.cancelled = false
    state.active++
    try {
      throwIfUploadAborted(signal)
      const result = await operation()
      // The peer may have disconnected while an already-sent commit finished.
      // Its cleanup DELETE is still unsafe even though the provider stored it.
      throwIfUploadAborted(signal)
      return result
    } catch (error) {
      if (!signal?.aborted) state.failed++
      else if (upload === state.latest) state.cancelled = true
      await body.cancel().catch(() => {})
      throw error
    } finally {
      state.active--
      if (!state.active && !state.failed && !state.cancelled) this.paths.delete(key)
    }
  }

  beforeDelete(key: string): void {
    const state = this.paths.get(key)
    if (!state) return
    if (state.failed) state.failed--
    else state.cancelled = false
    if (!state.active && !state.failed && !state.cancelled) this.paths.delete(key)
    throw new VolumeError('File preserved after an unfinished upload. Retry the deletion if it was intentional.', 409)
  }
}

export const volumeUploads = new VolumeUploadGuard()
