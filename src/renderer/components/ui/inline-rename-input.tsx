import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@shared/lib/utils/cn'

/**
 * In-place rename for a sidebar (or list) name. Snapshots the name on mount,
 * commits on Enter or leave, abandons on Escape, and stays open with a toast
 * when save fails. A click that caused the leave is held until save succeeds.
 */
export function InlineRenameInput({
  currentName,
  noun,
  ariaLabel,
  testId,
  className,
  onSave,
  onDone,
}: {
  currentName: string
  noun: 'session' | 'dashboard' | 'folder'
  ariaLabel: string
  testId?: string
  className?: string
  onSave: (name: string) => void | Promise<unknown>
  onDone: () => void
}) {
  const snapshot = useRef(currentName)
  const [value, setValue] = useState(currentName)
  const [isPending, setIsPending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const settledRef = useRef(false)
  const pendingRef = useRef(false)
  const queuedClickRef = useRef<Element | null>(null)
  const swallowLeaveClickRef = useRef(false)
  const generationRef = useRef(0)

  useEffect(() => {
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const onClickCapture = (event: MouseEvent) => {
      if (!pendingRef.current && !swallowLeaveClickRef.current) return
      const target = event.target
      if (!(target instanceof Node)) return
      if (inputRef.current?.contains(target)) return
      event.preventDefault()
      event.stopPropagation()
      if (swallowLeaveClickRef.current) {
        swallowLeaveClickRef.current = false
        return
      }
      queuedClickRef.current =
        target instanceof Element
          ? target.closest('a, button, [role="button"], [role="link"]') ?? target
          : null
    }
    document.addEventListener('click', onClickCapture, true)
    return () => document.removeEventListener('click', onClickCapture, true)
  }, [])

  const close = () => {
    settledRef.current = true
    pendingRef.current = false
    const queued = queuedClickRef.current
    queuedClickRef.current = null
    onDone()
    if (queued instanceof HTMLElement) {
      queueMicrotask(() => queued.click())
    }
  }

  const submit = async () => {
    if (settledRef.current || pendingRef.current) return
    const trimmed = value.trim()
    if (!trimmed || trimmed === snapshot.current) {
      close()
      return
    }

    const generation = ++generationRef.current
    pendingRef.current = true
    setIsPending(true)
    try {
      await onSave(trimmed)
      if (generationRef.current === generation) close()
    } catch (error) {
      console.error(`Failed to rename ${noun}:`, error)
      toast.error(`Failed to rename ${noun}`, {
        description: error instanceof Error ? error.message : 'Please try again.',
      })
      if (generationRef.current === generation) {
        pendingRef.current = false
        queuedClickRef.current = null
        swallowLeaveClickRef.current = true
        setIsPending(false)
      }
    }
  }

  const cancel = () => {
    if (pendingRef.current) return
    close()
  }

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') void submit()
        if (e.key === 'Escape') cancel()
      }}
      onBlur={() => { void submit() }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      autoFocus
      disabled={isPending}
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn(
        'w-full bg-background border border-input rounded px-1 py-0 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-60',
        className,
      )}
    />
  )
}
