/** rclone sends DELETE after a failed PUT, even when the original file was never
 * changed. That DELETE has no identifying header. Refuse one delete per failed
 * upload with a conflict, rather than deleting the original or claiming that an
 * intentional delete succeeded. No five-second expiry: delayed cleanup is unsafe
 * too. A subsequent intentional delete can be retried. State is per attachment,
 * kept with the agent the attachment belongs to and shared by its request-scoped
 * adapters, and consumed by the cleanup attempts. rclone sends no cleanup DELETE
 * for an upload it cancelled, and sends any other cleanup before it uploads that
 * file again, so a newer upload clears cancellations, including one whose
 * server-side work ends after the newer upload started. */
export type VolumeUploadOutcome = 'stored' | 'failed' | 'cancelled'

export class VolumeUploadGuard {
  private readonly paths = new Map<string, { active: number; failed: number; cancelled: boolean; latest: number }>()

  /** An upload of `key` starts: its number, for `end`. */
  begin(key: string): number {
    const state = this.paths.get(key) ?? { active: 0, failed: 0, cancelled: false, latest: 0 }
    this.paths.set(key, state)
    state.cancelled = false
    state.active++
    return ++state.latest
  }

  /** The upload `begin` numbered is over. Only the newest upload's cancellation counts. */
  end(key: string, upload: number, outcome: VolumeUploadOutcome): void {
    const state = this.paths.get(key)
    if (!state) return
    if (outcome === 'failed') state.failed++
    else if (outcome === 'cancelled' && upload === state.latest) state.cancelled = true
    state.active--
    this.forgetIfSettled(key)
  }

  /** Whether a delete of `key` may go ahead. A refusal consumes what one unfinished upload left. */
  allowDelete(key: string): boolean {
    const state = this.paths.get(key)
    if (!state) return true
    if (state.failed) state.failed--
    else state.cancelled = false
    this.forgetIfSettled(key)
    return false
  }

  private forgetIfSettled(key: string): void {
    const state = this.paths.get(key)
    if (state && !state.active && !state.failed && !state.cancelled) this.paths.delete(key)
  }
}
