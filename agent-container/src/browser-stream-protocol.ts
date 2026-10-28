/** Browser stream types live in the container so its standalone image can build them. */
export interface BrowserTabInfo {
  targetId: string;
  index: number;
  url: string;
  title: string;
  faviconUrl?: string;
  /** The agent's active tab, which can differ from the viewer's selection. */
  active: boolean;
}

export type BrowserNavigateAction = 'back' | 'forward' | 'reload';

export interface BrowserHistoryState {
  canGoBack: boolean;
  canGoForward: boolean;
  url: string;
}

export interface BrowserHistoryMessage extends BrowserHistoryState {
  type: 'history_state';
  /** Optional while older container images are still in use. */
  targetId?: string;
}

export interface BrowserTabListMessage {
  type: 'tab_list';
  tabs: BrowserTabInfo[];
  activeTargetId: string;
}

export interface BrowserNavigateCommand {
  type: 'navigate';
  action: BrowserNavigateAction;
}
