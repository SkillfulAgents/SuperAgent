export interface PageTargetCandidate {
  id: string;
  url: string;
}

export interface BrowserTabCandidate {
  url: string;
  active: boolean;
}

/**
 * Resolve the page the user is actually viewing.
 *
 * The daemon URL is preferred while it is current. In host-browser/CDP mode
 * the daemon can retain the pre-navigation URL, so the viewer's current CDP
 * target is the safest fallback before relying on Chrome's target ordering.
 */
export function selectActivePageTarget<T extends PageTargetCandidate>(
  targets: T[],
  daemonTabs: BrowserTabCandidate[],
  viewerTargetId: string | null,
  urlsMatch: (left: string, right: string) => boolean,
): T | null {
  if (targets.length === 0) return null;
  if (targets.length === 1) return targets[0];

  const activeDaemonTab = daemonTabs.find((tab) => tab.active);
  if (activeDaemonTab) {
    const daemonTarget = targets.find((target) => urlsMatch(target.url, activeDaemonTab.url));
    if (daemonTarget) return daemonTarget;
  }

  if (viewerTargetId) {
    const viewerTarget = targets.find((target) => target.id === viewerTargetId);
    if (viewerTarget) return viewerTarget;
  }

  return targets[0];
}
