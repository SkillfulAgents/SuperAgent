import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { isVp8FrameMessage, isVp8KeyFrameMessage } from './browser-stream-protocol';
import { FLUSH_AFTER_QUIET_MS, FLUSH_INTERVAL_MS, IvfFrameReader, Vp8ScreencastEncoder } from './screencast-encoder';

function ivfFrame(payload: number[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, Buffer.from(payload)]);
}

describe('IvfFrameReader', () => {
  it('splits frames across arbitrary chunk boundaries and reads the keyframe bit', () => {
    const stream = Buffer.concat([Buffer.alloc(32), ivfFrame([0x10, 1, 2]), ivfFrame([0x11, 3])]);
    const reader = new IvfFrameReader();
    const frames = [...reader.push(stream.subarray(0, 20)), ...reader.push(stream.subarray(20, 47)), ...reader.push(stream.subarray(47))];
    expect(frames.map(f => [...f.frame])).toEqual([[0x10, 1, 2], [0x11, 3]]);
    expect(frames.map(f => f.keyFrame)).toEqual([true, false]);
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** Three 320x180 JPEGs of a moving test pattern, split at each JPEG start marker. */
function testJpegs(): Buffer[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-frames:v', '3', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']).stdout;
  const starts: number[] = [];
  for (let i = 0; i < out.length - 2; i++) if (out[i] === 0xff && out[i + 1] === 0xd8 && out[i + 2] === 0xff) starts.push(i);
  return starts.map((start, i) => out.subarray(start, starts[i + 1] ?? out.length));
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(!hasFfmpeg)('Vp8ScreencastEncoder with ffmpeg', () => {
  it('starts on a keyframe and delivers the last frame while the page is still', async () => {
    const messages: Uint8Array[] = [];
    const encoder = new Vp8ScreencastEncoder(message => messages.push(message));
    const jpegs = testJpegs();
    expect(jpegs).toHaveLength(3);
    for (const jpeg of jpegs) { encoder.push(jpeg); await sleep(50); }
    // No new input after this point, like Chrome on a still page.
    await sleep(FLUSH_AFTER_QUIET_MS + FLUSH_INTERVAL_MS * 4 + 500);
    expect(messages.every(isVp8FrameMessage)).toBe(true);
    expect(isVp8KeyFrameMessage(messages[0])).toBe(true);
    expect(messages.length).toBeGreaterThanOrEqual(jpegs.length);

    const before = messages.length;
    encoder.requestKeyframe();
    await sleep(FLUSH_AFTER_QUIET_MS + FLUSH_INTERVAL_MS * 4 + 500);
    expect(isVp8KeyFrameMessage(messages[before])).toBe(true);
    encoder.close();
  }, 15_000);
});
