import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import type { Attachment } from '@renderer/components/messages/attachment-preview'
import type { DataTransferResult } from '@renderer/lib/file-utils'
import type { SecuredSecret } from '@renderer/lib/secret-detection'
import type { EffortLevel, SpeedLevel } from '@shared/lib/container/types'

type Listener = () => void

/** Runtime knobs the user explicitly picked in a composer and has not sent yet. */
export interface ComposerOptionPicks {
  model?: string
  llmProviderId?: string
  effort?: EffortLevel
  speed?: SpeedLevel
}

/** Files dropped on a sidebar row, waiting for that row's composer to mount. */
export interface PendingAttachmentDrop {
  items: DataTransferResult
  droppedAt: number
}

/** Everything unsent in one composer. One record per composer key. */
export interface ComposerDraft {
  text?: string
  attachments?: Attachment[]
  securedSecrets?: SecuredSecret[]
  options?: ComposerOptionPicks
  pendingDrop?: PendingAttachmentDrop
}

export interface DraftsStore {
  get(key: string): ComposerDraft | undefined
  /** Replace the whole record. Empty fields are dropped; an empty record is deleted. */
  set(key: string, draft: ComposerDraft | undefined): void
  /** Shallow-merge fields into the record; a field set to undefined is removed. */
  update(key: string, patch: ComposerDraft): void
  subscribe(key: string, listener: Listener): () => void
}

export const sessionDraftKey = (sessionId: string) => `session:${sessionId}`
export const agentDraftKey = (agentSlug: string) => `agent:${agentSlug}`

function normalizeOptions(options: ComposerOptionPicks | undefined): ComposerOptionPicks | undefined {
  if (!options) return undefined
  const picks: ComposerOptionPicks = {}
  if (options.model !== undefined) picks.model = options.model
  if (options.llmProviderId !== undefined) picks.llmProviderId = options.llmProviderId
  if (options.effort !== undefined) picks.effort = options.effort
  if (options.speed !== undefined) picks.speed = options.speed
  return Object.keys(picks).length > 0 ? picks : undefined
}

// Object URLs are owned by the composer that created them and are revoked on
// unmount, so a stored preview would be dead by the time anything reads it.
function withoutPreviews(attachments: Attachment[]): Attachment[] {
  if (!attachments.some((a) => a.type === 'file' && a.preview)) return attachments
  return attachments.map((a) => (a.type === 'file' && a.preview ? { ...a, preview: undefined } : a))
}

function sameDraft(a: ComposerDraft | undefined, b: ComposerDraft | undefined): boolean {
  if (!a || !b) return a === b
  const keys = Object.keys(a) as (keyof ComposerDraft)[]
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((k) => k === 'options'
    ? (['model', 'llmProviderId', 'effort', 'speed'] as const).every((o) => a.options?.[o] === b.options?.[o])
    : Object.is(a[k], b[k]))
}

function normalizeDraft(draft: ComposerDraft | undefined): ComposerDraft | undefined {
  if (!draft) return undefined
  const next: ComposerDraft = {}
  if (draft.text) next.text = draft.text
  if (draft.attachments?.length) next.attachments = withoutPreviews(draft.attachments)
  if (draft.securedSecrets?.length) next.securedSecrets = draft.securedSecrets
  const options = normalizeOptions(draft.options)
  if (options) next.options = options
  if (draft.pendingDrop) next.pendingDrop = draft.pendingDrop
  return Object.keys(next).length > 0 ? next : undefined
}

export function appendToSessionDraft(
  store: Pick<DraftsStore, 'get' | 'update'>,
  sessionId: string,
  content: string,
  { prepend }: { prepend: boolean },
): void {
  const key = sessionDraftKey(sessionId)
  const existing = store.get(key)?.text?.trim() ?? ''
  const addition = content.trim()
  const parts = prepend ? [addition, existing] : [existing, addition]
  store.update(key, { text: parts.filter(Boolean).join('\n\n') || undefined })
}

/** Fork Session: copy the source's unsent draft into the fork. The source keeps its own. */
export function copyComposerDraft(
  store: Pick<DraftsStore, 'set'>,
  toKey: string,
  draft: ComposerDraft | undefined,
): void {
  if (draft) store.set(toKey, { ...draft, pendingDrop: undefined })
}

/**
 * Start Fresh: move the session's draft into the agent home composer. The
 * session's content wins field by field so nothing already drafted at home is
 * lost when the session had none of it. Upload state moves too: both composers
 * upload into the same agent workspace, so finished paths stay valid.
 */
export function moveSessionDraftToAgent(
  store: Pick<DraftsStore, 'get' | 'set'>,
  sessionId: string,
  agentSlug: string,
  options: ComposerOptionPicks | undefined,
): void {
  const source = store.get(sessionDraftKey(sessionId))
  const home = store.get(agentDraftKey(agentSlug))
  const textFromSource = !!source?.text?.trim()
  store.set(agentDraftKey(agentSlug), {
    text: textFromSource ? source?.text : home?.text,
    securedSecrets: textFromSource ? source?.securedSecrets : home?.securedSecrets,
    attachments: source?.attachments ?? home?.attachments,
    options: options ?? source?.options ?? home?.options,
    pendingDrop: home?.pendingDrop,
  })
  store.set(sessionDraftKey(sessionId), undefined)
}

/** Seed a newly installed agent's home composer from its template prompt. */
export function seedAgentTemplatePrompt(
  store: Pick<DraftsStore, 'update'>,
  agentSlug: string,
  content: string | undefined,
): boolean {
  if (!content) return false
  store.update(agentDraftKey(agentSlug), { text: content })
  return true
}

const DraftsContext = createContext<DraftsStore | null>(null)

export function DraftsProvider({ children }: { children: ReactNode }) {
  const valuesRef = useRef(new Map<string, ComposerDraft>())
  const listenersRef = useRef(new Map<string, Set<Listener>>())

  const store = useMemo<DraftsStore>(() => {
    const set = (key: string, draft: ComposerDraft | undefined) => {
      const next = normalizeDraft(draft)
      if (sameDraft(valuesRef.current.get(key), next)) return
      if (next) valuesRef.current.set(key, next)
      else valuesRef.current.delete(key)
      listenersRef.current.get(key)?.forEach((l) => l())
    }
    return {
      get: (key) => valuesRef.current.get(key),
      set,
      update: (key, patch) => set(key, { ...valuesRef.current.get(key), ...patch }),
      subscribe(key, listener) {
        let listeners = listenersRef.current.get(key)
        if (!listeners) {
          listeners = new Set()
          listenersRef.current.set(key, listeners)
        }
        listeners.add(listener)
        return () => {
          listeners!.delete(listener)
          if (listeners!.size === 0) listenersRef.current.delete(key)
        }
      },
    }
  }, [])

  return <DraftsContext.Provider value={store}>{children}</DraftsContext.Provider>
}

const NOOP_UNSUB = () => {}

/**
 * Imperative access to the drafts store without subscribing. Use when you need
 * to read/write a draft in an event handler or effect but must NOT re-render on
 * every keystroke (which `useComposerDraft` would cause). The returned store is stable.
 */
export function useDraftsStore(): DraftsStore {
  const store = useContext(DraftsContext)
  if (!store) throw new Error('useDraftsStore must be used within DraftsProvider')
  return store
}

/** Subscribe to one composer's draft. Inert when `key` is null or undefined. */
export function useComposerDraft(
  key: string | null | undefined,
): [ComposerDraft | undefined, (patch: ComposerDraft) => void] {
  const store = useDraftsStore()
  const subscribe = useCallback((cb: Listener) => (key ? store.subscribe(key, cb) : NOOP_UNSUB), [store, key])
  const getSnapshot = useCallback(() => (key ? store.get(key) : undefined), [store, key])
  const draft = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const update = useCallback((patch: ComposerDraft) => {
    if (key) store.update(key, patch)
  }, [store, key])
  return [draft, update]
}
