// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import type { Attachment } from '@renderer/components/messages/attachment-preview'
import type { RuntimeOptions } from '@shared/lib/container/runtime-options'
import {
  agentHomeDraftKey,
  appendToSessionDraft,
  copyComposerDraft,
  DraftsProvider,
  moveSessionDraftToAgent,
  newSessionDraftKey,
  seedAgentTemplatePrompt,
  sessionDraftKey,
  useDraftText,
  useDraftsStore,
  useInheritedOptions,
  type ComposerDraft,
  type DraftsStore,
} from './drafts-context'

function wrapper({ children }: { children: ReactNode }) {
  return createElement(DraftsProvider, null, children)
}

function renderStore(): DraftsStore {
  return renderHook(() => useDraftsStore(), { wrapper }).result.current
}

const uploaded = (id: string, agentSlug = 'agent-a'): Attachment => ({
  type: 'file',
  id,
  file: new File(['x'], `${id}.txt`),
  upload: { status: 'done', path: `/workspace/uploads/${id}.txt`, agentSlug },
})

describe('draft keys', () => {
  it('names each composer', () => {
    expect(sessionDraftKey('s-1')).toBe('session:s-1')
    expect(agentHomeDraftKey('agent-a')).toBe('session:agent-home:agent-a')
    expect(newSessionDraftKey('agent-a')).toBe('new-session:agent-a')
  })
})

describe('DraftsStore', () => {
  it('merges an update into the record and leaves its other fields', () => {
    const store = renderStore()
    const attachments = [uploaded('a')]
    store.update('k', { text: 'hello' })
    store.update('k', { attachments })
    store.update('k', { options: { model: 'opus' } })
    expect(store.get('k')).toEqual({ text: 'hello', attachments, options: { model: 'opus' } })
  })

  it('removes a field updated to undefined, and the record with its last field', () => {
    const store = renderStore()
    store.update('k', { text: 'hello', options: { effort: 'high' } })
    store.update('k', { text: undefined })
    expect(store.get('k')).toEqual({ options: { effort: 'high' } })
    store.update('k', { options: undefined })
    expect(store.get('k')).toBeUndefined()
  })

  it('replaces the whole record on set', () => {
    const store = renderStore()
    store.update('k', { text: 'hello', options: { effort: 'high' } })
    store.set('k', { text: 'other' })
    expect(store.get('k')).toEqual({ text: 'other' })
    store.set('k', undefined)
    expect(store.get('k')).toBeUndefined()
  })

  it('keeps nothing for an empty text, an empty list or options with nothing picked', () => {
    const store = renderStore()
    store.set('k', { text: '', attachments: [], options: { model: undefined }, inheritedOptions: {} })
    expect(store.get('k')).toBeUndefined()
  })

  it('does not keep an object URL, which its composer revokes, but keeps a preview the server serves', () => {
    const store = renderStore()
    const image = new File(['x'], 'a.png', { type: 'image/png' })
    const local: Attachment = { type: 'file', id: 'local', file: image, preview: 'blob:http://localhost/1' }
    const served: Attachment = { type: 'file', id: 'served', file: image, preview: '/api/agents/a/files/uploads/a.heic?inline=1' }
    store.update('k', { attachments: [local, served] })
    expect(store.get('k')?.attachments).toEqual([{ ...local, preview: undefined }, served])
    // The composer's own chip keeps its URL.
    expect(local.preview).toBe('blob:http://localhost/1')
  })

  it('tells nobody about a write that changes nothing', () => {
    const store = renderStore()
    const attachments = [uploaded('a')]
    store.set('k', { text: 'hello', attachments, options: { model: 'opus', effort: 'high' } })
    const listener = vi.fn()
    store.subscribe('k', listener)

    store.update('k', { text: 'hello' })
    store.update('k', { attachments })
    store.update('k', { options: { effort: 'high', model: 'opus' } })
    store.update('other', { text: 'elsewhere' })
    expect(listener).not.toHaveBeenCalled()

    store.update('k', { options: { model: 'opus', effort: 'low' } })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('useDraftText', () => {
  it('returns undefined for an unset key', () => {
    const { result } = renderHook(() => useDraftText('k'), { wrapper })
    expect(result.current[0]).toBeUndefined()
  })

  it('stores and reads a value via setter', () => {
    const { result } = renderHook(() => useDraftText('k'), { wrapper })
    act(() => result.current[1]('hello'))
    expect(result.current[0]).toBe('hello')
  })

  it('clears the value when set to undefined', () => {
    const { result } = renderHook(() => useDraftText('k'), { wrapper })
    act(() => result.current[1]('hello'))
    act(() => result.current[1](undefined))
    expect(result.current[0]).toBeUndefined()
  })

  it('isolates keys — writing one does not affect another', () => {
    const { result } = renderHook(
      () => ({ a: useDraftText('a'), b: useDraftText('b') }),
      { wrapper },
    )
    act(() => result.current.a[1]('A-value'))
    expect(result.current.a[0]).toBe('A-value')
    expect(result.current.b[0]).toBeUndefined()
  })

  it('notifies subscribers of the same key across independent hooks', () => {
    const { result } = renderHook(
      () => {
        const reader = useDraftText('shared')
        const writer = useDraftText('shared')
        return { reader, writer }
      },
      { wrapper },
    )
    act(() => result.current.writer[1]('from-writer'))
    expect(result.current.reader[0]).toBe('from-writer')
  })

  it('writes only the text, and does not re-render for the rest of the draft', () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return { text: useDraftText('k'), store: useDraftsStore() }
    }, { wrapper })
    act(() => result.current.store.update('k', { text: 'hello', options: { model: 'opus' } }))
    const before = renders

    act(() => result.current.store.update('k', { attachments: [uploaded('a')] }))
    act(() => result.current.store.update('k', { options: { model: 'sonnet' } }))
    expect(renders).toBe(before)

    act(() => result.current.text[1]('edited'))
    expect(result.current.store.get('k')).toMatchObject({ text: 'edited', options: { model: 'sonnet' } })
  })

  it('is inert when the key is null', () => {
    const { result } = renderHook(() => useDraftText(null), { wrapper })
    expect(result.current[0]).toBeUndefined()
    // Setting is a no-op — should not throw and value stays undefined.
    act(() => result.current[1]('ignored'))
    expect(result.current[0]).toBeUndefined()
  })

  it('switches subscription when the key changes', () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => ({
        active: useDraftText(key),
        a: useDraftText('a'),
        b: useDraftText('b'),
      }),
      { wrapper, initialProps: { key: 'a' } },
    )
    act(() => {
      result.current.a[1]('A')
      result.current.b[1]('B')
    })
    expect(result.current.active[0]).toBe('A')
    rerender({ key: 'b' })
    expect(result.current.active[0]).toBe('B')
  })

  it('throws when used outside a DraftsProvider', () => {
    expect(() => renderHook(() => useDraftText('k'))).toThrow(/DraftsProvider/)
  })
})

describe('appendToSessionDraft', () => {
  it('appends content after the existing session draft', () => {
    const { result } = renderHook(() => ({
      draft: useDraftText('session:s-1'),
      store: useDraftsStore(),
    }), { wrapper })

    act(() => result.current.draft[1]('  Existing draft  '))
    act(() => appendToSessionDraft(
      result.current.store,
      's-1',
      '  File feedback  ',
      { prepend: false },
    ))

    expect(result.current.draft[0]).toBe('Existing draft\n\nFile feedback')
  })

  it('prepends rescued content before the existing session draft', () => {
    const { result } = renderHook(() => ({
      draft: useDraftText('session:s-1'),
      store: useDraftsStore(),
    }), { wrapper })

    act(() => result.current.draft[1]('Current draft'))
    act(() => appendToSessionDraft(
      result.current.store,
      's-1',
      'Rescued message',
      { prepend: true },
    ))

    expect(result.current.draft[0]).toBe('Rescued message\n\nCurrent draft')
  })

  it('leaves the files and picks drafted with the text', () => {
    const store = renderStore()
    const attachments = [uploaded('a')]
    store.set('session:s-1', { attachments, options: { model: 'opus' } })
    appendToSessionDraft(store, 's-1', 'File feedback', { prepend: false })
    expect(store.get('session:s-1')).toEqual({ text: 'File feedback', attachments, options: { model: 'opus' } })
  })
})

describe('seedAgentTemplatePrompt', () => {
  it('stores the template prompt under the new agent home draft key', () => {
    const { result } = renderHook(() => ({
      draft: useDraftText('session:agent-home:new-agent'),
      store: useDraftsStore(),
    }), { wrapper })

    act(() => {
      expect(seedAgentTemplatePrompt(result.current.store, 'new-agent', 'Start with this task')).toBe(true)
    })

    expect(result.current.draft[0]).toBe('Start with this task')
  })

  it('does not seed or suppress onboarding when the prompt is absent', () => {
    const { result } = renderHook(() => useDraftsStore(), { wrapper })

    expect(seedAgentTemplatePrompt(result.current, 'new-agent', undefined)).toBe(false)
    expect(result.current.get('session:agent-home:new-agent')).toBeUndefined()
  })
})

describe('copyComposerDraft (Fork Session)', () => {
  it('copies the draft as it was when read, and leaves the source its own', () => {
    const store = renderStore()
    const draft: ComposerDraft = { text: 'unsent text', attachments: [uploaded('a')], options: { model: 'opus', effort: 'high' } }
    store.set('session:src', draft)

    const atClick = store.get('session:src')
    store.update('session:src', { text: 'edited after click' }) // click-time values must win
    copyComposerDraft(store, 'session:fork', atClick)

    expect(store.get('session:fork')).toEqual(draft)
    expect(store.get('session:src')?.text).toBe('edited after click')
  })

  it('leaves behind what was only handed to the source composer', () => {
    const store = renderStore()
    store.set('session:src', {
      text: 'unsent',
      pendingDrop: { items: { files: [], folders: [] }, droppedAt: 1 },
      inheritedOptions: { model: 'opus' },
    })
    copyComposerDraft(store, 'session:fork', store.get('session:src'))
    expect(store.get('session:fork')).toEqual({ text: 'unsent' })
  })

  it('copies nothing when the source had no draft', () => {
    const store = renderStore()
    copyComposerDraft(store, 'session:fork', store.get('session:src'))
    expect(store.get('session:fork')).toBeUndefined()
  })
})

describe('moveSessionDraftToAgent (Start Fresh)', () => {
  it('moves the text, the files with their upload state and the picks, and empties the session', () => {
    const store = renderStore()
    const attachments = [uploaded('a')]
    store.set('session:s-1', { text: '  keep this text  ', attachments, options: { model: 'opus', llmProviderId: 'conn-1' } })

    moveSessionDraftToAgent(store, 's-1', 'agent-a', { model: 'opus', llmProviderId: 'conn-1', effort: 'high' })

    expect(store.get('session:agent-home:agent-a')).toEqual({
      text: '  keep this text  ',
      attachments,
      options: { model: 'opus', llmProviderId: 'conn-1' },
      inheritedOptions: { model: 'opus', llmProviderId: 'conn-1', effort: 'high' },
    })
    expect(store.get('session:s-1')).toBeUndefined()
  })

  it('carries what the session runs on as where the home composer starts, not as a pick', () => {
    const store = renderStore()
    store.set('session:s-1', { text: 'continue' })
    moveSessionDraftToAgent(store, 's-1', 'agent-a', { model: 'sonnet', effort: 'low', speed: 'fast' })
    const home = store.get('session:agent-home:agent-a')
    expect(home?.inheritedOptions).toEqual({ model: 'sonnet', effort: 'low', speed: 'fast' })
    expect(home?.options).toBeUndefined()
  })

  it('leaves what was drafted at home wherever the session has none of it', () => {
    const store = renderStore()
    const homeFiles = [uploaded('home')]
    const pendingDrop = { items: { files: [], folders: [] }, droppedAt: 1 }
    store.set('session:agent-home:agent-a', { text: 'home text', attachments: homeFiles, options: { effort: 'high' }, pendingDrop })
    store.set('session:s-1', { text: '   ' })

    // A session with nothing picked and nothing of its own to carry.
    moveSessionDraftToAgent(store, 's-1', 'agent-a', {})

    expect(store.get('session:agent-home:agent-a')).toEqual({
      text: 'home text',
      attachments: homeFiles,
      options: { effort: 'high' },
      pendingDrop,
    })
  })

  it('replaces what was drafted at home with the session’s, field by field', () => {
    const store = renderStore()
    const sessionFiles = [uploaded('session')]
    store.set('session:agent-home:agent-a', { text: 'home text', attachments: [uploaded('home')], options: { model: 'haiku', llmProviderId: 'conn-2' } })
    store.set('session:s-1', { text: 'session text', attachments: sessionFiles, options: { model: 'opus' } })

    moveSessionDraftToAgent(store, 's-1', 'agent-a', undefined)

    // A model is picked with its connection, so the picks go as one.
    expect(store.get('session:agent-home:agent-a')).toEqual({ text: 'session text', attachments: sessionFiles, options: { model: 'opus' } })
  })
})

describe('useInheritedOptions', () => {
  it('gives the options a draft was moved in with to the composer that mounts next, once', () => {
    let store!: DraftsStore
    let inherited: RuntimeOptions | undefined
    function Composer() {
      inherited = useInheritedOptions('k')
      return null
    }
    // `composer` names the mounted composer: a new number is a new mount.
    function Page({ composer }: { composer: number | null }) {
      store = useDraftsStore()
      return composer === null ? null : <Composer key={composer} />
    }
    const page = (composer: number | null) => <DraftsProvider><Page composer={composer} /></DraftsProvider>

    const { rerender } = render(page(null))
    act(() => store.set('k', { text: 'moved', inheritedOptions: { model: 'opus', effort: 'high' } }))

    rerender(page(1))
    expect(inherited).toEqual({ model: 'opus', effort: 'high' })
    // Its own for as long as that composer is mounted, and gone from the draft.
    rerender(page(1))
    expect(inherited).toEqual({ model: 'opus', effort: 'high' })
    expect(store.get('k')).toEqual({ text: 'moved' })

    rerender(page(2))
    expect(inherited).toBeUndefined()
  })
})
