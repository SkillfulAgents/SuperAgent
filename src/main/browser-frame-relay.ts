/**
 * Forwards screencast frames from the container to one viewer without letting
 * a slow link fall behind the page.
 *
 * Binary messages are JPEGs, one per repaint. When the viewer's socket has
 * more unsent bytes than a couple of frames (a remote viewer behind a tunnel),
 * new frames are held back instead of queued, or the picture ends up seconds
 * behind. The newest held frame is kept and sent once the socket drains, so a
 * page that stops repainting after a burst still ends on its current state
 * rather than on whatever frame happened to get through. Text frames are
 * small state updates and always go through.
 */
export interface FrameSink {
  readonly readyState: number
  readonly bufferedAmount: number
  send(data: Buffer | ArrayBuffer | Buffer[], options: { binary: boolean }): void
}

export const WEBSOCKET_OPEN = 1
/** Unsent bytes on a client socket beyond which new screencast frames are held (about two 720p JPEGs). */
export const MAX_BUFFERED_FRAME_BYTES = 512 * 1024
/** How often a held frame is retried while the socket drains. */
export const FRAME_DRAIN_POLL_MS = 50

export class BrowserFrameRelay {
  private held: Buffer | ArrayBuffer | Buffer[] | null = null
  private drainTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly sink: FrameSink, private readonly maxBuffered = MAX_BUFFERED_FRAME_BYTES) {}

  forward(data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void {
    if (this.sink.readyState !== WEBSOCKET_OPEN) return
    if (!isBinary) { this.sink.send(data, { binary: false }); return }
    if (this.sink.bufferedAmount > this.maxBuffered) {
      this.held = data
      this.scheduleDrain()
      return
    }
    this.held = null
    this.sink.send(data, { binary: true })
  }

  /** Stop waiting on the socket; nothing held is sent afterwards. */
  close(): void {
    this.held = null
    if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null }
  }

  private scheduleDrain(): void {
    if (this.drainTimer) return
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      if (!this.held || this.sink.readyState !== WEBSOCKET_OPEN) { this.held = null; return }
      if (this.sink.bufferedAmount > this.maxBuffered) { this.scheduleDrain(); return }
      const frame = this.held
      this.held = null
      this.sink.send(frame, { binary: true })
    }, FRAME_DRAIN_POLL_MS)
  }
}
