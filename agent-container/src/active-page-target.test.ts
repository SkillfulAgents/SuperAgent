import { describe, expect, it } from 'vitest';
import { selectActivePageTarget } from './active-page-target';

const urlsMatch = (left: string, right: string) => left === right;
const targets = [
  { id: 'background', url: 'about:blank', marker: 'wrong' },
  { id: 'pge', url: 'https://myaccount.pge.com/myaccount/s/login/', marker: 'right' },
];

describe('selectActivePageTarget', () => {
  it('uses the daemon active tab when its URL matches a CDP target', () => {
    expect(selectActivePageTarget(
      targets,
      [{ url: targets[1].url, active: true }],
      'background',
      urlsMatch,
    )).toBe(targets[1]);
  });

  it('uses the visible viewer target when the daemon URL is stale', () => {
    expect(selectActivePageTarget(
      targets,
      [{ url: 'https://www.pge.com/', active: true }],
      'pge',
      urlsMatch,
    )).toBe(targets[1]);
  });

  it('falls back to Chrome target ordering without an active match or viewer', () => {
    expect(selectActivePageTarget(targets, [], null, urlsMatch)).toBe(targets[0]);
  });

  it('returns null when Chrome has no page targets', () => {
    expect(selectActivePageTarget([], [], null, urlsMatch)).toBeNull();
  });
});
