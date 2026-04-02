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

const REVEAL_DURATION = 350

export function PendingRequestStack({ children }: PendingRequestStackProps) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const count = children.length

  // Track previous children to detect removals and trigger reveal animation
  const prevKeysRef = useRef<string[]>([])
  const [revealing, setRevealing] = useState(false)

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

  // Update high-water mark after every render (only while there are children and not revealing)
  useEffect(() => {
    if (containerRef.current && count > 0 && !revealing) {
      const h = containerRef.current.offsetHeight
      if (h > highWaterHeight.current) {
        highWaterHeight.current = h
        setMinHeight(h)
      }
    }
  })

  // Detect child removal → trigger reveal animation
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const currentKeys = children.map((c) => String(c.key))
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
  }, [children])

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

  if (count === 0) return null

  const idx = Math.min(currentIndex, count - 1)
  const stackDepth = count > 1 ? Math.min(count - idx - 1, 3) : 0

  return (
    <PaginationContext.Provider value={{ currentIndex: idx, count, goNext, goPrev }}>
      <div
        ref={containerRef}
        className="relative"
        style={minHeight > 0 ? { minHeight } : undefined}
      >
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
                ...(i === idx && revealing
                  ? { animation: `stack-reveal ${REVEAL_DURATION}ms cubic-bezier(0.16, 1, 0.3, 1) forwards` }
                  : {}),
              }}
            >
              {child}
            </div>
          ))}
        </div>

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
