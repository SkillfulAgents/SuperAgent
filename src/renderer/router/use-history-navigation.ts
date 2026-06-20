import { useRouter } from '@tanstack/react-router'
import type { RouterHistory } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'

type HistoryStackState = {
  currentIndex: number
  furthestIndex: number
}

function getHistoryIndex(history: RouterHistory): number {
  const index = history.location.state?.__TSR_index
  return typeof index === 'number' && Number.isFinite(index) && index >= 0 ? index : 0
}

function getInitialStackState(history: RouterHistory): HistoryStackState {
  const currentIndex = getHistoryIndex(history)
  return { currentIndex, furthestIndex: currentIndex }
}

export function useHistoryNavigation() {
  const router = useRouter()
  const history = router.history
  const [stackState, setStackState] = useState(() => getInitialStackState(history))

  useEffect(() => {
    const syncStackState = (action?: { type: string }) => {
      const currentIndex = getHistoryIndex(history)

      setStackState((previous) => {
        const furthestIndex =
          action?.type === 'PUSH'
            ? currentIndex
            : Math.max(previous.furthestIndex, currentIndex)

        if (
          previous.currentIndex === currentIndex &&
          previous.furthestIndex === furthestIndex
        ) {
          return previous
        }

        return { currentIndex, furthestIndex }
      })
    }

    syncStackState()
    return history.subscribe(({ action }) => syncStackState(action))
  }, [history])

  const canGoBack = useMemo(
    () => stackState.currentIndex > 0 && history.canGoBack(),
    [history, stackState.currentIndex]
  )
  const canGoForward = stackState.currentIndex < stackState.furthestIndex

  const back = useCallback(() => {
    if (getHistoryIndex(history) > 0 && history.canGoBack()) {
      history.back()
    }
  }, [history])

  const forward = useCallback(() => {
    if (getHistoryIndex(history) < stackState.furthestIndex) {
      history.forward()
    }
  }, [history, stackState.furthestIndex])

  return {
    canGoBack,
    canGoForward,
    back,
    forward,
  }
}
