import type { BrowserHistoryState } from '@shared/lib/browser-stream-protocol'

const emptyHistory: BrowserHistoryState = { canGoBack: false, canGoForward: false, url: '' }

interface BrowserViewState {
  targetId: string | null
  history: BrowserHistoryState
}

type BrowserViewAction =
  | { type: 'view'; targetId: string | null }
  | { type: 'history'; targetId?: string; history: BrowserHistoryState }
  | { type: 'reset' }

export const initialBrowserView: BrowserViewState = { targetId: null, history: emptyHistory }

/** Apply tab and history messages in order, including when React batches them. */
export function browserViewReducer(state: BrowserViewState, action: BrowserViewAction): BrowserViewState {
  if (action.type === 'reset') return initialBrowserView
  if (action.type === 'view') {
    return action.targetId === state.targetId ? state : { targetId: action.targetId, history: emptyHistory }
  }
  // A closing CDP connection can have a reply in flight after the viewer switches.
  if (action.targetId && state.targetId && action.targetId !== state.targetId) return state
  const targetId = state.targetId ?? action.targetId ?? null
  const { history } = action
  if (targetId === state.targetId && history.url === state.history.url &&
    history.canGoBack === state.history.canGoBack && history.canGoForward === state.history.canGoForward) return state
  return { targetId, history }
}
