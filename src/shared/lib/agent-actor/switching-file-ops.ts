/**
 * The workspace of an agent whose files live with its container, by the
 * container's state: while it is up, the container's own workspace is the
 * authority and every operation goes there; while it is down, the provider's
 * store is, and nothing wakes the container to browse or edit files.
 *
 * Between the two (the container starting, or stopping) the store is read:
 * what it holds is the workspace as last saved. A write waits until the
 * container has settled, so it never lands in a container that is still
 * restoring its workspace, or in a store that a stopping container is about
 * to save over.
 *
 * Which side an operation uses is decided when it starts. An open file stays
 * on the side it was opened on.
 */
import type { OpenFile, StoreFileOps } from './types'

export type WorkspacePhase = 'awake' | 'asleep' | 'changing'

export interface SwitchingFileOpsOptions {
  /** Where the container is now. */
  phase: () => WorkspacePhase
  /** The workspace inside the running container. */
  awake: StoreFileOps
  /** The provider's store, the workspace while the container is down. */
  asleep: StoreFileOps
  /** Wait before looking at the phase again. Tests make it instant. */
  pause?: () => Promise<void>
  /** How long a write waits for the container to settle before it fails. */
  settleTimeoutMs?: number
}

const DEFAULT_SETTLE_TIMEOUT_MS = 120_000
const SETTLE_POLL_MS = 100

export function switchingFileOps(options: SwitchingFileOpsOptions): StoreFileOps {
  const { awake, asleep } = options
  const pause = options.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, SETTLE_POLL_MS)))
  const timeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS

  const forRead = (): StoreFileOps => (options.phase() === 'awake' ? awake : asleep)

  const forWrite = async (): Promise<StoreFileOps> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const phase = options.phase()
      if (phase !== 'changing') return phase === 'awake' ? awake : asleep
      if (Date.now() >= deadline) {
        throw new Error(`The agent's container did not settle within ${Math.round(timeoutMs / 1000)}s; the write was not made`)
      }
      await pause()
    }
  }

  return {
    list: (dir) => forRead().list(dir),
    stat: (path) => forRead().stat(path),
    resolve: (path) => forRead().resolve(path),
    read: (path, range) => forRead().read(path, range),
    readSized: (path, opts) => forRead().readSized(path, opts),
    getDoc: (path) => forRead().getDoc(path),
    open: (path, opts): Promise<OpenFile> => forRead().open(path, opts),
    putDoc: async (path, bytes, opts) => (await forWrite()).putDoc(path, bytes, opts),
    write: async (path, body, opts) => {
      let side: StoreFileOps
      try {
        side = await forWrite()
      } catch (error) {
        // A write that is not made must not leave the caller's source open.
        if (!(body instanceof Uint8Array)) await body.cancel().catch(() => {})
        throw error
      }
      return side.write(path, body, opts)
    },
    delete: async (path, opts) => (await forWrite()).delete(path, opts),
    mkdir: async (path) => (await forWrite()).mkdir(path),
    append: async (path, bytes) => (await forWrite()).append(path, bytes),
  }
}
