// Type-only bridge: the container owns the wire contract and builds independently.
export type {
  BrowserTabInfo,
  BrowserHistoryState,
  BrowserHistoryMessage,
  BrowserTabListMessage,
  BrowserNavigateAction,
  BrowserNavigateCommand,
} from '../../../agent-container/src/browser-stream-protocol'
