import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  type ReactElement,
  type MutableRefObject,
} from 'react'

interface SubPaginationState {
  count: number
  index: number
  setIndex: (i: number) => void
}

interface PaginationContextValue {
  /** Flat index across every sub-page in every card. */
  currentIndex: number
  /** Sum of every card's sub-count (unregistered cards default to 1, count=0 is skipped). */
  count: number
  goNext: () => void
  goPrev: () => void
  /** Cards call this from `useSubPagination`; do not call directly. */
  registerSubPagination: (
    key: string,
    stateRef: MutableRefObject<SubPaginationState>
  ) => () => void
  /** Cards call this when their sub-pagination values (count/index) change. */
  notifySubPaginationChange: () => void
}

const PaginationContext = createContext<PaginationContextValue | null>(null)
const CardKeyContext = createContext<string | null>(null)

/** Consumed by RequestItemShell to render pagination controls in headerRight. */
export function usePagination() {
  return useContext(PaginationContext)
}

/** Cards with internal pagination publish `{count, index, setIndex}` so the
 *  stack's chevrons advance through every sub-page across cards (e.g. 2 cards
 *  with 3 + 2 sub-pages → "1 of 5"). The card owns its sub-index state; the
 *  stack drives it via `setIndex` when the user paginates. */
export function useSubPagination(state: SubPaginationState): void {
  const ctx = useContext(PaginationContext)
  const cardKey = useContext(CardKeyContext)

  // Mirror state in a ref so the registry always reads fresh values without
  // forcing the registration effect to re-run on every prop change.
  const stateRef = useRef(state)
  stateRef.current = state

  // `register` and `notify` are stable callbacks on the context value
  // (created with no deps in the stack) — extracting them keeps the
  // registration effect from re-running each time the context value object
  // is recreated.
  const register = ctx?.registerSubPagination
  const notify = ctx?.notifySubPaginationChange

  // Register once per mount; cleanup on unmount.
  useEffect(() => {
    if (!cardKey || !register) return
    return register(cardKey, stateRef)
  }, [cardKey, register])

  // Tell the stack to recompute totals when count/index change.
  useEffect(() => {
    if (!notify) return
    notify()
  }, [notify, state.count, state.index])

  // Clamp the card's local index when its count shrinks below the index.
  const { count, index, setIndex } = state
  useEffect(() => {
    if (count > 0 && index >= count) {
      setIndex(count - 1)
    }
  }, [count, index, setIndex])
}

interface PendingRequestStackProps {
  children: ReactElement[]
}

const REVEAL_DURATION = 350

export function PendingRequestStack({ children }: PendingRequestStackProps) {
  const [activeCardIndex, setActiveCardIndex] = useState(0)

  // Registry of card sub-pagination state, by stable cardKey. Holds refs so
  // updates from cards don't require a full re-registration; we bump
  // `version` to trigger stack re-renders when contents change.
  const registryRef = useRef(new Map<string, MutableRefObject<SubPaginationState>>())
  const [version, setVersion] = useState(0)

  const registerSubPagination = useCallback(
    (key: string, ref: MutableRefObject<SubPaginationState>) => {
      registryRef.current.set(key, ref)
      setVersion((v) => v + 1)
      return () => {
        registryRef.current.delete(key)
        setVersion((v) => v + 1)
      }
    },
    []
  )

  const notifySubPaginationChange = useCallback(() => {
    setVersion((v) => v + 1)
  }, [])

  const cardKeys = useMemo(
    () => children.map((c, i) => String(c.key ?? i)),
    [children]
  )
  const numCards = cardKeys.length

  // Per-card sub-counts: registered → registered count (incl. 0); unregistered → 1.
  // `version` is the invalidation key for reads from the ref-based registry.
  const subCounts = useMemo(() => {
    void version
    return cardKeys.map((k) => {
      const ref = registryRef.current.get(k)
      return ref?.current ? ref.current.count : 1
    })
  }, [cardKeys, version])

  const totalCount = useMemo(
    () => subCounts.reduce((acc, c) => acc + c, 0),
    [subCounts]
  )

  // Skip count=0 cards. Find a non-zero card at or after activeCardIndex,
  // or fall back to the last non-zero card before it.
  const effectiveActiveCardIndex = useMemo(() => {
    if (numCards === 0) return 0
    const start = Math.min(Math.max(activeCardIndex, 0), numCards - 1)
    for (let i = start; i < numCards; i++) {
      if (subCounts[i] > 0) return i
    }
    for (let i = start - 1; i >= 0; i--) {
      if (subCounts[i] > 0) return i
    }
    return start
  }, [activeCardIndex, numCards, subCounts])

  // Read active card's local sub-index via the registry ref. `version` already
  // forces re-renders when registry contents change, so the read stays fresh.
  const activeCardKey = cardKeys[effectiveActiveCardIndex]
  const activeCardEntry = activeCardKey
    ? registryRef.current.get(activeCardKey)
    : undefined
  const activeCardSub = activeCardEntry?.current?.index ?? 0

  // Flat index = sum of sub-counts before active + active card's local sub-index.
  const flatIndex = useMemo(() => {
    if (totalCount === 0) return 0
    let sum = 0
    for (let i = 0; i < effectiveActiveCardIndex; i++) sum += subCounts[i]
    const activeCount = subCounts[effectiveActiveCardIndex] ?? 1
    const sub = Math.min(Math.max(activeCardSub, 0), Math.max(0, activeCount - 1))
    return Math.min(sum + sub, Math.max(0, totalCount - 1))
  }, [effectiveActiveCardIndex, subCounts, activeCardSub, totalCount])

  const goNext = useCallback(() => {
    if (numCards === 0) return
    const activeKey = cardKeys[effectiveActiveCardIndex]
    const entry = registryRef.current.get(activeKey)?.current
    const activeCount = entry?.count ?? 1
    const activeIdx = entry?.index ?? 0

    if (activeIdx < activeCount - 1) {
      entry?.setIndex(activeIdx + 1)
      return
    }

    let next = effectiveActiveCardIndex + 1
    while (next < numCards && subCounts[next] === 0) next++
    if (next >= numCards) return

    // Reset incoming card's sub-index to 0 so navigation stays +1 per click.
    const nextEntry = registryRef.current.get(cardKeys[next])?.current
    if (nextEntry && nextEntry.index !== 0) nextEntry.setIndex(0)
    setActiveCardIndex(next)
  }, [cardKeys, effectiveActiveCardIndex, subCounts, numCards])

  const goPrev = useCallback(() => {
    if (numCards === 0) return
    const activeKey = cardKeys[effectiveActiveCardIndex]
    const entry = registryRef.current.get(activeKey)?.current
    const activeIdx = entry?.index ?? 0

    if (activeIdx > 0) {
      entry?.setIndex(activeIdx - 1)
      return
    }

    let prev = effectiveActiveCardIndex - 1
    while (prev >= 0 && subCounts[prev] === 0) prev--
    if (prev < 0) return

    // Land on the previous card's last sub-page so navigation stays -1 per click.
    const prevEntry = registryRef.current.get(cardKeys[prev])?.current
    const target = (prevEntry?.count ?? 1) - 1
    if (prevEntry && prevEntry.index !== target) prevEntry.setIndex(target)
    setActiveCardIndex(prev)
  }, [cardKeys, effectiveActiveCardIndex, subCounts, numCards])

  // --- Card-level reveal animation ----------------------------------------

  const prevKeysRef = useRef<string[]>([])
  const [revealing, setRevealing] = useState(false)
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const currentKeys = cardKeys
    const prevKeys = prevKeysRef.current

    if (prevKeys.length > 0 && prevKeys.length > currentKeys.length) {
      setRevealing(true)
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current)
      revealTimerRef.current = setTimeout(() => {
        setRevealing(false)
        revealTimerRef.current = null
      }, REVEAL_DURATION)
    }

    prevKeysRef.current = currentKeys
  }, [cardKeys])

  // Clamp activeCardIndex when cards shrink below it.
  useEffect(() => {
    if (numCards > 0 && activeCardIndex >= numCards) {
      setActiveCardIndex(numCards - 1)
    }
  }, [numCards, activeCardIndex])

  if (numCards === 0) return null

  return (
    <PaginationContext.Provider
      value={{
        currentIndex: flatIndex,
        count: totalCount,
        goNext,
        goPrev,
        registerSubPagination,
        notifySubPaginationChange,
      }}
    >
      {/* The container sizes to the ACTIVE card (+ its peeks) only. Inactive
          cards are absolutely positioned so they stay mounted — preserving
          their internal form state — but don't contribute to the container's
          height. Each card carries its own peek cards above, so peeks track
          the card's top edge as you paginate. The chat layout anchors this
          stack to the bottom of the chat column, so action rows stay put
          across pagination even though the container resizes. */}
      <div className="relative">
        {children.map((child, i) => {
          const cardKey = cardKeys[i]
          const peekDepth = Math.min(numCards - i - 1, 3)
          const isActive = i === effectiveActiveCardIndex
          return (
            <div
              key={cardKey}
              style={{
                ...(isActive
                  ? {}
                  : { position: 'absolute', top: 0, left: 0, right: 0 }),
                visibility: isActive ? 'visible' : 'hidden',
                ...(isActive && revealing
                  ? { animation: `stack-reveal ${REVEAL_DURATION}ms cubic-bezier(0.16, 1, 0.3, 1) forwards` }
                  : {}),
              }}
            >
              <CardKeyContext.Provider value={cardKey}>
                {Array.from({ length: peekDepth }, (_, j) => {
                  const depth = peekDepth - j
                  return (
                    <div
                      key={`peek-${depth}`}
                      className="rounded-t-[12px] border-x border-t bg-muted/20"
                      style={{
                        height: 10,
                        opacity: Math.max(0.3, 1 - depth * 0.25),
                        marginLeft: depth * 8,
                        marginRight: depth * 8,
                      }}
                    />
                  )
                })}
                {child}
              </CardKeyContext.Provider>
            </div>
          )
        })}

        <style>{`
          @keyframes stack-reveal {
            0% {
              opacity: 0;
              transform: translateY(8px) scale(0.98);
            }
            100% {
              opacity: 1;
              transform: translateY(0) scale(1);
            }
          }
        `}</style>
      </div>
    </PaginationContext.Provider>
  )
}
