/**
 * Detecting that the browser went away without anyone telling us.
 *
 * The host notices Chrome *quitting* (the process dies) and posts
 * /browser/notify-closed. It cannot notice Chrome losing its last *window*:
 * on macOS the app stays alive with zero pages, so the process check keeps
 * passing while the screencast has nothing left to stream. Both cases surface
 * the same way here — the CDP target list has no page in it.
 */

/** How long to wait before taking a second look for a page target. */
export const PAGE_TARGET_RECHECK_MS = 750;

/**
 * A screencast connect that finds no page target usually means the browser is
 * gone, but a tab can be missing for a moment right after browser_open —
 * Chrome creates the target slightly after the daemon reports success. Look
 * once more before tearing the browser down. Resolves to the target the second
 * look found, or null when the browser really has no page left.
 */
export async function recheckPageTarget<T>(
  findTarget: () => Promise<T | null>,
  sleep: (ms: number) => Promise<unknown>,
): Promise<T | null> {
  await sleep(PAGE_TARGET_RECHECK_MS);
  try {
    return await findTarget();
  } catch {
    // Can't reach Chrome — no target to report. Whether that means the
    // browser is closed is confirmNoPagesLeft's call, not ours.
    return null;
  }
}

/**
 * Read the two tab sources the viewer reconciles: Chrome's own page targets,
 * and agent-browser's view of them.
 *
 * The guard is not an optimisation. Asking agent-browser for a tab list when
 * the browser has no page MAKES one — the daemon opens about:blank so it has
 * something to report. A 2s poll doing that resurrects the window the user
 * just closed, and hands the close detector a phantom tab to recover onto.
 * Chrome's target list is the authority on whether any page exists; when it
 * says none, there is nothing for the daemon to reconcile.
 */
export async function readTabSources<Target, DaemonTab>(
  listPageTargets: () => Promise<Target[]>,
  listDaemonTabs: () => Promise<DaemonTab[]>,
): Promise<{ allTargets: Target[]; daemonTabs: DaemonTab[] }> {
  const allTargets = await listPageTargets();
  if (allTargets.length === 0) return { allTargets, daemonTabs: [] };
  return { allTargets, daemonTabs: await listDaemonTabs() };
}

/**
 * Only Chrome itself can testify that it has no pages left.
 *
 * The lenient target lookups above swallow every network failure into "no
 * targets", which reads exactly like a closed browser — but an unreachable
 * endpoint proves nothing. A dead Chrome process is the host watcher's case
 * (it posts /browser/notify-closed), and a transient container↔host outage
 * fails both lookups at once, 750ms being no de-correlation at all. Tearing
 * down on that would orphan a live browser we just lost the address of.
 * So the close verdict needs an answered request whose answer held no page;
 * anything else resolves false and leaves the state alone.
 */
export async function confirmNoPagesLeft(
  listPageTargetsStrict: () => Promise<readonly unknown[]>,
): Promise<boolean> {
  try {
    return (await listPageTargetsStrict()).length === 0;
  } catch {
    return false;
  }
}
