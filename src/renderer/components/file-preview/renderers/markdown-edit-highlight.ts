import { diffLines } from 'diff'
import type { Element, Root } from 'hast'

export interface EditedLines {
  /** 1-based lines of the new text that were added or changed. */
  changed: ReadonlySet<number>
  /** 1-based lines of the new text that a removal sat just before. Past the last line means the end. */
  removedBefore: ReadonlySet<number>
}

/** Longest the diff may run on the render path before the highlight is dropped. */
const DIFF_TIMEOUT_MS = 100

/** Null when the diff took too long to compute, which shows no highlight. */
export function diffEditedLines(before: string, now: string): EditedLines | null {
  const parts = diffLines(before, now, { ignoreNewlineAtEof: true, timeout: DIFF_TIMEOUT_MS })
  if (!parts) return null
  const changed = new Set<number>()
  const removedBefore = new Set<number>()
  let line = 1
  for (const part of parts) {
    if (part.removed) {
      removedBefore.add(line)
    } else {
      if (part.added) for (let i = 0; i < part.count; i++) changed.add(line + i)
      line += part.count
    }
  }
  return { changed, removedBefore }
}

/** How a rendered block was edited, as its `data-edit` attribute. */
export type BlockEdit = 'changed' | 'removed-above' | 'removed-below'

/** The highlight unit: a top-level block, or each item of a top-level list. */
function highlightBlocks(tree: Root): Element[] {
  const blocks: Element[] = []
  for (const node of tree.children) {
    if (node.type !== 'element' || !node.position) continue
    if (node.tagName === 'ul' || node.tagName === 'ol') {
      for (const item of node.children) {
        if (item.type === 'element' && item.position) blocks.push(item)
      }
    } else {
      blocks.push(node)
    }
  }
  return blocks
}

/**
 * Tags each block whose source lines changed with `data-edit="changed"`, and
 * the block next to a deleted run with `removed-above` or `removed-below`.
 * Tagging rather than wrapping keeps the rendered layout identical, so turning
 * the highlight on or off moves nothing. A deletion inside a surviving block
 * marks that block changed.
 */
export function rehypeEditHighlight(lines: EditedLines) {
  return (tree: Root) => {
    const removals = [...lines.removedBefore].sort((a, b) => a - b)
    let next = 0
    let last: Element | null = null
    for (const block of highlightBlocks(tree)) {
      const start = block.position?.start.line ?? 0
      const end = block.position?.end.line ?? 0
      let edit: BlockEdit | null = null
      for (; next < removals.length && removals[next] <= end; next++) {
        if (removals[next] > start) edit = 'changed'
        else edit ??= 'removed-above'
      }
      for (let line = start; line <= end && edit !== 'changed'; line++) {
        if (lines.changed.has(line)) edit = 'changed'
      }
      if (edit) block.properties.dataEdit = edit
      last = block
    }
    if (next < removals.length && last && last.properties.dataEdit !== 'changed') {
      last.properties.dataEdit = 'removed-below'
    }
  }
}

/** The `data-edit` a block override should forward from its hast node. */
export function blockEdit(node: Element | undefined): BlockEdit | undefined {
  const edit = node?.properties.dataEdit
  return edit === 'changed' || edit === 'removed-above' || edit === 'removed-below' ? edit : undefined
}
