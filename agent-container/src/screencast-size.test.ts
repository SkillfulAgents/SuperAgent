import { describe, it, expect } from 'vitest';
import { keptAcrossTabSwitch, screencastSize } from './screencast-size';

describe('screencastSize', () => {
  it('leaves Chrome alone and streams the full page before the viewer reports a width', () => {
    expect(screencastSize(undefined, 1280, 720)).toEqual({ override: null, maxWidth: 1280, maxHeight: 720 });
  });

  it('keeps a small card at 1x and trims frames to the card width', () => {
    expect(screencastSize(896, 1280, 720)).toEqual({ override: null, maxWidth: 896, maxHeight: 720 });
  });

  it('rounds a medium panel up to the next quarter step', () => {
    expect(screencastSize(1600, 1280, 720)).toEqual({ override: 1.25, maxWidth: 1600, maxHeight: 900 });
  });

  it('caps full screen on a Retina screen at 2x', () => {
    expect(screencastSize(3456, 1280, 720)).toEqual({ override: 2, maxWidth: 2560, maxHeight: 1440 });
  });

  it('never lowers a Chrome that already renders at 2x', () => {
    expect(screencastSize(1600, 1280, 720, 2)).toEqual({ override: null, maxWidth: 1600, maxHeight: 900 });
    expect(screencastSize(3456, 1280, 720, 2)).toEqual({ override: null, maxWidth: 2560, maxHeight: 1440 });
  });
});

describe('keptAcrossTabSwitch', () => {
  const sizeAfterSwitch = (viewerWidth: number, prev: Parameters<typeof keptAcrossTabSwitch>[0]) => {
    const kept = keptAcrossTabSwitch(prev);
    return screencastSize(viewerWidth, kept.lastDeviceWidth || 1280, kept.lastDeviceHeight || 720, kept.nativeScale);
  };

  it('sizes the new tab from the window it left, so a 1920 px host window stays at 1x for a 1600 px canvas', () => {
    expect(sizeAfterSwitch(1600, { lastDeviceWidth: 1920, lastDeviceHeight: 1080, nativeScale: 1 }))
      .toEqual({ override: null, maxWidth: 1600, maxHeight: 1080 });
  });

  it('keeps a Retina host window at its own 2x instead of forcing a lower ratio before Chrome answers', () => {
    expect(sizeAfterSwitch(1600, { lastDeviceWidth: 1440, lastDeviceHeight: 900, nativeScale: 2 }).override).toBeNull();
  });

  it('starts from nothing on a new viewer connection', () => {
    expect(keptAcrossTabSwitch(null)).toEqual({ lastDeviceWidth: 0, lastDeviceHeight: 0, nativeScale: 1 });
  });
});
