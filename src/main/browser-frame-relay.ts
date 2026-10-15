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
 *
 * VP8 frames only decode on top of every frame before them, so they can't be
 * skipped the same way: after a dropped VP8 frame the relay asks the container
 * for a keyframe and drops frames until that keyframe gets through.
 */
import { isVp8FrameMessage, isVp8KeyFrameMessage } from '@shared/lib/browser-stream-protocol'

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
  private awaitingKeyframe = false

  constructor(
    private readonly sink: FrameSink,
    private readonly maxBuffered = MAX_BUFFERED_FRAME_BYTES,
    private readonly requestKeyframe: () => void = () => {},
  ) {}

  forward(data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void {
    if (this.sink.readyState !== WEBSOCKET_OPEN) return
    if (!isBinary) { this.sink.send(data, { binary: false }); return }
    const bytes = toBytes(data)
    if (isVp8FrameMessage(bytes)) { this.forwardVp8(data, isVp8KeyFrameMessage(bytes)); return }
    if (this.sink.bufferedAmount > this.maxBuffered) {
      this.held = data
      this.scheduleDrain()
      return
    }
    this.held = null
    this.sink.send(data, { binary: true })
  }

  private forwardVp8(data: Buffer | ArrayBuffer | Buffer[], keyFrame: boolean): void {
    if (this.sink.bufferedAmount > this.maxBuffered) {
      if (keyFrame) {
        this.held = data
        this.awaitingKeyframe = false
        this.scheduleDrain()
      } else {
        this.dropVp8Frame()
      }
      return
    }
    if (this.held) {
      this.sink.send(this.held, { binary: true })
      this.held = null
    }
    if (keyFrame) this.awaitingKeyframe = false
    else if (this.awaitingKeyframe) return
    this.sink.send(data, { binary: true })
  }

  private dropVp8Frame(): void {
    if (this.awaitingKeyframe) return
    this.awaitingKeyframe = true
    this.requestKeyframe()
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

function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return data[0] ?? new Uint8Array()
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data
}
