import { describe, it, expect } from 'vitest';
import { screencastSize } from './screencast-size';

describe('screencastSize', () => {
  it('keeps the old 1280×720 cap before the viewer reports a width', () => {
    expect(screencastSize(undefined)).toEqual({ maxWidth: 1280, maxHeight: 720 });
  });

  it('never streams frames wider than the viewer canvas', () => {
    expect(screencastSize(704)).toEqual({ maxWidth: 704 });
    expect(screencastSize(2304)).toEqual({ maxWidth: 2304 });
  });
});
