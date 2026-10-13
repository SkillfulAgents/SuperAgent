// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import type { Attachment } from '@renderer/components/messages/attachment-preview'
import {
  agentDraftKey,
  appendToSessionDraft,
  copyComposerDraft,
  DraftsProvider,
  moveSessionDraftToAgent,
  seedAgentTemplatePrompt,
  sessionDraftKey,
  useComposerDraft,
  useDraftsStore,
} from './drafts-context'

function wrapper({ children }: { children: ReactNode }) {
  return createElement(DraftsProvider, null, children)
}

function renderStore() {
  return renderHook(() => useDraftsStore(), { wrapper }).result.current
}

const doneFile: Attachment = {
  type: 'file',
  id: 'file-1',
  file: new File(['x'], 'notes.txt'),
  upload: { status: 'done', path: '/workspace/notes.txt', agentSlug: 'agent-a' },
}

describe('DraftsStore', () => {
  it('keeps every part of a composer draft in one record', () => {
    const store = renderStore()
    act(() => {
      store.update('session:s-1', { text: 'hello' })
      store.update('session:s-1', { attachments: [doneFile] })
      store.update('session:s-1', { options: { model: 'sonnet', llmProviderId: 'anthropic' } })
    })

    expect(store.get('session:s-1')).toEqual({
      text: 'hello',
      attachments: [doneFile],
      options: { model: 'sonnet', llmProviderId: 'anthropic' },
    })
  })

  it('drops empty fields and deletes a record with nothing left', () => {
    const store = renderStore()
    act(() => store.update('k', { text: 'x', attachments: [doneFile], options: { effort: 'high' } }))
    act(() => store.update('k', { text: '', attachments: [], options: { effort: undefined } }))
    expect(store.get('k')).toBeUndefined()
  })

  it('never stores object URLs, which die with the composer that made them', () => {
    const store = renderStore()
    act(() => store.update('k', { attachments: [{ ...doneFile, preview: 'blob:preview' }] }))
    expect(store.get('k')?.attachments).toEqual([{ ...doneFile, preview: undefined }])
  })
})

describe('useComposerDraft', () => {
  it('returns undefined for an unset key', () => {
    const { result } = renderHook(() => useComposerDraft('k'), { wrapper })
    expect(result.current[0]).toBeUndefined()
  })

  it('merges patches and notifies other subscribers of the same key', () => {
    const { result } = renderHook(
      () => ({ reader: useComposerDraft('shared'), writer: useComposerDraft('shared') }),
      { wrapper },
    )
    act(() => result.current.writer[1]({ text: 'from-writer' }))
    act(() => result.current.writer[1]({ options: { speed: 'fast' } }))
    expect(result.current.reader[0]).toEqual({ text: 'from-writer', options: { speed: 'fast' } })
  })

  it('isolates keys', () => {
    const { result } = renderHook(() => ({ a: useComposerDraft('a'), b: useComposerDraft('b') }), { wrapper })
    act(() => result.current.a[1]({ text: 'A' }))
    expect(result.current.a[0]).toEqual({ text: 'A' })
    expect(result.current.b[0]).toBeUndefined()
  })

  it('is inert when the key is null', () => {
    const { result } = renderHook(() => useComposerDraft(null), { wrapper })
    act(() => result.current[1]({ text: 'ignored' }))
    expect(result.current[0]).toBeUndefined()
  })

  it('switches subscription when the key changes', () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => ({ active: useComposerDraft(key), store: useDraftsStore() }),
      { wrapper, initialProps: { key: 'a' } },
    )
    act(() => {
      result.current.store.update('a', { text: 'A' })
      result.current.store.update('b', { text: 'B' })
    })
    expect(result.current.active[0]?.text).toBe('A')
    rerender({ key: 'b' })
    expect(result.current.active[0]?.text).toBe('B')
  })

  it('throws when used outside a DraftsProvider', () => {
    expect(() => renderHook(() => useComposerDraft('k'))).toThrow(/DraftsProvider/)
  })
})

describe('appendToSessionDraft', () => {
  it('appends content after the existing text and keeps the rest of the draft', () => {
    const store = renderStore()
    act(() => store.set(sessionDraftKey('s-1'), { text: '  Existing draft  ', attachments: [doneFile] }))
    act(() => appendToSessionDraft(store, 's-1', '  File feedback  ', { prepend: false }))
    expect(store.get(sessionDraftKey('s-1'))).toEqual({ text: 'Existing draft\n\nFile feedback', attachments: [doneFile] })
  })

  it('prepends rescued content before the existing text', () => {
    const store = renderStore()
    act(() => store.update(sessionDraftKey('s-1'), { text: 'Current draft' }))
    act(() => appendToSessionDraft(store, 's-1', 'Rescued message', { prepend: true }))
    expect(store.get(sessionDraftKey('s-1'))?.text).toBe('Rescued message\n\nCurrent draft')
  })
})

describe('seedAgentTemplatePrompt', () => {
  it('stores the template prompt as the agent home draft text', () => {
    const store = renderStore()
    act(() => {
      expect(seedAgentTemplatePrompt(store, 'new-agent', 'Start with this task')).toBe(true)
    })
    expect(store.get(agentDraftKey('new-agent'))?.text).toBe('Start with this task')
  })

  it('does not seed or suppress onboarding when the prompt is absent', () => {
    const store = renderStore()
    expect(seedAgentTemplatePrompt(store, 'new-agent', undefined)).toBe(false)
    expect(store.get(agentDraftKey('new-agent'))).toBeUndefined()
  })
})

describe('copyComposerDraft', () => {
  it('copies the click-time draft into the fork and leaves the source alone', () => {
    const store = renderStore()
    act(() => store.set('session:src', {
      text: 'unsent text',
      attachments: [doneFile],
      securedSecrets: [{ id: 's1', key: 'Token', envVar: 'TOKEN', displayText: '[Token]' }],
      options: { model: 'haiku' },
    }))
    const snapshot = store.get('session:src')
    act(() => store.update('session:src', { text: 'edited after click' }))
    act(() => copyComposerDraft(store, 'session:fork', snapshot))

    expect(store.get('session:fork')).toEqual(snapshot)
    expect(store.get('session:src')?.text).toBe('edited after click')
  })

  it('seeds nothing when the source had no draft', () => {
    const store = renderStore()
    act(() => copyComposerDraft(store, 'session:fork', undefined))
    expect(store.get('session:fork')).toBeUndefined()
  })
})

describe('moveSessionDraftToAgent', () => {
  it('moves the whole session draft home with the effective options and clears the session', () => {
    const store = renderStore()
    act(() => store.set(sessionDraftKey('s-1'), { text: 'Continue as a new task', attachments: [doneFile] }))
    act(() => moveSessionDraftToAgent(store, 's-1', 'agent-a', { model: 'sonnet', llmProviderId: 'anthropic', effort: 'high', speed: 'normal' }))

    expect(store.get(agentDraftKey('agent-a'))).toEqual({
      text: 'Continue as a new task',
      attachments: [doneFile],
      options: { model: 'sonnet', llmProviderId: 'anthropic', effort: 'high', speed: 'normal' },
    })
    expect(store.get(sessionDraftKey('s-1'))).toBeUndefined()
  })

  it('keeps home content the session draft does not replace', () => {
    const store = renderStore()
    act(() => {
      store.set(agentDraftKey('agent-a'), { text: 'Home text', attachments: [doneFile] })
      store.set(sessionDraftKey('s-1'), { text: '   ' })
    })
    act(() => moveSessionDraftToAgent(store, 's-1', 'agent-a', undefined))
    expect(store.get(agentDraftKey('agent-a'))).toEqual({ text: 'Home text', attachments: [doneFile] })
  })
})
