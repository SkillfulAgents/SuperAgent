import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { encodeVp8FrameMessage } from './browser-stream-protocol';

/**
 * Re-encodes the CDP screencast (one JPEG per repaint) as VP8 with ffmpeg, so
 * an unchanged region costs almost nothing and the bytes go to sharper text.
 *
 * The ffmpeg CLI holds the newest frame or two until the next one arrives
 * (it needs the next timestamp to finish the current frame). Chrome sends
 * nothing while a page is still, so after a scroll stops the viewer would sit
 * on a stale frame. A short burst of repeats of the last JPEG pushes it out.
 */
const BITRATE = '4M';
/** Quiet time before repeating the last frame, then the gap and count of repeats. */
export const FLUSH_AFTER_QUIET_MS = 150;
export const FLUSH_INTERVAL_MS = 100;
export const FLUSH_REPEATS = 4;
/** Input backlog beyond which new JPEGs are skipped instead of queued behind a slow encoder. */
const MAX_PENDING_INPUT_BYTES = 2 * 1024 * 1024;

const FFMPEG_ARGS = [
  '-hide_banner', '-loglevel', 'error',
  '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0',
  '-use_wallclock_as_timestamps', '1', '-threads', '1',
  '-f', 'image2pipe', '-c:v', 'mjpeg', '-i', 'pipe:0',
  '-vsync', 'passthrough', '-pix_fmt', 'yuv420p',
  '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-lag-in-frames', '0',
  '-error-resilient', '1', '-threads', '1', '-crf', '10', '-b:v', BITRATE, '-maxrate', BITRATE,
  '-g', '9999', '-flush_packets', '1', '-f', 'ivf', 'pipe:1',
];

/** Splits ffmpeg's IVF output (32-byte file header, then 12-byte frame headers) into frames. */
export class IvfFrameReader {
  private buffer = Buffer.alloc(0);
  private headerSkipped = false;

  push(chunk: Buffer): Array<{ frame: Buffer; keyFrame: boolean }> {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames: Array<{ frame: Buffer; keyFrame: boolean }> = [];
    if (!this.headerSkipped) {
      if (this.buffer.length < 32) return frames;
      this.buffer = this.buffer.subarray(32);
      this.headerSkipped = true;
    }
    while (this.buffer.length >= 12) {
      const size = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 12 + size) break;
      const frame = this.buffer.subarray(12, 12 + size);
      this.buffer = this.buffer.subarray(12 + size);
      // VP8 frame tag: bit 0 clear marks a keyframe.
      frames.push({ frame, keyFrame: size > 0 && (frame[0] & 1) === 0 });
    }
    return frames;
  }
}

export class Vp8ScreencastEncoder {
  private ffmpeg: ChildProcessWithoutNullStreams | null = null;
  private lastJpeg: Buffer | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly send: (message: Uint8Array) => void) {}

  push(jpeg: Buffer): void {
    if (this.closed) return;
    this.lastJpeg = jpeg;
    this.write(jpeg);
    this.scheduleFlush();
  }

  /** Start a new VP8 stream (its first frame is a keyframe) from the current picture. */
  requestKeyframe(): void {
    if (this.closed) return;
    this.stopFfmpeg();
    if (!this.lastJpeg) return;
    this.write(this.lastJpeg);
    this.scheduleFlush();
  }

  /** Drop the current stream; the next pushed frame starts a new one at its own size. */
  reset(): void {
    this.stopFfmpeg();
  }

  close(): void {
    this.closed = true;
    this.lastJpeg = null;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.stopFfmpeg();
  }

  private write(jpeg: Buffer): void {
    const ffmpeg = this.ffmpeg ?? this.startFfmpeg();
    if (ffmpeg.stdin.writableLength > MAX_PENDING_INPUT_BYTES) return;
    ffmpeg.stdin.write(jpeg);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    let repeatsLeft = FLUSH_REPEATS;
    const repeat = () => {
      this.flushTimer = null;
      if (this.closed || !this.lastJpeg || repeatsLeft-- <= 0) return;
      this.write(this.lastJpeg);
      this.flushTimer = setTimeout(repeat, FLUSH_INTERVAL_MS);
    };
    this.flushTimer = setTimeout(repeat, FLUSH_AFTER_QUIET_MS);
  }

  private startFfmpeg(): ChildProcessWithoutNullStreams {
    const ffmpeg = spawn('ffmpeg', FFMPEG_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
    const reader = new IvfFrameReader();
    ffmpeg.stdout.on('data', (chunk: Buffer) => {
      if (this.ffmpeg !== ffmpeg) return;
      for (const { frame, keyFrame } of reader.push(chunk)) this.send(encodeVp8FrameMessage(frame, keyFrame));
    });
    ffmpeg.stderr.on('data', (chunk: Buffer) => console.error('[Screencast] ffmpeg:', chunk.toString().trim()));
    // A killed process can still be mid-write; the next push starts a fresh one.
    ffmpeg.stdin.on('error', () => {});
    ffmpeg.on('error', (err) => console.error('[Screencast] ffmpeg failed to start:', err.message));
    ffmpeg.on('exit', () => { if (this.ffmpeg === ffmpeg) this.ffmpeg = null; });
    this.ffmpeg = ffmpeg;
    return ffmpeg;
  }

  private stopFfmpeg(): void {
    const ffmpeg = this.ffmpeg;
    this.ffmpeg = null;
    if (!ffmpeg) return;
    ffmpeg.stdin.destroy();
    ffmpeg.kill('SIGKILL');
  }
}
