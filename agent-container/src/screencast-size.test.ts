import { describe, it, expect } from 'vitest';
import { clampViewerWidth, screencastSize, viewerWidthMoved } from './screencast-size';

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

describe('viewerWidthMoved', () => {
  it('takes the first width, and any later one past the margin', () => {
    expect(viewerWidthMoved(undefined, 841)).toBe(true);
    expect(viewerWidthMoved(841, 873)).toBe(true);
    expect(viewerWidthMoved(841, 809)).toBe(true);
  });

  it('ignores the small nudges that frame size rounding causes', () => {
    expect(viewerWidthMoved(841, 841)).toBe(false);
    expect(viewerWidthMoved(841, 872)).toBe(false);
    expect(viewerWidthMoved(841, 810)).toBe(false);
  });
});
