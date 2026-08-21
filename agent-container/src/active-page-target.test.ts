import { describe, expect, it } from 'vitest';
import { selectActivePageTarget } from './active-page-target';
import { tabManager } from './tab-manager';

const urlsMatch = (left: string, right: string) => tabManager.urlsMatch(left, right);
const targets = [
  { id: 'background', url: 'about:blank', marker: 'wrong' },
  { id: 'pge', url: 'https://myaccount.pge.com/myaccount/s/login/', marker: 'right' },
];

describe('selectActivePageTarget', () => {
  it('uses the daemon active tab when its URL matches a CDP target', () => {
    expect(selectActivePageTarget(
      targets,
      [{ url: targets[1].url, active: true }],
      urlsMatch,
      { viewerTargetId: 'background' },
    )).toBe(targets[1]);
  });

  it('uses the visible viewer target first when the caller opts in', () => {
    expect(selectActivePageTarget(
      targets,
      [{ url: 'https://www.pge.com/', active: true }],
      urlsMatch,
      { viewerTargetId: 'pge', preferViewer: true },
    )).toBe(targets[1]);
  });

  it('keeps the viewer authoritative even when the daemon matches another tab', () => {
    const duplicateUrlTargets = [
      { id: 'background', url: 'https://myaccount.pge.com/myaccount/s/login/?language=en_US#background' },
      { id: 'viewer', url: 'https://myaccount.pge.com/myaccount/s/login?language=en_US#viewer' },
    ];
    const normalizedDaemonUrl = 'https://myaccount.pge.com/myaccount/s/login?language=en_US';

    expect(urlsMatch(duplicateUrlTargets[0].url, normalizedDaemonUrl)).toBe(true);
    expect(urlsMatch(duplicateUrlTargets[1].url, normalizedDaemonUrl)).toBe(true);

    expect(selectActivePageTarget(
      duplicateUrlTargets,
      [{ url: normalizedDaemonUrl, active: true }],
      urlsMatch,
      { viewerTargetId: 'viewer', preferViewer: true },
    )).toBe(duplicateUrlTargets[1]);
  });

  it('does not make auto-follow sticky when the daemon URL is stale', () => {
    expect(selectActivePageTarget(
      targets,
      [{ url: 'https://www.pge.com/', active: true }],
      urlsMatch,
      { viewerTargetId: 'pge' },
    )).toBe(targets[0]);
  });

  it('falls back to Chrome target ordering without an active match or viewer', () => {
    expect(selectActivePageTarget(targets, [], urlsMatch)).toBe(targets[0]);
  });

  it('returns null when Chrome has no page targets', () => {
    expect(selectActivePageTarget([], [], urlsMatch)).toBeNull();
  });
});
