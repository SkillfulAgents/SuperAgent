import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactElement } from 'react'

interface PaginationContextValue {
  currentIndex: number
  count: number
  goNext: () => void
  goPrev: () => void
}

const PaginationContext = createContext<PaginationContextValue | null>(null)

/** Consumed by RequestItemShell to render pagination controls in headerRight. */
export function usePagination() {
  return useContext(PaginationContext)
}

interface PendingRequestStackProps {
  children: ReactElement[]
}

const DISMISS_DURATION = 1000

export function PendingRequestStack({ children }: PendingRequestStackProps) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const count = children.length

  // Track previous children to detect removals and animate dismissals
  const prevKeysRef = useRef<string[]>([])
  const prevChildrenRef = useRef<ReactElement[]>(children)
  const [dismissing, setDismissing] = useState<ReactElement | null>(null)
  const [dismissTopOffset, setDismissTopOffset] = useState(0)

  // High-water mark: container only grows while stack is non-empty, resets when empty.
  const containerRef = useRef<HTMLDivElement>(null)
  const highWaterHeight = useRef(0)
  const [minHeight, setMinHeight] = useState(0)
  const prevCount = useRef(count)

  // Reset high-water mark when children reappear after being empty
  if (count > 0 && prevCount.current === 0) {
    highWaterHeight.current = 0
  }
  prevCount.current = count

  // Update high-water mark after every render (only while there are children and not dismissing)
  useEffect(() => {
    if (containerRef.current && count > 0 && !dismissing) {
      const h = containerRef.current.offsetHeight
      if (h > highWaterHeight.current) {
        highWaterHeight.current = h
        setMinHeight(h)
      }
    }
  })

  // Detect child removal → trigger dismiss animation
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const currentKeys = children.map((c) => String(c.key))
    const prevKeys = prevKeysRef.current

    if (prevKeys.length > 0 && prevKeys.length > currentKeys.length) {
      const currentKeySet = new Set(currentKeys)
      const removedKey = prevKeys.find((k) => !currentKeySet.has(k))

      if (removedKey) {
        const removedChild = prevChildrenRef.current.find((c) => String(c.key) === removedKey)
        if (removedChild) {
          // Compute the stack strip height from before the removal
          const oldCount = prevKeys.length
          const oldIdx = Math.min(currentIndex, oldCount - 1)
          const oldStackDepth = oldCount > 1 ? Math.min(oldCount - oldIdx - 1, 3) : 0
          setDismissTopOffset(oldStackDepth * 10)
          setDismissing(removedChild)
          if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
          dismissTimerRef.current = setTimeout(() => {
            setDismissing(null)
            setDismissTopOffset(0)
            dismissTimerRef.current = null
          }, DISMISS_DURATION)
        }
      }
    }

    prevKeysRef.current = currentKeys
  }, [children, currentIndex])

  useEffect(() => {
    prevChildrenRef.current = children
  })

  // Clamp index when items are removed
  useEffect(() => {
    if (count > 0 && currentIndex >= count) {
      setCurrentIndex(count - 1)
    }
  }, [count, currentIndex])

  const goNext = useCallback(() => {
    setCurrentIndex((i) => Math.min(count - 1, i + 1))
  }, [count])

  const goPrev = useCallback(() => {
    setCurrentIndex((i) => Math.max(0, i - 1))
  }, [])

  if (count === 0 && !dismissing) return null

  const idx = count > 0 ? Math.min(currentIndex, count - 1) : 0
  const stackDepth = count > 1 ? Math.min(count - idx - 1, 3) : 0


  return (
    <PaginationContext.Provider value={{ currentIndex: idx, count, goNext, goPrev }}>
      <div
        ref={containerRef}
        className="relative"
        style={minHeight > 0 ? { minHeight } : undefined}
      >
        {/* Dismiss animation overlay — offset to match the card's original position */}
        {dismissing && (
          <div
            className="absolute inset-x-0 pointer-events-none"
            style={{ zIndex: 10, top: dismissTopOffset }}
          >
            <div
              className="bg-background"
              style={{
                animation: `stack-dismiss ${DISMISS_DURATION}ms ease-out forwards`,
              }}
            >
              {dismissing}
            </div>
          </div>
        )}

        {/* Stacked placeholder cards peeking out above */}
        {Array.from({ length: stackDepth }, (_, i) => {
          const depth = stackDepth - i
          return (
            <div
              key={`stack-${depth}`}
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

        {/* All cards in a grid — tallest determines height, only active is visible */}
        <div className="grid">
          {children.map((child, i) => (
            <div
              key={child.key ?? i}
              style={{
                gridArea: '1 / 1',
                visibility: i === idx ? 'visible' : 'hidden',
              }}
            >
              {child}
            </div>
          ))}
        </div>

        <style>{`
          @keyframes stack-dismiss {
            0% {
              opacity: 1;
              transform: translateY(0);
            }
            40% {
              opacity: 1;
            }
            100% {
              opacity: 0;
              transform: translateY(-40px);
            }
          }
        `}</style>
      </div>
    </PaginationContext.Provider>
  )
}
