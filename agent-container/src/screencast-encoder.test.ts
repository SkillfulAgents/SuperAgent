import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { isH264FrameMessage, isH264KeyFrameMessage } from './browser-stream-protocol';
import { AnnexBFrameReader, jpegSize, FLUSH_AFTER_QUIET_MS, FLUSH_INTERVAL_MS, FLUSH_REPEATS, H264ScreencastEncoder } from './screencast-encoder';

const nal = (type: number, ...payload: number[]) => [0, 0, 0, 1, type, ...payload];

describe('AnnexBFrameReader', () => {
  it('splits frames at access unit delimiters across chunk boundaries and spots IDR frames', () => {
    const stream = Buffer.from([
      ...nal(0x09, 0xf0), ...nal(0x67, 1), ...nal(0x65, 2, 3),
      ...nal(0x09, 0xf0), ...nal(0x41, 4),
      ...nal(0x09, 0xf0),
    ]);
    const reader = new AnnexBFrameReader();
    const frames = [...reader.push(stream.subarray(0, 9)), ...reader.push(stream.subarray(9, 31)), ...reader.push(stream.subarray(31))];
    expect(frames.map(f => f.keyFrame)).toEqual([true, false]);
    expect([...frames[1].frame]).toEqual([...nal(0x09, 0xf0), ...nal(0x41, 4)]);
  });
});

describe('jpegSize', () => {
  it('reads the size from the start-of-frame marker after other segments', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03]);
    expect(jpegSize(jpeg)).toEqual({ width: 1280, height: 720 });
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** Three standalone 320x180 JPEGs of a moving test pattern, like Chrome's screencast frames. */
function testJpegs(): Buffer[] {
  return [0, 0.1, 0.2].map(at => spawnSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-ss', String(at), '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1',
  ]).stdout);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const FLUSH_WINDOW_MS = FLUSH_AFTER_QUIET_MS + FLUSH_INTERVAL_MS * FLUSH_REPEATS + 500;

describe.skipIf(!hasFfmpeg)('H264ScreencastEncoder with ffmpeg', () => {
  it('starts a new stream on a keyframe when the frame size changes', async () => {
    const messages: Uint8Array[] = [];
    const encoder = new H264ScreencastEncoder(message => messages.push(message));
    const [small] = testJpegs();
    const large = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']).stdout;
    encoder.push(small);
    await sleep(FLUSH_WINDOW_MS);
    const before = messages.length;
    encoder.push(large);
    await sleep(FLUSH_WINDOW_MS);
    expect(messages.length).toBeGreaterThan(before);
    expect(isH264KeyFrameMessage(messages[before])).toBe(true);
    encoder.close();
  }, 15_000);

  it('starts on a keyframe and delivers the last frame while the page is still', async () => {
    const messages: Uint8Array[] = [];
    const encoder = new H264ScreencastEncoder(message => messages.push(message));
    const jpegs = testJpegs();
    expect(jpegs).toHaveLength(3);
    for (const jpeg of jpegs) { encoder.push(jpeg); await sleep(50); }
    // No new input after this point, like Chrome on a still page.
    await sleep(FLUSH_WINDOW_MS);
    expect(messages.every(isH264FrameMessage)).toBe(true);
    expect(isH264KeyFrameMessage(messages[0])).toBe(true);
    expect(messages.length).toBeGreaterThanOrEqual(jpegs.length);

    const before = messages.length;
    encoder.requestKeyframe();
    await sleep(FLUSH_WINDOW_MS);
    expect(isH264KeyFrameMessage(messages[before])).toBe(true);
    encoder.close();
  }, 15_000);
});
