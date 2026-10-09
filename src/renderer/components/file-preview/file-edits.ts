/** What changed in an open file since the last message of yours that led to a change. */
export interface FileEdits {
  /** The text the preview last showed. */
  now: string
  /** The text before this turn's changes. Null until a change arrives. */
  before: string | null
  /** The "Show changes" toggle. Turns on when a new change starts a highlight. */
  show: boolean
  /** You sent a message since the last change, so the next change starts a new highlight. */
  fresh: boolean
}

/** Files this large are reloaded but never diffed. */
const MAX_HIGHLIGHT_CHARS = 500_000

/** A trailing newline alone is not a change: the diff ignores it too. */
const sameText = (a: string, b: string) => a.replace(/\n$/, '') === b.replace(/\n$/, '')

/** Fold the text the preview just showed into the tab's edits. */
export function reconcileEdits(prev: FileEdits | undefined, text: string): FileEdits {
  if (!prev) return { now: text, before: null, show: false, fresh: false }
  if (sameText(text, prev.now)) return prev
  // The first change since your message starts a new highlight. Later ones grow it.
  if (prev.fresh || prev.before === null) return { now: text, before: prev.now, show: true, fresh: false }
  return { ...prev, now: text }
}

/** The text to diff against, or null when there is nothing to show: undone, emptied, or too large. */
export function visibleBefore(edits: FileEdits | undefined): string | null {
  if (!edits || edits.before === null || sameText(edits.before, edits.now) || edits.now.trim() === '') return null
  return Math.max(edits.before.length, edits.now.length) > MAX_HIGHLIGHT_CHARS ? null : edits.before
}
