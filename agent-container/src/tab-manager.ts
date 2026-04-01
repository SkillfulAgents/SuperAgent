/**
 * Tab Manager — centralized tab state, querying, detection, and message formatting.
 *
 * All tab-related logic lives here so server.ts and browser.ts can import shared helpers.
 * Each browser session gets its own TabManager instance via the registry.
 */

import * as net from 'net';
import * as path from 'path';

const DEFAULT_MAX_TABS = 10;

export interface TabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export interface NewTabResult {
  newTab: true;
  activeIndex: number;
  activeUrl: string;
  tabCount: number;
}

class TabManager {
  private lastKnownTabCount = 1;
  private maxTabs = DEFAULT_MAX_TABS;

  constructor(private sessionId: string) {}

  // --- State ---

  setMaxTabs(n: number): void {
    this.maxTabs = n;
  }

  getMaxTabs(): number {
    return this.maxTabs;
  }

  resetTabCount(): void {
    this.lastKnownTabCount = 1;
  }

  getTabCount(): number {
    return this.lastKnownTabCount;
  }

  // --- Daemon Queries ---

  /** Query the agent-browser daemon for its tab list via Unix socket */
  async queryTabs(): Promise<TabInfo[]> {
    const socketDir = process.env.AGENT_BROWSER_SOCKET_DIR
      || (process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'agent-browser') : null)
      || path.join(process.env.HOME || '/home/claude', '.agent-browser');
    const session = `session-${this.sessionId}`;
    const socketPath = path.join(socketDir, `${session}.sock`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { client.destroy(); reject(new Error('Timeout')); }, 3000);
      const client = net.createConnection(socketPath, () => {
        client.write(JSON.stringify({ id: 'tab-q', action: 'tab_list' }) + '\n');
      });
      let buf = '';
      client.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        try {
          const resp = JSON.parse(buf);
          clearTimeout(timeout);
          client.end();
          const tabs = resp.data?.tabs;
          resp.success && tabs ? resolve(tabs) : reject(new Error(resp.error || 'No tabs'));
        } catch { /* incomplete JSON, wait for more */ }
      });
      client.on('error', (err: Error) => { clearTimeout(timeout); reject(err); });
    });
  }

  /** Re-query daemon and update the cached tab count */
  async syncTabCount(): Promise<void> {
    try {
      const tabs = await this.queryTabs();
      this.lastKnownTabCount = tabs.length;
    } catch { /* best-effort */ }
  }

  // --- Detection ---

  /** Check if a new tab was opened since the last check. Returns tab info or null. */
  async detectNewTab(): Promise<NewTabResult | null> {
    try {
      const tabs = await this.queryTabs();
      const prevCount = this.lastKnownTabCount;
      this.lastKnownTabCount = tabs.length;

      if (tabs.length > prevCount) {
        const active = tabs.find(t => t.active);
        if (active) {
          return {
            newTab: true,
            activeIndex: active.index,
            activeUrl: active.url,
            tabCount: tabs.length,
          };
        }
      }
      return null;
    } catch {
      // Tab detection is best-effort — don't fail the action if the daemon is unavailable
      return null;
    }
  }

  // --- URL Matching ---

  /** Normalize and compare two URLs (origin + pathname + search, ignoring trailing slash and hash) */
  urlsMatch(a: string, b: string): boolean {
    try {
      const ua = new URL(a);
      const ub = new URL(b);
      return ua.origin === ub.origin &&
             ua.pathname.replace(/\/$/, '') === ub.pathname.replace(/\/$/, '') &&
             ua.search === ub.search;
    } catch { return false; }
  }

  /** Find a tab whose URL matches the given URL */
  async findMatchingTab(url: string): Promise<TabInfo | null> {
    try {
      const tabs = await this.queryTabs();
      return tabs.find(t => this.urlsMatch(t.url, url)) ?? null;
    } catch { return null; }
  }

  // --- Message Formatting ---

  /** Format a notification about a newly opened tab (appended to click/press responses) */
  formatTabNotification(tabInfo: { activeIndex: number; activeUrl: string; tabCount: number }): string {
    const { activeIndex, activeUrl, tabCount } = tabInfo;
    let msg = `\nNew tab opened — you are now on tab ${activeIndex} (${activeUrl}). ${tabCount} tab(s) open.`;

    if (tabCount >= this.maxTabs) {
      msg += `\n⚠️ WARNING: ${tabCount} tabs open (max ${this.maxTabs}). You MUST close tabs you no longer need IMMEDIATELY. Switch with browser_run("tab <n>") then browser_run("tab close").`;
    } else {
      msg += `\nIf you no longer need the tab you came from, close it now: browser_run("tab <prev>") then browser_run("tab close").`;
    }

    return msg;
  }

  /** Escalating warning appended to tool responses when tabs are high */
  formatTabWarning(tabCount: number): string {
    if (tabCount >= this.maxTabs) return `\n\n🚨 CRITICAL: ${tabCount} TABS OPEN (limit: ${this.maxTabs}). STOP and close unneeded tabs NOW. Run browser_run("tab") to list, then close extras.`;
    if (tabCount >= this.maxTabs - 1) return `\n\n[${tabCount} tabs open — close any you no longer need]`;
    return '';
  }

  /** Tab status line appended to snapshot/state responses */
  formatTabStatus(tabCount: number): string {
    if (tabCount <= 1) return '';
    if (tabCount >= this.maxTabs) return `\n\n[Tabs: ${tabCount} open — OVER LIMIT, close tabs NOW]`;
    return `\n\n[Tabs: ${tabCount} open]`;
  }
}

// --- Per-session TabManager registry ---

const tabManagers: Map<string, TabManager> = new Map();
let globalMaxTabs = DEFAULT_MAX_TABS;

export function getTabManager(sessionId: string): TabManager {
  let tm = tabManagers.get(sessionId);
  if (!tm) {
    tm = new TabManager(sessionId);
    tm.setMaxTabs(globalMaxTabs);
    tabManagers.set(sessionId, tm);
  }
  return tm;
}

export function removeTabManager(sessionId: string): void {
  tabManagers.delete(sessionId);
}

/** Set maxTabs on all existing and future TabManager instances */
export function setAllMaxTabs(n: number): void {
  globalMaxTabs = n;
  for (const tm of tabManagers.values()) {
    tm.setMaxTabs(n);
  }
}

export { TabManager };
