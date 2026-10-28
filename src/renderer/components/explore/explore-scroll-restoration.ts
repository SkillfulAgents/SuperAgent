const STORAGE_PREFIX = 'gamut:explore-scroll:'

const fallbackPositions = new Map<string, number>()

declare module '@tanstack/history' {
  interface HistoryState {
    /** History entry for the marketplace page that opened this sub-view. */
    exploreReturnKey?: string
  }
}

function storage(): Storage | undefined {
  try {
    return sessionStorage
  } catch {
    return undefined
  }
}

/** Save the nested marketplace scroller for one concrete browser-history entry. */
export function rememberExploreScrollPosition(entryKey: string, scrollTop: number): void {
  if (!Number.isFinite(scrollTop) || scrollTop < 0) return

  const session = storage()
  if (session) {
    try {
      session.setItem(`${STORAGE_PREFIX}${entryKey}`, String(scrollTop))
      return
    } catch {
      // Fall through to the in-memory cache for restricted storage contexts.
    }
  }

  fallbackPositions.set(entryKey, scrollTop)
}

/** Read a previously saved position, including after a detail-page reload. */
export function getRememberedExploreScrollPosition(entryKey: string): number | undefined {
  const session = storage()
  if (session) {
    try {
      const stored = session.getItem(`${STORAGE_PREFIX}${entryKey}`)
      if (stored !== null) {
        const scrollTop = Number(stored)
        if (Number.isFinite(scrollTop) && scrollTop >= 0) return scrollTop
      }
    } catch {
      // Fall through to the in-memory cache for restricted storage contexts.
    }
  }

  return fallbackPositions.get(entryKey)
}
