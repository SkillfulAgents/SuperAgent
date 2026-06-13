export interface BrowserState {
  active: boolean;
  sessionId: string | null;
  cdpUrl: string | null;
}

const initialState: BrowserState = { active: false, sessionId: null, cdpUrl: null };

let browserState: BrowserState = { ...initialState };

export function getBrowserState(): Readonly<BrowserState> {
  return browserState;
}

export function setBrowserState(state: BrowserState): void {
  browserState = state;
}

export function resetBrowserState(): void {
  browserState = { ...initialState };
}

/**
 * Validate that the requesting session owns the browser (or browser is not active).
 * Returns an error string if validation fails, null if OK.
 */
export function validateBrowserSession(requestSessionId: string): string | null {
  if (browserState.active && browserState.sessionId !== requestSessionId) {
    return `Browser is owned by session ${browserState.sessionId}`;
  }
  return null;
}

/**
 * Release the browser lock if the given session owns it.
 * Does NOT close the browser or kill chromium — only drops the ownership lock
 * so another session can acquire it. The Chrome process and cookies are preserved.
 *
 * Returns true if the lock was released, false if the session didn't own it.
 */
export function releaseBrowserLock(sessionId: string): boolean {
  if (browserState.active && browserState.sessionId === sessionId) {
    browserState = { active: false, sessionId: null, cdpUrl: null };
    return true;
  }
  return false;
}

/**
 * Re-key the browser lock when a session adopts a new canonical id.
 * A ClaudeCodeProcess's sessionId changes whenever its SDK query (re)starts
 * (model/effort change, MCP approval restart) — without this, a lock acquired
 * under the old id strands every subsequent browser call from the same session.
 *
 * Returns true if the lock was re-keyed, false if oldId didn't own it.
 */
export function renameBrowserSession(oldId: string, newId: string): boolean {
  if (browserState.active && browserState.sessionId === oldId) {
    browserState = { ...browserState, sessionId: newId };
    return true;
  }
  return false;
}

/**
 * Force-assign browser ownership to a session, preserving the live browser
 * connection. Used to recover a lock stranded under a session id that no
 * longer corresponds to any active session.
 */
export function transferBrowserLock(sessionId: string): void {
  if (browserState.active) {
    browserState = { ...browserState, sessionId };
  }
}
