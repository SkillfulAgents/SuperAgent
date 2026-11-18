import { describe, it, expect } from 'vitest'
import { reconcileEdits, visibleBefore, type FileEdits } from './file-edits'

const fold = (texts: string[], start?: FileEdits) => texts.reduce<FileEdits | undefined>((edits, text) => reconcileEdits(edits, text), start)

describe('reconcileEdits', () => {
  const shown: FileEdits = { now: 'b', before: 'a', show: true, fresh: false }

  it('takes the first text shown as the baseline, with nothing highlighted', () => {
    expect(reconcileEdits(undefined, 'a')).toEqual({ now: 'a', before: null, show: false, fresh: false })
  })

  it('keeps the highlight when the same text is shown again, even after a message', () => {
    expect(reconcileEdits(shown, 'b')).toBe(shown)
    expect(reconcileEdits(shown, 'b\n')).toBe(shown)
    expect(reconcileEdits({ ...shown, fresh: true }, 'b')).toEqual({ ...shown, fresh: true })
  })

  it('grows one highlight within a turn, keeping the toggle where you left it', () => {
    expect(reconcileEdits({ ...shown, show: false }, 'c')).toEqual({ now: 'c', before: 'a', show: false, fresh: false })
  })

  it('starts a new highlight at the first change after your message, and turns Show changes on', () => {
    expect(reconcileEdits({ ...shown, show: false, fresh: true }, 'c')).toEqual({ now: 'c', before: 'b', show: true, fresh: false })
    expect(reconcileEdits({ ...shown, fresh: true }, 'a')).toEqual({ now: 'a', before: 'b', show: true, fresh: false })
  })

  it('keeps the turn\'s baseline through an undo or an emptied file', () => {
    expect(fold(['a', 'b', '', 'a'])).toMatchObject({ before: 'a', now: 'a' })
    expect(fold(['b', 'a', 'c'], { ...shown, show: false })).toMatchObject({ before: 'a', now: 'c', show: false })
  })
})

describe('visibleBefore', () => {
  it('shows the baseline only when something visible changed', () => {
    expect(visibleBefore({ now: 'b', before: 'a', show: true, fresh: false })).toBe('a')
    expect(visibleBefore({ now: 'a', before: 'a', show: true, fresh: false })).toBeNull()
    expect(visibleBefore({ now: ' \n', before: 'a', show: true, fresh: false })).toBeNull()
    expect(visibleBefore({ now: 'x'.repeat(500_001), before: 'a', show: true, fresh: false })).toBeNull()
    expect(visibleBefore(undefined)).toBeNull()
  })
})
