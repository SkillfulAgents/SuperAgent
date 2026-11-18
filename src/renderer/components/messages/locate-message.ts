export type LocateOutcome = 'landed' | 'stopped'

export interface MessageTarget {
  id: string
  onSettled: (outcome: LocateOutcome) => void
}

export type LocateStep = 'place' | 'grow' | 'fetch' | 'wait' | 'stop'

/**
 * The next move toward a target message. Out of history, or when an older page
 * adds nothing, it stops where the reader is.
 */
export function nextLocateStep(state: {
  rendered: boolean
  loaded: boolean
  hasOlder: boolean
  isFetchingOlder: boolean
}): LocateStep {
  if (state.rendered) return 'place'
  if (state.loaded) return 'grow'
  if (state.isFetchingOlder) return 'wait'
  return state.hasOlder ? 'fetch' : 'stop'
}

export function landingTop(rowTop: number, rowHeight: number, readableHeight: number): number {
  return Math.max(0, rowHeight < readableHeight ? rowTop - (readableHeight - rowHeight) / 2 : rowTop)
}
