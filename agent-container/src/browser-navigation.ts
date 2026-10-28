import type { BrowserHistoryMessage, BrowserNavigateAction } from './browser-stream-protocol';

interface NavigationMessage {
  id?: number;
  method?: string;
  params?: { frameId?: string; frame?: { id: string; parentId?: string } };
  result?: {
    frameTree?: { frame?: { id: string } };
    entries?: Array<{ id: number; url: string }>;
    currentIndex?: number;
  };
}

interface BrowserNavigationOptions {
  targetId: string;
  sendCommand: (method: string, params?: Record<string, unknown>) => number | undefined;
  publish: (message: BrowserHistoryMessage) => void;
}

/** Owns navigation for one CDP attachment; no socket or server lifetime of its own. */
export function createBrowserNavigation({ targetId, sendCommand, publish }: BrowserNavigationOptions) {
  const pending = new Map<number, { purpose: 'state' | 'back' | 'forward'; revision: number }>();
  let mainFrameId: string | null = null;
  let revision = 0;
  let pendingStateId: number | undefined;
  let refreshQueued = false;
  let lastPublished: BrowserHistoryMessage | undefined;
  let disposed = false;

  function request(purpose: 'state' | 'back' | 'forward') {
    if (disposed) return;
    const id = sendCommand('Page.getNavigationHistory');
    if (id === undefined) return;
    pending.set(id, { purpose, revision });
    if (purpose === 'state') pendingStateId = id;
  }

  function refresh(documentChanged = false) {
    if (disposed) return;
    if (documentChanged) revision++;
    // Only a main-document URL change makes an outstanding reply obsolete.
    // Iframe/load churn queues one refresh without starving useful responses.
    if (pendingStateId === undefined) request('state');
    else refreshQueued = true;
  }

  function isMainFrame(frameId: string | undefined) {
    return !mainFrameId || frameId === mainFrameId;
  }

  function handleMessage(message: NavigationMessage): boolean {
    if (disposed) return false;
    const discoveredFrame = message.result?.frameTree?.frame?.id;
    if (discoveredFrame) mainFrameId = discoveredFrame;
    if (message.method === 'Page.frameNavigated' && message.params?.frame && !message.params.frame.parentId) {
      mainFrameId = message.params.frame.id;
      // The document is visible before all its resources finish loading.
      refresh(true);
    } else if (message.method === 'Page.frameStoppedLoading' && isMainFrame(message.params?.frameId)) {
      refresh();
    } else if (message.method === 'Page.navigatedWithinDocument') {
      // Subframe history can affect Back/Forward too. Unchanged state is deduped
      // below, so iframe replaceState churn does not repeatedly render the tray.
      refresh(isMainFrame(message.params?.frameId));
    }

    const query = message.id === undefined ? undefined : pending.get(message.id);
    if (!query || message.id === undefined) return false;
    pending.delete(message.id);
    if (query.purpose === 'state') {
      pendingStateId = undefined;
      const superseded = query.revision !== revision;
      if (superseded || refreshQueued) {
        refreshQueued = false;
        request('state');
      }
      if (superseded) return true;
    }
    const { entries, currentIndex } = message.result ?? {};
    if (!Array.isArray(entries) || !Number.isInteger(currentIndex) || currentIndex === undefined ||
      currentIndex < 0 || currentIndex >= entries.length) return true;
    if (query.purpose !== 'state') {
      const entry = entries[currentIndex + (query.purpose === 'back' ? -1 : 1)];
      if (entry) sendCommand('Page.navigateToHistoryEntry', { entryId: entry.id });
      return true;
    }
    const next: BrowserHistoryMessage = {
      type: 'history_state', targetId,
      canGoBack: currentIndex > 0,
      canGoForward: currentIndex < entries.length - 1,
      url: entries[currentIndex].url,
    };
    if (next.url !== lastPublished?.url || next.canGoBack !== lastPublished?.canGoBack ||
      next.canGoForward !== lastPublished?.canGoForward) {
      lastPublished = next;
      publish(next);
    }
    return true;
  }

  return {
    refresh,
    handleMessage,
    isMainFrame,
    navigate(action: BrowserNavigateAction) {
      if (disposed) return;
      if (action === 'reload') sendCommand('Page.reload');
      else request(action);
    },
    dispose() { disposed = true; pending.clear(); },
  };
}

export type BrowserNavigation = ReturnType<typeof createBrowserNavigation>;
