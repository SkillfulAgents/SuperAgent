export interface PageTargetCandidate {
  id: string;
  url: string;
}

export interface BrowserTabCandidate {
  url: string;
  active: boolean;
}

export interface ActivePageTargetSelectionOptions {
  /** The CDP target currently rendered in the browser viewer. */
  viewerTargetId?: string | null;
  /** Use the viewer before daemon/MRU resolution for user-directed actions. */
  preferViewer?: boolean;
}

/**
 * Resolve Chrome's active page, optionally giving a user-selected viewer page
 * priority for operations that act on exactly what the user is looking at.
 *
 * Viewer priority must stay opt-in: auto-follow callers are trying to discover
 * where the viewer should move and would become sticky if its current target
 * were used as their fallback.
 */
export function selectActivePageTarget<T extends PageTargetCandidate>(
  targets: T[],
  daemonTabs: BrowserTabCandidate[],
  urlsMatch: (left: string, right: string) => boolean,
  options: ActivePageTargetSelectionOptions = {},
): T | null {
  if (targets.length === 0) return null;
  if (targets.length === 1) return targets[0];

  if (options.preferViewer && options.viewerTargetId) {
    const viewerTarget = targets.find((target) => target.id === options.viewerTargetId);
    if (viewerTarget) return viewerTarget;
  }

  const activeDaemonTab = daemonTabs.find((tab) => tab.active);
  if (activeDaemonTab) {
    const daemonTarget = targets.find((target) => urlsMatch(target.url, activeDaemonTab.url));
    if (daemonTarget) return daemonTarget;
  }

  return targets[0];
}
