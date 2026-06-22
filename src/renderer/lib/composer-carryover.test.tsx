// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect } from 'vitest'
import { act, render } from '@testing-library/react'
import {
  carryoverKey,
  splitSnapshotForHandoff,
  carryoverToComposerInit,
  useNewChatCarryover,
  summaryKey,
  useNewChatSummary,
  type ComposerSnapshot,
  type NewChatCarryover,
  type NewChatSummary,
} from './composer-carryover'
import { DraftsProvider, useDraftsStore } from '@renderer/context/drafts-context'
import type { Attachment } from '@renderer/components/messages/attachment-preview'

// "Run this side effect once during the initial render" helper for the seeder
// below — sets up a pending carry-over before the consumer component reads it.
function useStateOnce(fn: () => void) {
  useState(() => {
    fn()
    return null
  })
}

const imageFile = (): Attachment => ({
  type: 'file',
  id: 'img',
  file: new File(['x'], 'a.png', { type: 'image/png' }),
  preview: 'blob:stale-url',
})
const textFile = (): Attachment => ({
  type: 'file',
  id: 'txt',
  file: new File(['x'], 'b.txt', { type: 'text/plain' }),
})
const folder = (): Attachment => ({
  type: 'folder',
  id: 'fld',
  folderName: 'docs',
  folderPath: '/host/docs',
  files: [],
  totalSize: 0,
})
const mount = (): Attachment => ({
  type: 'mount',
  id: 'mnt',
  folderName: 'repo',
  hostPath: '/host/repo',
})

const snapshot = (over: Partial<ComposerSnapshot> = {}): ComposerSnapshot => ({
  text: '',
  attachments: [],
  model: 'opus',
  effort: 'high',
  ...over,
})

describe('splitSnapshotForHandoff', () => {
  it('returns nothing for a missing snapshot (no live composer to read)', () => {
    expect(splitSnapshotForHandoff(undefined)).toEqual({ draftText: undefined, carryover: undefined })
  })

  it('carries model + effort even when the composer is otherwise empty', () => {
    const { draftText, carryover } = splitSnapshotForHandoff(snapshot())
    expect(draftText).toBeUndefined()
    expect(carryover).toEqual({ attachments: [], model: 'opus', effort: 'high' })
  })

  it('treats whitespace-only text as empty', () => {
    const { draftText } = splitSnapshotForHandoff(snapshot({ text: '   \n  ' }))
    expect(draftText).toBeUndefined()
  })

  it('carries non-blank text verbatim (preserving surrounding spaces)', () => {
    const { draftText } = splitSnapshotForHandoff(snapshot({ text: '  hi there ' }))
    expect(draftText).toBe('  hi there ')
  })

  it('carries files with the image preview stripped', () => {
    const { draftText, carryover } = splitSnapshotForHandoff(snapshot({ attachments: [imageFile()] }))
    expect(draftText).toBeUndefined()
    expect(carryover?.attachments).toHaveLength(1)
    const a = carryover!.attachments[0]
    expect(a.type === 'file' && a.preview).toBeUndefined()
  })

  it('leaves non-image files, folders, and mounts untouched', () => {
    const { carryover } = splitSnapshotForHandoff(
      snapshot({ attachments: [textFile(), folder(), mount()] })
    )
    expect(carryover?.attachments).toEqual([textFile(), folder(), mount()])
  })

  it('does not mutate the source snapshot when stripping previews', () => {
    const src = snapshot({ attachments: [imageFile()] })
    splitSnapshotForHandoff(src)
    expect(src.attachments[0]).toEqual(imageFile()) // preview still present on the original
  })

  it('carries text + files + model + effort together', () => {
    const { draftText, carryover } = splitSnapshotForHandoff(
      snapshot({ text: 'continue this', attachments: [textFile()], model: 'sonnet', effort: 'medium' })
    )
    expect(draftText).toBe('continue this')
    expect(carryover).toEqual({ attachments: [textFile()], model: 'sonnet', effort: 'medium' })
  })

  it('passes through an undefined model (settings still loading)', () => {
    const { carryover } = splitSnapshotForHandoff(snapshot({ model: undefined }))
    expect(carryover?.model).toBeUndefined()
  })
})

describe('carryoverToComposerInit', () => {
  it('yields empty defaults for a missing carry-over', () => {
    expect(carryoverToComposerInit(undefined)).toEqual({
      initialAttachments: [],
      initialModel: undefined,
      initialEffort: undefined,
    })
  })

  it('maps a carry-over onto the composer init props', () => {
    const carryover: NewChatCarryover = { attachments: [mount()], model: 'haiku', effort: 'low' }
    expect(carryoverToComposerInit(carryover)).toEqual({
      initialAttachments: [mount()],
      initialModel: 'haiku',
      initialEffort: 'low',
    })
  })
})

describe('useNewChatCarryover', () => {
  let store: ReturnType<typeof useDraftsStore> | undefined
  function Grab() {
    store = useDraftsStore()
    return null
  }
  function Seeder({ slug, value }: { slug: string; value: NewChatCarryover }) {
    const s = useDraftsStore()
    // Seed during render (before the consumer below mounts and reads it).
    useStateOnce(() => s.set(carryoverKey(slug), value))
    return null
  }

  it('returns undefined when nothing is pending', () => {
    const seen: (NewChatCarryover | undefined)[] = []
    function Consumer() {
      seen.push(useNewChatCarryover('agent-x'))
      return null
    }
    render(
      <DraftsProvider>
        <Consumer />
      </DraftsProvider>
    )
    expect(seen[0]).toBeUndefined()
  })

  it('reads the pending carry-over once and clears the slot', () => {
    const value: NewChatCarryover = { attachments: [textFile()], model: 'opus', effort: 'high' }
    const seen: (NewChatCarryover | undefined)[] = []
    function Consumer() {
      seen.push(useNewChatCarryover('agent-y'))
      return null
    }
    render(
      <DraftsProvider>
        <Grab />
        <Seeder slug="agent-y" value={value} />
        <Consumer />
      </DraftsProvider>
    )
    expect(seen[0]).toEqual(value)
    // The mount effect consumes the slot so a later home-view mount starts clean.
    expect(store?.get(carryoverKey('agent-y'))).toBeUndefined()
  })
})

describe('useNewChatSummary', () => {
  it('reads a summary written to the summary key and clears it on demand', () => {
    let store: ReturnType<typeof useDraftsStore> | undefined
    let carried: ReturnType<typeof useNewChatSummary> | undefined
    function Probe() {
      store = useDraftsStore()
      carried = useNewChatSummary('agent-1')
      return null
    }
    render(<DraftsProvider><Probe /></DraftsProvider>)

    expect(carried!.summary).toBeUndefined()
    act(() => {
      store!.set(summaryKey('agent-1'), { summary: '## Goal', fromSessionId: 's-1' } satisfies NewChatSummary)
    })
    expect(carried!.summary).toEqual({ summary: '## Goal', fromSessionId: 's-1' })
    act(() => carried!.clear())
    expect(carried!.summary).toBeUndefined()
  })
})
