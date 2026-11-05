import { describe, it, expect } from 'vitest';
import { clampViewerWidth, jpegWidth, sameFrames, screencastSize } from './screencast-size';

describe('screencastSize', () => {
  it('keeps the old 1280×720 cap before the viewer reports a width', () => {
    expect(screencastSize(undefined)).toEqual({ maxWidth: 1280, maxHeight: 720 });
  });

  it('never streams frames wider than the viewer canvas, and caps the height', () => {
    expect(screencastSize(704)).toEqual({ maxWidth: 704, maxHeight: 2560 });
  });
});

describe('clampViewerWidth', () => {
  it('bounds widths to 64–2560 integers', () => {
    expect(clampViewerWidth(840.6)).toBe(841);
    expect(clampViewerWidth('900')).toBe(900);
    expect(clampViewerWidth(10)).toBe(64);
    expect(clampViewerWidth(5000)).toBe(2560);
  });

  it('rejects values that are not usable widths', () => {
    expect(clampViewerWidth(JSON.parse('{"width":1e400}').width)).toBeUndefined();
    expect(clampViewerWidth(0)).toBeUndefined();
    expect(clampViewerWidth(-5)).toBeUndefined();
    expect(clampViewerWidth(null)).toBeUndefined();
    expect(clampViewerWidth('wide')).toBeUndefined();
  });
});

describe('sameFrames', () => {
  const capped = (maxWidth: number) => screencastSize(maxWidth);

  it('holds when the size is already running, whatever the last frame was', () => {
    expect(sameFrames(capped(1408), capped(1408), undefined)).toBe(true);
    expect(sameFrames(screencastSize(undefined), screencastSize(undefined), 900)).toBe(true);
  });

  it('holds once both caps are at or above a frame narrower than the running cap', () => {
    // A 1x page (1280 raw) in a Retina tray: 1408 → 1472 changes nothing.
    expect(sameFrames(capped(1408), capped(1472), 1280)).toBe(true);
    expect(sameFrames(capped(1408), capped(1280), 1280)).toBe(true);
  });

  it('does not hold when the new cap is below the frame or the raw width is unknown', () => {
    expect(sameFrames(capped(1408), capped(1000), 1280)).toBe(false);
    // A frame as wide as its cap may have been scaled down, so the raw width is unknown.
    expect(sameFrames(capped(1000), capped(1400), 1000)).toBe(false);
    expect(sameFrames(capped(1408), capped(1472), undefined)).toBe(false);
  });

  it('does not take the default 720 height cap for the page size', () => {
    // A tall page held to 720 high comes out narrow; the 2560 height cap would let it grow.
    expect(sameFrames(screencastSize(undefined), capped(1400), 400)).toBe(false);
  });
});

describe('jpegWidth', () => {
  it('reads the width from the start-of-frame header after other segments', () => {
    const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
    const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00];
    expect(jpegWidth(Buffer.from([0xff, 0xd8, ...app0, ...sof0, 0, 0, 0, 0]))).toBe(1280);
  });

  it('returns undefined for data that is not a JPEG', () => {
    expect(jpegWidth(Buffer.from('not a jpeg at all'))).toBeUndefined();
  });
});
