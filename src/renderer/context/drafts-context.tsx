import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'

type Listener = () => void

export interface DraftsStore {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T | undefined): void
  subscribe(key: string, listener: Listener): () => void
}

export function appendToSessionDraft(
  store: Pick<DraftsStore, 'get' | 'set'>,
  sessionId: string,
  content: string,
  { prepend }: { prepend: boolean },
): void {
  const draftKey = `session:${sessionId}`
  const existing = store.get<string>(draftKey)?.trim() ?? ''
  const addition = content.trim()
  const parts = prepend ? [addition, existing] : [existing, addition]
  store.set(draftKey, parts.filter(Boolean).join('\n\n') || undefined)
}

const DraftsContext = createContext<DraftsStore | null>(null)

export function DraftsProvider({ children }: { children: ReactNode }) {
  const valuesRef = useRef(new Map<string, unknown>())
  const listenersRef = useRef(new Map<string, Set<Listener>>())

  const store = useMemo<DraftsStore>(() => ({
    get<T>(key: string): T | undefined {
      return valuesRef.current.get(key) as T | undefined
    },
    set<T>(key: string, value: T | undefined): void {
      const prev = valuesRef.current.get(key)
      if (Object.is(prev, value)) return
      if (value === undefined) {
        valuesRef.current.delete(key)
      } else {
        valuesRef.current.set(key, value)
      }
      listenersRef.current.get(key)?.forEach((l) => l())
    },
    subscribe(key: string, listener: Listener): () => void {
      let set = listenersRef.current.get(key)
      if (!set) {
        set = new Set()
        listenersRef.current.set(key, set)
      }
      set.add(listener)
      return () => {
        set!.delete(listener)
        if (set!.size === 0) listenersRef.current.delete(key)
      }
    },
  }), [])

  return <DraftsContext.Provider value={store}>{children}</DraftsContext.Provider>
}

const NOOP_UNSUB = () => {}

/**
 * Imperative access to the drafts store without subscribing. Use when you need
 * to read/write a draft in an event handler or effect but must NOT re-render on
 * every keystroke (which `useDraft` would cause). The returned store is stable.
 */
export function useDraftsStore(): DraftsStore {
  const store = useContext(DraftsContext)
  if (!store) throw new Error('useDraftsStore must be used within DraftsProvider')
  return store
}

export function useDraft<T>(key: string | null | undefined): [T | undefined, (value: T | undefined) => void] {
  const store = useContext(DraftsContext)
  if (!store) throw new Error('useDraft must be used within DraftsProvider')
  const subscribe = useCallback((cb: Listener) => {
    if (!key) return NOOP_UNSUB
    return store.subscribe(key, cb)
  }, [store, key])
  const getSnapshot = useCallback(() => (key ? store.get<T>(key) : undefined), [store, key])
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const setValue = useCallback((v: T | undefined) => {
    if (key) store.set<T>(key, v)
  }, [store, key])
  return [value, setValue]
}
