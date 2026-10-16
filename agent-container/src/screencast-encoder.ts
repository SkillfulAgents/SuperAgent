import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { encodeH264FrameMessage } from './browser-stream-protocol';

/**
 * Re-encodes the CDP screencast (one JPEG per repaint) as H.264 with ffmpeg, so
 * an unchanged region costs almost nothing and the bytes go to sharper text.
 *
 * ffmpeg hands back a frame only once a later frame has gone in (the CLI keeps
 * one, and a raw H.264 frame ends where the next one starts). Chrome sends
 * nothing while a page is still, so after a scroll stops the viewer would sit
 * on a stale frame. A short burst of repeats of the last JPEG pushes it out.
 */
export const FLUSH_AFTER_QUIET_MS = 120;
export const FLUSH_INTERVAL_MS = 30;
export const FLUSH_REPEATS = 3;
/** Input backlog beyond which new JPEGs are skipped instead of queued behind a slow encoder. */
const MAX_PENDING_INPUT_BYTES = 4 * 1024 * 1024;

const ffmpegArgs = (maxBitrate: string) => [
  '-hide_banner', '-loglevel', 'error',
  '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0',
  // Matroska input carries each JPEG's length, so ffmpeg needn't wait for the next one to split them.
  '-threads', '1', '-f', 'matroska', '-i', 'pipe:0',
  '-vsync', 'passthrough', '-pix_fmt', 'yuv420p',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '1',
  '-crf', '18', '-maxrate', maxBitrate, '-bufsize', maxBitrate, '-g', '9999',
  // In-band SPS/PPS make every keyframe decodable alone; AUDs mark where each frame starts.
  // fps: the millisecond timestamps otherwise read as 1000 fps and starve each frame of the bitrate cap.
  '-x264-params', 'repeat-headers=1:aud=1:fps=30',
  '-flush_packets', '1', '-f', 'h264', 'pipe:1',
];

/** EBML element with an 8-byte size field. */
function ebml(id: string, body: Buffer): Buffer {
  const size = Buffer.alloc(8);
  size[0] = 0x01;
  size.writeUIntBE(body.length, 2, 6);
  return Buffer.concat([Buffer.from(id, 'hex'), size, body]);
}

const uint32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };

export interface FrameSize { width: number; height: number }

/** Width and height from a JPEG's start-of-frame marker. */
export function jpegSize(jpeg: Buffer): FrameSize | null {
  let i = 2;
  while (i + 9 < jpeg.length && jpeg[i] === 0xff) {
    const marker = jpeg[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    }
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  return null;
}

/** Matroska header for one MJPEG track, followed by a segment of unknown length. */
export function matroskaHeader(size: FrameSize): Buffer {
  const header = ebml('1a45dfa3', Buffer.concat([
    ebml('4286', uint32(1)), ebml('42f7', uint32(1)), ebml('42f2', uint32(4)), ebml('42f3', uint32(8)),
    ebml('4282', Buffer.from('matroska')), ebml('4287', uint32(4)), ebml('4285', uint32(2)),
  ]));
  const info = ebml('1549a966', ebml('2ad7b1', uint32(1_000_000)));
  // ffmpeg 8 rejects frames whose size differs from the track's, so a new size starts a new stream.
  const video = ebml('e0', Buffer.concat([ebml('b0', uint32(size.width)), ebml('ba', uint32(size.height))]));
  const track = ebml('ae', Buffer.concat([
    ebml('d7', uint32(1)), ebml('73c5', uint32(1)), ebml('83', uint32(1)), ebml('86', Buffer.from('V_MJPEG')), video,
  ]));
  return Buffer.concat([header, Buffer.from('1853806701ffffffffffffff', 'hex'), info, ebml('1654ae6b', track)]);
}

/** One JPEG as a cluster holding a single keyframe block at `timestampMs`. */
export function matroskaFrame(jpeg: Buffer, timestampMs: number): Buffer {
  const block = Buffer.concat([Buffer.from([0x81, 0x00, 0x00, 0x80]), jpeg]);
  return ebml('1f43b675', Buffer.concat([ebml('e7', uint32(timestampMs)), ebml('a3', block)]));
}

/** Splits an Annex B stream into frames at access unit delimiters (NAL type 9). */
export class AnnexBFrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  private scanFrom = 0;

  push(chunk: Buffer): Array<{ frame: Buffer; keyFrame: boolean }> {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames: Array<{ frame: Buffer; keyFrame: boolean }> = [];
    let frameStart = this.findDelimiter(0);
    if (frameStart < 0) return frames;
    let next = this.findDelimiter(Math.max(frameStart + 4, this.scanFrom));
    while (next >= 0) {
      const frame = this.buffer.subarray(frameStart, next);
      frames.push({ frame, keyFrame: containsIdrSlice(frame) });
      frameStart = next;
      next = this.findDelimiter(frameStart + 4);
    }
    this.buffer = this.buffer.subarray(frameStart);
    this.scanFrom = Math.max(4, this.buffer.length - 4);
    return frames;
  }

  private findDelimiter(from: number): number {
    for (let i = from; i + 3 < this.buffer.length; i++) {
      if (this.buffer[i] === 0 && this.buffer[i + 1] === 0 && this.buffer[i + 2] === 1 && (this.buffer[i + 3] & 0x1f) === 9) {
        return i > 0 && this.buffer[i - 1] === 0 ? i - 1 : i;
      }
    }
    return -1;
  }
}

function containsIdrSlice(frame: Buffer): boolean {
  for (let i = 0; i + 3 < frame.length; i++) {
    if (frame[i] === 0 && frame[i + 1] === 0 && frame[i + 2] === 1 && (frame[i + 3] & 0x1f) === 5) return true;
  }
  return false;
}

export class H264ScreencastEncoder {
  private ffmpeg: ChildProcessWithoutNullStreams | null = null;
  private size: FrameSize | null = null;
  private startedAt = 0;
  private lastTimestamp = -1;
  private lastJpeg: Buffer | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  /** `maxBitrate` is an ffmpeg cap such as '4M'; text at higher pixel ratios needs more. */
  constructor(private readonly send: (message: Uint8Array) => void, private readonly maxBitrate = '4M') {}

  push(jpeg: Buffer): void {
    if (this.closed) return;
    this.lastJpeg = jpeg;
    this.write(jpeg);
    this.scheduleFlush();
  }

  /** Start a new H.264 stream (its first frame is a keyframe) from the current picture. */
  requestKeyframe(): void {
    if (this.closed) return;
    this.stopFfmpeg();
    if (!this.lastJpeg) return;
    this.write(this.lastJpeg);
    this.scheduleFlush();
  }

  close(): void {
    this.closed = true;
    this.lastJpeg = null;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.stopFfmpeg();
  }

  private write(jpeg: Buffer): void {
    const size = jpegSize(jpeg);
    if (!size) return;
    if (this.ffmpeg && (size.width !== this.size?.width || size.height !== this.size?.height)) this.stopFfmpeg();
    const ffmpeg = this.ffmpeg ?? this.startFfmpeg(size);
    if (ffmpeg.stdin.writableLength > MAX_PENDING_INPUT_BYTES) return;
    // Repeats can land in the same millisecond; equal timestamps are rejected by the muxer.
    this.lastTimestamp = Math.max(Date.now() - this.startedAt, this.lastTimestamp + 1);
    ffmpeg.stdin.write(matroskaFrame(jpeg, this.lastTimestamp));
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

  private startFfmpeg(size: FrameSize): ChildProcessWithoutNullStreams {
    const ffmpeg = spawn('ffmpeg', ffmpegArgs(this.maxBitrate), { stdio: ['pipe', 'pipe', 'pipe'] });
    const reader = new AnnexBFrameReader();
    ffmpeg.stdout.on('data', (chunk: Buffer) => {
      if (this.ffmpeg !== ffmpeg) return;
      for (const { frame, keyFrame } of reader.push(chunk)) this.send(encodeH264FrameMessage(frame, keyFrame));
    });
    ffmpeg.stderr.on('data', (chunk: Buffer) => console.error('[Screencast] ffmpeg:', chunk.toString().trim()));
    // A killed process can still be mid-write; the next push starts a fresh one.
    ffmpeg.stdin.on('error', () => {});
    ffmpeg.on('error', (err) => console.error('[Screencast] ffmpeg failed to start:', err.message));
    ffmpeg.on('exit', () => { if (this.ffmpeg === ffmpeg) this.ffmpeg = null; });
    this.ffmpeg = ffmpeg;
    this.size = size;
    this.startedAt = Date.now();
    this.lastTimestamp = -1;
    ffmpeg.stdin.write(matroskaHeader(size));
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
