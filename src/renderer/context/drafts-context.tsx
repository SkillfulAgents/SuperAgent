import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Attachment } from '@renderer/components/messages/attachment-preview'
import type { DataTransferResult } from '@renderer/lib/file-utils'
import { RUNTIME_OPTION_KEYS, type RuntimeOptions } from '@shared/lib/container/runtime-options'

type Listener = () => void

/** Files dropped on a sidebar row, waiting for that row's composer to mount. */
export interface PendingAttachmentDrop {
  items: DataTransferResult
  droppedAt: number
}

/**
 * Everything unsent in one composer, under that composer's key. A composer that
 * unmounts (another session is opened, the app goes to another page) comes back
 * with all of it; the two `pending`/`inherited` fields are handed to a composer
 * by something else and taken by it when it mounts.
 */
export interface ComposerDraft {
  text?: string
  /** The chips, with how far each upload got. A preview that is an object URL is not kept: its composer revokes it. */
  attachments?: Attachment[]
  /**
   * Model, connection, effort and speed the person picked here and has not sent.
   * Never a default the picker adopted nor the session's own options: those stay
   * the server's to resolve, so only a pick is ever stored.
   */
  options?: RuntimeOptions
  pendingDrop?: PendingAttachmentDrop
  /**
   * The runtime options of the conversation this draft was moved out of (Start
   * Fresh). The composer starts from them once; they are not picks, so leaving
   * and coming back returns to the defaults.
   */
  inheritedOptions?: RuntimeOptions
}

export interface DraftsStore {
  get(key: string): ComposerDraft | undefined
  /** Replace the whole record. Empty fields are dropped, and a record left with none is deleted. */
  set(key: string, draft: ComposerDraft | undefined): void
  /** Merge fields into the record. A field given as undefined is removed. */
  update(key: string, patch: ComposerDraft): void
  subscribe(key: string, listener: Listener): () => void
}

/**
 * The id of an agent's home composer and its file drawer, as a session's id is its composer's and drawer's: its draft
 * is `sessionDraftKey` of this, where the drawer's Submit adds comments and other parts of the app put text for a new conversation.
 */
export function agentHomeId(agentSlug: string): string {
  return `agent-home:${agentSlug}`
}

/** A session's composer. */
export const sessionDraftKey = (sessionId: string) => `session:${sessionId}`
/** An agent's home composer: Agent Home, and Team Brain's home for its agent. */
export const agentHomeDraftKey = (agentSlug: string) => sessionDraftKey(agentHomeId(agentSlug))
/** The session view before its first message, which becomes `sessionDraftKey` of the session that message creates. */
export const newSessionDraftKey = (agentSlug: string) => `new-session:${agentSlug}`

function normalizeOptions(options: RuntimeOptions | undefined): RuntimeOptions | undefined {
  if (!options) return undefined
  const kept = Object.fromEntries(
    RUNTIME_OPTION_KEYS.filter((key) => options[key] !== undefined).map((key) => [key, options[key]]),
  ) as RuntimeOptions
  return Object.keys(kept).length > 0 ? kept : undefined
}

const sameOptions = (a: RuntimeOptions | undefined, b: RuntimeOptions | undefined) =>
  RUNTIME_OPTION_KEYS.every((key) => a?.[key] === b?.[key])

const isObjectUrl = (attachment: Attachment) => attachment.type === 'file' && !!attachment.preview?.startsWith('blob:')

// An object URL belongs to the composer that made it and is revoked when that
// composer unmounts, so a stored one would be dead by the time anything read it.
// A preview the server serves (a converted HEIC) is an ordinary URL and stays.
function withoutObjectUrls(attachments: Attachment[]): Attachment[] {
  if (!attachments.some(isObjectUrl)) return attachments
  return attachments.map((attachment) => (isObjectUrl(attachment) ? { ...attachment, preview: undefined } : attachment))
}

function normalizeDraft(draft: ComposerDraft | undefined): ComposerDraft | undefined {
  if (!draft) return undefined
  const next: ComposerDraft = {}
  if (draft.text) next.text = draft.text
  if (draft.attachments?.length) next.attachments = withoutObjectUrls(draft.attachments)
  const options = normalizeOptions(draft.options)
  if (options) next.options = options
  if (draft.pendingDrop) next.pendingDrop = draft.pendingDrop
  const inheritedOptions = normalizeOptions(draft.inheritedOptions)
  if (inheritedOptions) next.inheritedOptions = inheritedOptions
  return Object.keys(next).length > 0 ? next : undefined
}

function sameDraft(a: ComposerDraft | undefined, b: ComposerDraft | undefined): boolean {
  if (!a || !b) return a === b
  return (
    a.text === b.text &&
    a.attachments === b.attachments &&
    a.pendingDrop === b.pendingDrop &&
    sameOptions(a.options, b.options) &&
    sameOptions(a.inheritedOptions, b.inheritedOptions)
  )
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

/**
 * Fork Session: the fork gets a copy of the source's unsent draft, and the
 * source keeps its own. The caller reads the source when the fork is asked for
 * (the fork's id does not exist yet) and passes it here once it does. A file
 * that had finished uploading is in the same agent's workspace, so its chip is
 * sent as it is; what was handed to the source's composer alone is left behind.
 */
export function copyComposerDraft(
  store: Pick<DraftsStore, 'set'>,
  toKey: string,
  draft: ComposerDraft | undefined,
): void {
  if (draft) store.set(toKey, { ...draft, pendingDrop: undefined, inheritedOptions: undefined })
}

/**
 * Start Fresh: the session's draft moves to the agent's home composer. Text,
 * files and picks each replace what was drafted at home when the session has
 * any, and are left alone when it has none. What the person picked in the
 * session and had not sent stays a pick; the session's own options
 * (`sessionOptions`) are only where the home composer starts from. Finished
 * uploads move as they are: both composers upload into the same agent workspace.
 */
export function moveSessionDraftToAgent(
  store: Pick<DraftsStore, 'get' | 'set'>,
  sessionId: string,
  agentSlug: string,
  sessionOptions: RuntimeOptions | undefined,
): void {
  const source = store.get(sessionDraftKey(sessionId))
  const home = store.get(agentHomeDraftKey(agentSlug))
  store.set(agentHomeDraftKey(agentSlug), {
    text: source?.text?.trim() ? source.text : home?.text,
    attachments: source?.attachments ?? home?.attachments,
    // Whole, not knob by knob: a model is picked together with its connection.
    options: source?.options ?? home?.options,
    pendingDrop: home?.pendingDrop,
    inheritedOptions: sessionOptions,
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
  store.update(agentHomeDraftKey(agentSlug), { text: content })
  return true
}

const DraftsContext = createContext<DraftsStore | null>(null)

export function DraftsProvider({ children }: { children: ReactNode }) {
  const valuesRef = useRef(new Map<string, ComposerDraft>())
  const listenersRef = useRef(new Map<string, Set<Listener>>())

  const store = useMemo<DraftsStore>(() => {
    const set = (key: string, draft: ComposerDraft | undefined) => {
      const next = normalizeDraft(draft)
      // A write that changes nothing tells nobody: each field has its own writer, and most of what one writes is
      // what is already there.
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
 * every keystroke (which `useDraftText` would cause). The returned store is stable.
 */
export function useDraftsStore(): DraftsStore {
  const store = useContext(DraftsContext)
  if (!store) throw new Error('useDraftsStore must be used within DraftsProvider')
  return store
}

/**
 * The store where there is one. For the model picker's state, which most
 * places use with no composer and no draft, some of them outside the provider.
 */
export function useOptionalDraftsStore(): DraftsStore | null {
  return useContext(DraftsContext)
}

/**
 * Take the options a draft was moved in with (Start Fresh): the composer that
 * mounts next starts from them, and they leave the draft with it, so the one
 * after that starts from the defaults.
 */
export function useInheritedOptions(key: string): RuntimeOptions | undefined {
  const store = useDraftsStore()
  const [inherited] = useState(() => store.get(key)?.inheritedOptions)
  useEffect(() => {
    store.update(key, { inheritedOptions: undefined })
  }, [key, store])
  return inherited
}

/**
 * Subscribe to the text of one composer's draft, and to nothing else in it: a
 * chip's upload ticking along or a model pick does not re-render the reader.
 * Inert when `key` is null or undefined.
 */
export function useDraftText(key: string | null | undefined): [string | undefined, (text: string | undefined) => void] {
  const store = useDraftsStore()
  const subscribe = useCallback((cb: Listener) => (key ? store.subscribe(key, cb) : NOOP_UNSUB), [store, key])
  const getSnapshot = useCallback(() => (key ? store.get(key)?.text : undefined), [store, key])
  const text = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const setText = useCallback((next: string | undefined) => {
    if (key) store.update(key, { text: next })
  }, [store, key])
  return [text, setText]
}
