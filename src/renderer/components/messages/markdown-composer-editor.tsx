import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import { baseKeymap, chainCommands, exitCode, joinTextblockBackward, lift, newlineInCode, setBlockType, splitBlock, toggleMark, wrapIn } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  undoInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules'
import { keymap } from 'prosemirror-keymap'
import {
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  schema as commonmarkSchema,
} from 'prosemirror-markdown'
import { Fragment, Schema, Slice, type MarkType, type NodeType, type Node as ProseMirrorNode, type ResolvedPos } from 'prosemirror-model'
import {
  liftListItem,
  sinkListItem,
  splitListItem,
  wrapInList,
} from 'prosemirror-schema-list'
import { AllSelection, EditorState, Plugin, PluginKey, TextSelection, type Command, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view'
import 'prosemirror-view/style/prosemirror.css'
import { cn } from '@shared/lib/utils'
import type { PotentialSecret, SecuredSecret } from '@renderer/lib/secret-detection'
import { FormattingToolbar, type FormatStatus } from './formatting-toolbar'

export interface MarkdownComposerEditorProps {
  value: string
  onChange: (value: string) => void
  onKeyDown?: (event: KeyboardEvent, view: EditorView) => void
  placeholder: string
  disabled?: boolean
  autoFocus?: boolean
  dataTestId?: string
  minRows?: number
  enterKeyHint?: 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send'
  className?: string
  potentialSecrets?: PotentialSecret[]
  securedSecrets?: SecuredSecret[]
  onRemoveSecuredSecrets?: (secrets: SecuredSecret[]) => void
  onEditorElement?: (element: HTMLDivElement | null) => void
  /** Shows the formatting toolbar above the text. */
  toolbar?: boolean
  toolbarClassName?: string
}

const CARET_SENTINEL = '\u2063'

const markdownSchema = new Schema({
  nodes: commonmarkSchema.spec.nodes.addBefore('hard_break', 'soft_break', {
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br[data-soft-break]' }],
    toDOM: () => ['br', { 'data-soft-break': 'true' }] as const,
  }),
  marks: commonmarkSchema.spec.marks.addBefore('link', 'strike', {
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { style: 'text-decoration=line-through' }],
    toDOM: () => ['s', 0] as const,
  }),
})

/**
 * A setext heading that spans several lines (YAML frontmatter is the common
 * case) holds line breaks, which the heading schema rejects, so the parser
 * would drop the whole heading. Keep those lines as a paragraph instead, with
 * the underline as its last line.
 */
export function demoteMultilineSetextHeadings(tokens: Token[], src: string): void {
  let lines: string[] | undefined
  for (let i = 0; i < tokens.length - 2; i++) {
    const open = tokens[i]
    const inline = tokens[i + 1]
    if (open.type !== 'heading_open' || (open.markup !== '-' && open.markup !== '=')) continue
    if (!inline.content.includes('\n') || !open.map) continue
    lines ??= src.split('\n')
    // Drop any quote or list indentation prefix from the source line.
    inline.content += `\n${lines[open.map[1] - 1].replace(/^[\s>]*/, '').trimEnd()}`
    for (const token of [open, tokens[i + 2]]) {
      token.type = token.nesting === 1 ? 'paragraph_open' : 'paragraph_close'
      token.tag = 'p'
      token.markup = ''
    }
  }
}

const markdownTokenizer = new MarkdownIt('commonmark', {
  html: false,
  linkify: true,
}).enable('strikethrough')
markdownTokenizer.core.ruler.after('block', 'demote_multiline_setext', (state) => {
  demoteMultilineSetextHeadings(state.tokens, state.src)
})

const markdownParser = new MarkdownParser(markdownSchema, markdownTokenizer, {
  ...defaultMarkdownParser.tokens,
  softbreak: { node: 'soft_break' },
  s: { mark: 'strike' },
})

/**
 * Escapes the markers that would start a block at the start of a line, so the
 * line reads back as text. A paragraph's first line can start any list, quote,
 * heading or divider. A continuation line can only be interrupted by a
 * non-empty bullet or "1." item, a quote, a heading, or a setext underline.
 */
export function escapeLineStart(text: string, paragraphStart = false): string {
  if (paragraphStart) {
    return text
      .replace(/^([ \t]*)([->]|\+(?=[ \t]|$)|#{1,6}(?=[ \t]|$))/, '$1\\$2')
      .replace(/^([ \t]*\d{1,9})([.)])(?=[ \t]|$)/, '$1\\$2')
  }
  return text
    .replace(/^([ \t]*)([-+](?=[ \t]+\S)|-[- \t]*$|=+[ \t]*$|>|#{1,6}(?=[ \t]|$))/, '$1\\$2')
    .replace(/^([ \t]*0{0,8}1)([.)])(?=[ \t]+\S)/, '$1\\$2')
}

const markdownSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    soft_break: (state) => state.write('\n'),
    // Unmarked text that starts a source line, where block syntax would re-read as structure.
    text: (state, node, parent, index) => {
      const previous = index > 0 ? parent.child(index - 1).type.name : parent.type.name
      if (parent.type.name === 'heading' && index === parent.childCount - 1 && node.marks.length === 0) {
        // A trailing " #" would re-read as the heading's optional closing sequence and disappear.
        state.text(state.esc(node.text ?? '').replace(/(^|[ \t])(#+[ \t]*)$/, '$1\\$2'), false)
        return
      }
      if (node.marks.length > 0 || !['paragraph', 'soft_break', 'hard_break'].includes(previous)) {
        defaultMarkdownSerializer.nodes.text(state, node, parent, index)
        return
      }
      state.text(escapeLineStart(state.esc(node.text ?? ''), previous === 'paragraph'), false)
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
    strike: {
      open: '~~',
      close: '~~',
      mixable: true,
      expelEnclosingWhitespace: true,
    },
  }
)

function serializeLiteralMarkdown(value: string): string {
  const paragraph = markdownSchema.nodes.paragraph.create(
    null,
    value ? markdownSchema.text(value) : undefined
  )
  return markdownSerializer.serialize(markdownSchema.nodes.doc.create(null, paragraph))
}

export function serializeComposerMarkdown(
  doc: ProseMirrorNode,
  securedSecrets: SecuredSecret[] = []
): string {
  let markdown = markdownSerializer
    .serialize(doc, { tightLists: true })
    .replaceAll(CARET_SENTINEL, '')
  // Secured displays are editor placeholders, not user-authored Markdown. Keep
  // them byte-for-byte stable so replaceSecuredSecrets can identify them even
  // after the user continues editing elsewhere in the document.
  for (const secret of securedSecrets) {
    const escapedDisplay = serializeLiteralMarkdown(secret.displayText)
    markdown = markdown.replace(escapedDisplay, () => secret.displayText)
  }
  return markdown
}

function parseComposerMarkdown(value: string): ProseMirrorNode {
  if (!/[ \t\n]$/.test(value)) return markdownParser.parse(value)

  // Markdown parsers intentionally trim end-of-block whitespace. In a
  // composer, however, a trailing space is active editing state (notably after
  // inserting `/command `). A temporary non-whitespace sentinel lets the
  // parser retain those spaces; deleting it from the document keeps the model
  // and serializer faithful without special-casing subsequent keystrokes.
  const doc = markdownParser.parse(`${value}${CARET_SENTINEL}`)
  // A trailing soft break needs an invisible inline anchor after it so the DOM
  // has a stable caret position. It is removed as soon as real text follows
  // and is never included in the serialized Markdown.
  if (value.endsWith('\n')) return doc
  let sentinelPosition: number | null = null
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const index = node.text.lastIndexOf(CARET_SENTINEL)
    if (index !== -1) sentinelPosition = pos + index
  })
  if (sentinelPosition === null) return doc
  const state = EditorState.create({ schema: markdownSchema, doc })
  return state.apply(state.tr.delete(sentinelPosition, sentinelPosition + CARET_SENTINEL.length)).doc
}

function delimitedMarkInputRule(
  regexp: RegExp,
  markType: MarkType,
  delimiterGroup: number,
  contentGroup: number
): InputRule {
  return new InputRule(regexp, (state, match, _start, end) => {
    const delimiter = match[delimiterGroup]
    const content = match[contentGroup]
    if (!delimiter || !content) return null

    // Input rules run before the final typed character is inserted, so the
    // current document only contains all but one character of the closing
    // delimiter. Keep the rule as one undoable transaction: remove that
    // partial closer, remove the opener, and mark the content between them.
    const openStart = end - delimiter.length - content.length - (delimiter.length - 1)
    const contentStart = openStart + delimiter.length
    const contentEnd = end - (delimiter.length - 1)
    if (openStart < 0 || contentStart >= contentEnd) return null

    const tr = state.tr
    if (contentEnd < end) tr.delete(contentEnd, end)
    tr
      .delete(openStart, contentStart)
      .addMark(openStart, contentEnd - delimiter.length, markType.create())
      .removeStoredMark(markType)
    return tr
  })
}

function linkInputRule(markType: MarkType): InputRule {
  return new InputRule(/\[([^\]]+)\]\((\S+?)(?:\s+["'](.+?)["'])?\)$/, (state, match, start, end) => {
    const [, label, href, title] = match
    if (!label || !href) return null
    const normalizedHref = markdownTokenizer.normalizeLink(href)
    if (!markdownTokenizer.validateLink(normalizedHref)) return null
    return state.tr
      .replaceWith(start, end, state.schema.text(label))
      .addMark(start, start + label.length, markType.create({ href: normalizedHref, title: title ?? null }))
      .removeStoredMark(markType)
  })
}

function imageInputRule(): InputRule {
  return new InputRule(/!\[([^\]]*)\]\((\S+?)(?:\s+["'](.+?)["'])?\)$/, (state, match, start, end) => {
    const [, alt, src, title] = match
    if (!src) return null
    const normalizedSrc = markdownTokenizer.normalizeLink(src)
    if (!markdownTokenizer.validateLink(normalizedSrc)) return null
    return state.tr.replaceWith(start, end, state.schema.nodes.image.create({
      src: normalizedSrc,
      alt: alt || null,
      title: title ?? null,
    }))
  })
}

function horizontalRuleInputRule(): InputRule {
  return new InputRule(/^(?:---|\*\*\*|___)$/, (state, _match, start) => {
    const $start = state.doc.resolve(start)
    if (!$start.parent.isTextblock) return null
    return state.tr.replaceWith($start.before(), $start.after(), state.schema.nodes.horizontal_rule.create())
  })
}

function blockAfterSoftBreakInputRule(
  regexp: RegExp,
  createBlock: (match: RegExpMatchArray) => ProseMirrorNode
): InputRule {
  return new InputRule(regexp, (state, match, start) => {
    const { $from } = state.selection
    const textblock = $from.parent
    if (!textblock.isTextblock || textblock.type.spec.code) return null

    // InputRules represents every inline leaf node as U+FFFC. Confirm the leaf
    // that actually satisfied this rule is our soft break; an earlier soft break
    // plus a trailing image must not make the image look like a line boundary.
    const $start = state.doc.resolve(start)
    if ($start.parent !== textblock || $start.nodeAfter?.type !== state.schema.nodes.soft_break) {
      return null
    }
    const softBreakOffset = $start.parentOffset

    const block = createBlock(match)
    const contentBeforeBreak = textblock.content.cut(0, softBreakOffset)
    const textblockBefore = textblock.type.create(textblock.attrs, contentBeforeBreak)

    // An explicit list marker after Shift+Enter inside an existing list means
    // "next item" when the marker type matches. Replace the current item with
    // two siblings instead of creating a surprising nested list.
    for (let depth = $from.depth - 1; depth > 0; depth -= 1) {
      if ($from.node(depth).type !== state.schema.nodes.list_item) continue
      const listItem = $from.node(depth)
      const containingList = $from.node(depth - 1)
      if (
        containingList.type === block.type
        && listItem.childCount === 1
        && $from.index(depth) === 0
      ) {
        const itemBefore = state.schema.nodes.list_item.create(listItem.attrs, textblockBefore)
        const itemAfter = state.schema.nodes.list_item.create(
          null,
          state.schema.nodes.paragraph.create()
        )
        const replaceFrom = $from.before(depth)
        const tr = state.tr.replaceWith(
          replaceFrom,
          $from.after(depth),
          Fragment.fromArray([itemBefore, itemAfter])
        )
        return tr.setSelection(TextSelection.create(
          tr.doc,
          replaceFrom + itemBefore.nodeSize + 2
        ))
      }
      break
    }

    const replaceFrom = $from.before()
    const tr = state.tr.replaceWith(
      replaceFrom,
      $from.after(),
      Fragment.fromArray([textblockBefore, block])
    )

    const insertedBlockFrom = replaceFrom + textblockBefore.nodeSize
    let selectionPosition: number | null = null
    tr.doc.nodesBetween(
      insertedBlockFrom,
      insertedBlockFrom + block.nodeSize,
      (node, pos) => {
        if (selectionPosition === null && node.isTextblock) selectionPosition = pos + 1
      }
    )
    if (selectionPosition !== null) {
      tr.setSelection(TextSelection.create(tr.doc, selectionPosition))
    }
    return tr
  })
}

function markdownClipboardSlice(text: string): Slice {
  const doc = parseComposerMarkdown(text.replace(/\r\n?/g, '\n'))
  const onlyChild = doc.childCount === 1 ? doc.firstChild : null
  // A single ordinary paragraph should paste inline at the caret. Markdown
  // blocks (headings, lists, quotes, multiple paragraphs) retain their block
  // structure and split the surrounding paragraph as needed.
  return onlyChild?.type === markdownSchema.nodes.paragraph
    ? new Slice(onlyChild.content, 0, 0)
    : new Slice(doc.content, 0, 0)
}

function boundaryDelimitedMarkInputRule(
  regexp: RegExp,
  markType: MarkType,
  contentGroup: number,
  boundaryGroup: number
): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    const content = match[contentGroup]
    const boundary = match[boundaryGroup]
    if (!content || !boundary) return null
    const tr = state.tr
      .replaceWith(start, end, state.schema.text(content, [markType.create()]))
      .insertText(boundary, start + content.length)
      .removeStoredMark(markType)
    return tr
  })
}

function codeFenceCommand(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type !== state.schema.nodes.paragraph) return false
  const match = /^```([\w+-]*)$/.exec($from.parent.textContent)
  if (!match) return false
  if (dispatch) {
    const from = $from.before()
    const to = $from.after()
    dispatch(
      state.tr
        .setBlockType(from, to, state.schema.nodes.code_block, { params: match[1] ?? '' })
        .delete($from.start(), $from.end())
        .scrollIntoView()
    )
  }
  return true
}

const insertSoftBreak: Command = (state, dispatch) => {
  const softBreak = state.schema.nodes.soft_break
  if (!softBreak) return false
  if (dispatch) {
    const tr = state.tr.deleteSelection()
    const insertionStart = tr.selection.from
    tr
      .insert(insertionStart, Fragment.fromArray([
        softBreak.create(),
        state.schema.text(CARET_SENTINEL),
      ]))
      .setSelection(TextSelection.create(tr.doc, insertionStart + 2))
    dispatch(tr.scrollIntoView())
  }
  return true
}

/** A heading cannot hold a line break, so Shift+Enter there starts a new line like Enter. */
const splitHeading: Command = (state, dispatch) =>
  state.selection.$from.parent.type === state.schema.nodes.heading && splitBlock(state, dispatch)

const removeTrailingSoftBreak: Command = (state, dispatch) => {
  if (!state.selection.empty) return false
  const { from, $from } = state.selection
  const before = $from.nodeBefore
  if (!before?.isText || before.text !== CARET_SENTINEL || from < 2) return false
  const $beforeSentinel = state.doc.resolve(from - CARET_SENTINEL.length)
  if ($beforeSentinel.nodeBefore?.type !== state.schema.nodes.soft_break) return false
  if (dispatch) dispatch(state.tr.delete(from - 2, from).scrollIntoView())
  return true
}

/** Replaces the code block at `pos` with a paragraph, keeping each code line as a line break, and puts the cursor at its start. */
function codeBlockToText(tr: Transaction, pos: number, block: ProseMirrorNode): Transaction {
  const { schema } = block.type
  // setBlockType would collapse the lines into spaces. Paragraphs drop leading whitespace on re-read.
  const lines = block.textContent.replace(/\n+$/, '').split('\n').map((line) => line.replace(/^[ \t]+/, ''))
  const content = lines.flatMap((line, i) => [...(i > 0 ? [schema.nodes.soft_break.create()] : []), ...(line ? [schema.text(line)] : [])])
  tr.replaceWith(pos, pos + block.nodeSize, schema.nodes.paragraph.create(null, content))
  return tr.setSelection(TextSelection.create(tr.doc, pos + 1))
}

/** Enter on an empty last line leaves a code block; in an empty block, it turns it into text. */
const exitCodeBlockOnEmptyLine: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  const block = $from.parent
  if (!empty || !block.type.spec.code || $from.parentOffset !== block.content.size) return false
  const text = block.textContent
  const blank = /^\n*$/.test(text)
  if (!blank && !text.endsWith('\n')) return false
  if (!dispatch) return true
  if (blank) {
    dispatch(codeBlockToText(state.tr, $from.before(), block).scrollIntoView())
    return true
  }
  const { paragraph } = state.schema.nodes
  const tr = state.tr.delete($from.pos - 1, $from.pos)
  const after = $from.after() - 1
  if (tr.doc.resolve(after).nodeAfter?.type !== paragraph) tr.insert(after, paragraph.create())
  dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView())
  return true
}

/** Turns the block kind at the selection start into plain text across the selection: headings, code blocks, or one level of list items or quotes. */
const removeBlockFormatting: Command = withTextSelection((state, dispatch) => {
  const { nodes } = state.schema
  const { $from } = state.selection
  if ($from.parent.type === nodes.heading) {
    if (dispatch) {
      const tr = state.tr
      for (const { node, pos } of selectedTextblocks(state)) if (node.type === nodes.heading) tr.setNodeMarkup(pos, nodes.paragraph)
      dispatch(tr.scrollIntoView())
    }
    return true
  }
  if ($from.parent.type.spec.code) {
    if (dispatch) {
      const tr = state.tr
      const blocks = selectedTextblocks(state)
      for (const { node, pos } of [...blocks].reverse()) if (node.type.spec.code) codeBlockToText(tr, pos, node)
      // Keep a range selected so the next shortcut acts on every converted block.
      if (!state.selection.empty) tr.setSelection(TextSelection.between(tr.doc.resolve(blocks[0].pos + 1), tr.doc.resolve(tr.mapping.map(state.selection.to))))
      dispatch(tr.scrollIntoView())
    }
    return true
  }
  if ($from.depth === 0) return false
  const container = $from.node(-1).type
  if (container === nodes.list_item) return liftListItem(nodes.list_item)(state, dispatch)
  if (container === nodes.blockquote) return lift(state, dispatch)
  return false
})

/** Backspace at the start of a heading or code block, or of a quote's or list item's first paragraph, turns it into plain text. */
const removeFormattingAtBlockStart: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset !== 0) return false
  const { heading } = state.schema.nodes
  if ($from.parent.type !== heading && !$from.parent.type.spec.code && $from.index(-1) !== 0) return false
  return removeBlockFormatting(state, dispatch)
}

type Format = { label: string; shortcut?: string } & (
  | { kind: 'block'; isActive: (state: EditorState) => boolean; apply: Command; remove?: Command }
  | { kind: 'mark'; mark: MarkType }
)

/** A select-all as the block commands need it: a text selection over every block. */
function asTextSelection(state: EditorState): EditorState {
  const { selection } = state
  return selection instanceof AllSelection ? state.apply(state.tr.setSelection(TextSelection.between(selection.$from, selection.$to))) : state
}

/** A select-all starts at the document, not in a block, so block commands see it as a text selection over every block. */
function withTextSelection(command: Command): Command {
  return (state, dispatch, view) => {
    if (!(state.selection instanceof AllSelection)) return command(state, dispatch, view)
    return command(asTextSelection(state), dispatch && ((tr) => dispatch(tr.setSelection(new AllSelection(tr.doc)))), view)
  }
}

/** A shortcut or toolbar button makes the text that format, and pressing it again returns it to plain text. */
function toggle(format: Format): Command {
  if (format.kind === 'mark') return toggleMark(format.mark)
  const remove = format.remove ?? removeBlockFormatting
  return withTextSelection((state, dispatch) =>
    format.isActive(state) ? remove(state, dispatch) : format.apply(state, dispatch))
}

function isFormatActive(format: Format, state: EditorState): boolean {
  if (format.kind === 'block') return format.isActive(state)
  const { from, to, empty, $from } = state.selection
  return empty ? !!format.mark.isInSet(state.storedMarks ?? $from.marks()) : state.doc.rangeHasMark(from, to, format.mark)
}

function selectedTextblocks(state: EditorState): Array<{ node: ProseMirrorNode; pos: number }> {
  const blocks: Array<{ node: ProseMirrorNode; pos: number }> = []
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
    if (node.isTextblock) blocks.push({ node, pos })
  })
  return blocks
}

/** A textblock's text with each soft or hard break as a newline. */
function blockText(node: ProseMirrorNode): string {
  const { soft_break, hard_break } = node.type.schema.nodes
  return node.textBetween(0, node.content.size, '', (leaf) => (leaf.type === soft_break || leaf.type === hard_break ? '\n' : ''))
}

function enclosingList($pos: ResolvedPos): { node: ProseMirrorNode; pos: number } | null {
  const { bullet_list, ordered_list } = $pos.doc.type.schema.nodes
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth)
    if (node.type === bullet_list || node.type === ordered_list) return { node, pos: $pos.before(depth) }
  }
  return null
}

function headingFormat(level: number, shortcut: string): Format {
  const { heading } = markdownSchema.nodes
  return {
    kind: 'block',
    label: `Heading ${level}`,
    shortcut,
    isActive: (state) => {
      const blocks = selectedTextblocks(state)
      return blocks.length > 0 && blocks.every(({ node }) => node.type === heading && node.attrs.level === level)
    },
    apply: (state, dispatch) => {
      const blocks = selectedTextblocks(state)
      if (!blocks.some(({ node }) => blockText(node).includes('\n'))) return setBlockType(heading, { level })(state, dispatch)
      // A heading holds one line, so it takes the selected line out of a multi-line paragraph; merging lines would lose them.
      const { $from, $to } = state.selection
      const block = blocks[0].node
      if (blocks.length > 1 || block.type.spec.code || blockText(state.doc.cut($from.pos, $to.pos)).includes('\n')) return false
      if (!dispatch) return true
      const tr = state.tr
      let before = -1
      let after = -1
      block.forEach((child, offset) => {
        if (child.type.name !== 'soft_break' && child.type.name !== 'hard_break') return
        const pos = $from.start() + offset
        if (pos < $from.pos) before = pos
        else if (after === -1) after = pos
      })
      // Later position first, so the earlier one stays valid.
      if (after !== -1) tr.delete(after, after + 1).split(after)
      if (before !== -1) tr.delete(before, before + 1).split(before)
      // Removing the break and splitting there moves the line's start one position later.
      const shift = before === -1 ? 0 : 1
      tr.setBlockType($from.pos + shift, $from.pos + shift, heading, { level })
      dispatch(tr.setSelection(TextSelection.create(tr.doc, state.selection.anchor + shift, state.selection.head + shift)).scrollIntoView())
      return true
    },
  }
}

function listFormat(listType: NodeType, label: string, shortcut: string): Format {
  return {
    kind: 'block',
    label,
    shortcut,
    isActive: (state) => enclosingList(state.selection.$from)?.node.type === listType,
    remove: liftListItem(markdownSchema.nodes.list_item),
    apply: (state, dispatch) => {
      const list = enclosingList(state.selection.$from)
      if (!list) return wrapInList(listType, { tight: true })(state, dispatch)
      if (dispatch) dispatch(state.tr.setNodeMarkup(list.pos, listType, { tight: list.node.attrs.tight }).scrollIntoView())
      return true
    },
  }
}

/** Turns each selected textblock into a code block, keeping its line breaks as code lines. */
const textblocksToCode: Command = (state, dispatch) => {
  const blocks = selectedTextblocks(state)
  // Code holds plain text, so an image, or a link whose text hides its URL, would be lost. An <autolink> shows its address.
  const { image } = state.schema.nodes
  const { link } = state.schema.marks
  const losesContent = (child: ProseMirrorNode) =>
    child.type === image || child.marks.some((mark) => mark.type === link && mark.attrs.href !== child.text && mark.attrs.href !== `mailto:${child.text}`)
  if (!blocks.length || blocks.some(({ node }) => node.content.content.some(losesContent))) return false
  if (!dispatch) return true
  const { soft_break, hard_break, code_block } = state.schema.nodes
  const tr = state.tr
  const last = blocks[blocks.length - 1]
  // Selected lines side by side become one code block, as fencing them with ``` would; an existing code block keeps its own fence.
  const $first = state.doc.resolve(blocks[0].pos)
  const $last = state.doc.resolve(last.pos)
  const adjacent = blocks.every(({ pos }) => state.doc.resolve(pos).parent === $first.parent) && $last.index() - $first.index() === blocks.length - 1
  if (blocks.length > 1 && adjacent && !blocks.some(({ node }) => node.type.spec.code)) {
    const text = blocks.map(({ node }) => blockText(node).replaceAll(CARET_SENTINEL, '')).join('\n')
    tr.replaceWith(blocks[0].pos, last.pos + last.node.nodeSize, code_block.create(null, text ? state.schema.text(text) : null))
    // Caret at the end, so typing next cannot replace lines that were not selected.
    dispatch(tr.setSelection(TextSelection.create(tr.doc, blocks[0].pos + 1 + text.length)).scrollIntoView())
    return true
  }
  state.doc.nodesBetween(blocks[0].pos, last.pos + last.node.nodeSize, (node, pos) => {
    if (node.type === soft_break || node.type === hard_break) {
      tr.replaceWith(tr.mapping.map(pos), tr.mapping.map(pos + 1), state.schema.text('\n'))
    }
    // A caret sentinel after a line break would sit after the last code line and block the Enter exit.
    const sentinel = node.text?.indexOf(CARET_SENTINEL) ?? -1
    if (sentinel !== -1) tr.delete(tr.mapping.map(pos + sentinel), tr.mapping.map(pos + sentinel + 1))
  })
  // Passing the existing attrs keeps an already-code block's language tag.
  dispatch(tr.setBlockType(tr.selection.from, tr.selection.to, code_block, (node) => node.attrs).scrollIntoView())
  return true
}

const NORMAL_TEXT_SHORTCUT = 'Mod-Alt-0'
const { nodes: formatNodes, marks: formatMarks } = markdownSchema
const formats = {
  bold: { kind: 'mark', label: 'Bold', mark: formatMarks.strong, shortcut: 'Mod-b' },
  italic: { kind: 'mark', label: 'Italic', mark: formatMarks.em, shortcut: 'Mod-i' },
  strike: { kind: 'mark', label: 'Strikethrough', mark: formatMarks.strike, shortcut: 'Mod-Shift-s' },
  code: { kind: 'mark', label: 'Inline code', mark: formatMarks.code, shortcut: 'Mod-e' },
  heading1: headingFormat(1, 'Mod-Alt-1'),
  heading2: headingFormat(2, 'Mod-Alt-2'),
  heading3: headingFormat(3, 'Mod-Alt-3'),
  bulletList: listFormat(formatNodes.bullet_list, 'Bullet list', 'Mod-Shift-8'),
  orderedList: listFormat(formatNodes.ordered_list, 'Numbered list', 'Mod-Shift-7'),
  quote: {
    kind: 'block',
    label: 'Quote',
    // Only a block sitting directly in a quote, which is what lifting it out undoes.
    isActive: (state) => state.selection.$from.depth > 0 && state.selection.$from.node(-1).type === formatNodes.blockquote,
    apply: wrapIn(formatNodes.blockquote),
    remove: lift,
  },
  codeBlock: { kind: 'block', label: 'Code block', shortcut: 'Mod-Alt-8', isActive: (state) => !!state.selection.$from.parent.type.spec.code, apply: textblocksToCode },
} satisfies Record<string, Format>

const formatEntries: [string, Format][] = Object.entries(formats)
const formatsByName = new Map(formatEntries)
const toolbarFormats = formatEntries.map(([name, format]) => ({ name, label: format.label, shortcut: format.shortcut }))

/** What the toolbar shows for `state`: which formats apply at the cursor and which can apply. */
function formatStatus(editorState: EditorState): FormatStatus {
  const state = asTextSelection(editorState)
  return {
    active: formatEntries.filter(([, format]) => isFormatActive(format, state)).map(([name]) => name),
    enabled: [
      ...formatEntries.filter(([, format]) => toggle(format)(state)).map(([name]) => name),
      ...(state.selection.$from.parent.type === formatNodes.heading ? ['text'] : []),
    ],
  }
}

/** Backspace on an empty paragraph below a list joins it into the text above instead of adding an item. */
const returnUpFromEmptyLine: Command = (state, dispatch, view) => {
  const { $from } = state.selection
  if ($from.parent.type !== state.schema.nodes.paragraph || $from.parent.content.size > 0) return false
  const before = $from.node(-1).maybeChild($from.index(-1) - 1)
  if (!before || before.isTextblock) return false
  return joinTextblockBackward(state, dispatch, view)
}

function buildCaretSentinelPlugin(): Plugin {
  return new Plugin({
    appendTransaction: (transactions, _oldState, newState) => {
      if (!transactions.some((transaction) => transaction.docChanged)) return null
      const stalePositions: number[] = []
      newState.doc.descendants((node, pos, parent, index) => {
        if (!node.isText || !node.text || !parent) return
        let offset = node.text.indexOf(CARET_SENTINEL)
        while (offset !== -1) {
          const hasFollowingContent = offset < node.text.length - 1 || index < parent.childCount - 1
          if (hasFollowingContent) stalePositions.push(pos + offset)
          offset = node.text.indexOf(CARET_SENTINEL, offset + CARET_SENTINEL.length)
        }
      })
      if (stalePositions.length === 0) return null
      const tr = newState.tr.setMeta('addToHistory', false)
      for (const position of stalePositions.reverse()) {
        tr.delete(position, position + CARET_SENTINEL.length)
      }
      return tr
    },
  })
}

function buildInputRules() {
  const { nodes, marks } = markdownSchema
  return inputRules({
    rules: [
      blockAfterSoftBreakInputRule(/\ufffc\s*>\s$/, () =>
        nodes.blockquote.create(null, nodes.paragraph.create())
      ),
      blockAfterSoftBreakInputRule(/\ufffc\s*([-+*])\s$/, () =>
        nodes.bullet_list.create(
          { tight: true },
          nodes.list_item.create(null, nodes.paragraph.create())
        )
      ),
      blockAfterSoftBreakInputRule(/\ufffc\s*(\d+)\.\s$/, (match) =>
        nodes.ordered_list.create(
          { order: Number(match[1]), tight: true },
          nodes.list_item.create(null, nodes.paragraph.create())
        )
      ),
      blockAfterSoftBreakInputRule(/\ufffc\s*(#{1,6})\s$/, (match) =>
        nodes.heading.create({ level: match[1].length })
      ),
      wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
      wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list),
      wrappingInputRule(
        /^(\d+)\.\s$/,
        nodes.ordered_list,
        (match) => ({ order: Number(match[1]), tight: true }),
        (match, node) => node.childCount + node.attrs.order === Number(match[1])
      ),
      textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, (match) => ({ level: match[1].length })),
      horizontalRuleInputRule(),
      imageInputRule(),
      linkInputRule(marks.link),
      delimitedMarkInputRule(/(\*\*)([^*\n](?:.*?[^*\n])?)\1$/, marks.strong, 1, 2),
      boundaryDelimitedMarkInputRule(
        /(?<![\w_])__([^_\n]+)__([^\w_])$/,
        marks.strong,
        1,
        2
      ),
      delimitedMarkInputRule(/(~~)([^~\n](?:.*?[^~\n])?)\1$/, marks.strike, 1, 2),
      delimitedMarkInputRule(/(`)([^`\n]+)\1$/, marks.code, 1, 2),
      delimitedMarkInputRule(/(?<!\*)(\*)([^*\n]+)\1$/, marks.em, 1, 2),
      boundaryDelimitedMarkInputRule(
        /(?<![\w_])_([^_\n]+)_([^\w_])$/,
        marks.em,
        1,
        2
      ),
    ],
  })
}

function buildKeymap() {
  const { nodes } = markdownSchema
  return keymap({
    Backspace: chainCommands(removeTrailingSoftBreak, undoInputRule, removeFormattingAtBlockStart, returnUpFromEmptyLine),
    Enter: chainCommands(codeFenceCommand, exitCodeBlockOnEmptyLine, newlineInCode, splitListItem(nodes.list_item)),
    'Shift-Enter': chainCommands(newlineInCode, splitHeading, insertSoftBreak),
    Tab: sinkListItem(nodes.list_item),
    'Shift-Tab': liftListItem(nodes.list_item),
    ...Object.fromEntries(formatEntries.flatMap(([, format]) => (format.shortcut ? [[format.shortcut, toggle(format)]] : []))),
    'Mod-`': toggle(formats.code),
    [NORMAL_TEXT_SHORTCUT]: removeBlockFormatting,
    'Mod-z': undo,
    'Shift-Mod-z': redo,
    'Mod-y': redo,
    'Mod-Enter': exitCode,
  })
}

interface SecretMatch {
  kind: 'potential' | 'secured'
  from: number
  to: number
  id: string
  secret?: SecuredSecret
}

function findSecretMatches(
  doc: ProseMirrorNode,
  potentialSecrets: PotentialSecret[],
  securedSecrets: SecuredSecret[]
): SecretMatch[] {
  const matches: SecretMatch[] = []
  const occupied: Array<{ from: number; to: number }> = []

  const findText = (
    needle: string,
    create: (from: number, to: number) => SecretMatch
  ) => {
    if (!needle) return
    doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return
      let fromIndex = 0
      let index = node.text.indexOf(needle, fromIndex)
      while (index !== -1) {
        const from = pos + index
        const to = from + needle.length
        if (!occupied.some((range) => from < range.to && to > range.from)) {
          matches.push(create(from, to))
          occupied.push({ from, to })
          return
        }
        fromIndex = index + needle.length
        index = node.text.indexOf(needle, fromIndex)
      }
    })
  }

  for (const candidate of potentialSecrets) {
    findText(candidate.value, (from, to) => ({
      kind: 'potential',
      from,
      to,
      id: candidate.id,
    }))
  }
  for (const secret of securedSecrets) {
    findText(secret.displayText, (from, to) => ({
      kind: 'secured',
      from,
      to,
      id: secret.id,
      secret,
    }))
  }

  return matches.sort((a, b) => a.from - b.from)
}

function buildSecretDecorations(
  doc: ProseMirrorNode,
  potentialSecrets: PotentialSecret[],
  securedSecrets: SecuredSecret[]
): DecorationSet {
  const decorations = findSecretMatches(doc, potentialSecrets, securedSecrets).map((match) =>
    Decoration.inline(match.from, match.to, {
      'data-testid': match.kind === 'potential' ? 'potential-secret' : 'secured-secret',
      class: match.kind === 'potential'
        ? 'rounded-[3px] outline outline-1 outline-dotted outline-amber-500/90'
        : 'rounded-[3px] bg-amber-500/10 outline outline-1 outline-amber-500/70',
    })
  )
  return DecorationSet.create(doc, decorations)
}

const secretDecorationsKey = new PluginKey<DecorationSet>('composer-secret-decorations')
const secretDecorationsMeta = 'composer-secret-decorations:update'
const editorViews = new WeakMap<HTMLElement, EditorView>()

/** Programmatic selection for composer integrations that insert text and tests
 * that need to exercise editing at an exact document position. Positions use
 * ProseMirror's document coordinate space. */
export function setMarkdownComposerSelection(
  element: HTMLElement,
  from: number,
  to = from
): boolean {
  const view = editorViews.get(element)
  if (!view) return false
  const max = view.state.doc.content.size
  const selection = TextSelection.create(
    view.state.doc,
    Math.min(Math.max(from, 0), max),
    Math.min(Math.max(to, 0), max)
  )
  view.dispatch(view.state.tr.setSelection(selection))
  view.focus()
  return true
}

export function selectAllMarkdownComposer(element: HTMLElement): boolean {
  const view = editorViews.get(element)
  if (!view) return false
  view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)))
  view.focus()
  return true
}

function buildSecretDecorationsPlugin(
  getSecrets: () => { potential: PotentialSecret[]; secured: SecuredSecret[] }
): Plugin<DecorationSet> {
  return new Plugin({
    key: secretDecorationsKey,
    state: {
      init: (_config, state) => {
        const { potential, secured } = getSecrets()
        return buildSecretDecorations(state.doc, potential, secured)
      },
      apply: (tr, previous) => {
        if (tr.docChanged || tr.getMeta(secretDecorationsMeta)) {
          const { potential, secured } = getSecrets()
          return buildSecretDecorations(tr.doc, potential, secured)
        }
        return previous.map(tr.mapping, tr.doc)
      },
    },
    props: {
      decorations: (state) => secretDecorationsKey.getState(state),
    },
  })
}

function setEditorA11yState(view: EditorView, placeholder: string, disabled: boolean) {
  const isEmpty = view.state.doc.childCount === 1
    && view.state.doc.firstChild?.type.name === 'paragraph'
    && view.state.doc.firstChild.content.size === 0
  view.dom.dataset.empty = String(isEmpty)
  view.dom.dataset.placeholder = placeholder
  view.dom.setAttribute('aria-label', placeholder)
  view.dom.setAttribute('aria-disabled', String(disabled))
  view.dom.setAttribute('placeholder', placeholder)
}

function isStructuredBlock(view: EditorView): boolean {
  const { $from } = view.state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name
    if (name === 'list_item' || name === 'blockquote' || name === 'code_block') return true
  }
  return false
}

export function MarkdownComposerEditor({
  value,
  onChange,
  onKeyDown,
  placeholder,
  disabled = false,
  autoFocus = false,
  dataTestId,
  minRows = 2,
  enterKeyHint,
  className,
  potentialSecrets = [],
  securedSecrets = [],
  onRemoveSecuredSecrets,
  onEditorElement,
  toolbar = false,
  toolbarClassName,
}: MarkdownComposerEditorProps) {
  const managedClassName = cn(
    'markdown-composer-editor relative min-h-[var(--composer-min-height)] w-full overflow-y-auto rounded-md bg-transparent pl-1 pr-4 py-0 text-sm leading-5 focus-visible:outline-none',
    className
  )
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const managedClassNameRef = useRef(managedClassName)
  const latestRef = useRef({
    onChange,
    onKeyDown,
    value,
    placeholder,
    disabled,
    potentialSecrets,
    securedSecrets,
    onRemoveSecuredSecrets,
    toolbar,
  })
  const lastMarkdownRef = useRef(value)
  const [status, setStatus] = useState<FormatStatus | null>(null)
  const statusKeyRef = useRef('')
  // Re-render the toolbar only when what it shows changes, not on every keystroke.
  const publishStatus = (state: EditorState) => {
    const next = formatStatus(state)
    const key = `${next.active.join()}|${next.enabled.join()}`
    if (key === statusKeyRef.current) return
    statusKeyRef.current = key
    setStatus(next)
  }
  const runCommand = (command: Command) => {
    const view = viewRef.current
    if (!view) return
    command(view.state, view.dispatch)
    view.focus()
  }

  latestRef.current = {
    onChange,
    onKeyDown,
    value,
    placeholder,
    disabled,
    potentialSecrets,
    securedSecrets,
    onRemoveSecuredSecrets,
    toolbar,
  }

  useLayoutEffect(() => {
    if (!hostRef.current) return

    const secretPlugin = buildSecretDecorationsPlugin(() => ({
      potential: latestRef.current.potentialSecrets,
      secured: latestRef.current.securedSecrets,
    }))
    const initialDoc = parseComposerMarkdown(lastMarkdownRef.current)
    const state = EditorState.create({
      schema: markdownSchema,
      doc: initialDoc,
      selection: TextSelection.atEnd(initialDoc),
      plugins: [
        buildInputRules(),
        buildKeymap(),
        keymap(baseKeymap),
        history(),
        buildCaretSentinelPlugin(),
        secretPlugin,
        // Runs after every state change, including the controlled-value reset, so pressed buttons never go stale.
        new Plugin({ view: () => ({ update: (view) => { if (latestRef.current.toolbar) publishStatus(view.state) } }) }),
      ],
    })

    const view = new EditorView(hostRef.current, {
      state,
      editable: () => !latestRef.current.disabled,
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        dir: 'auto',
        placeholder,
        spellcheck: 'true',
        ...(dataTestId ? { 'data-testid': dataTestId } : {}),
        ...(enterKeyHint ? { enterkeyhint: enterKeyHint } : {}),
        // Keep the row-based default as a variable-backed utility so callers'
        // explicit min-height classes can win through tailwind-merge. An inline
        // min-height would override the agent-home expand/collapse classes.
        style: `--composer-min-height: ${Math.max(1, minRows) * 20}px`,
        class: managedClassNameRef.current,
      },
      handleDOMEvents: {
        mousedown: () => typeof document.elementFromPoint !== 'function',
        keydown: (editorView, event) => {
          if (event.isComposing) return false

          // Cmd/Ctrl+B belongs to the rich-text editor. Keep it from reaching
          // window-level shortcuts (notably the sidebar toggle) without
          // preventing ProseMirror's strong-mark keymap from handling it.
          if (event.key === 'b' && (event.metaKey || event.ctrlKey)) {
            event.stopPropagation()
          }

          if ((event.key === 'Backspace' || event.key === 'Delete') && latestRef.current.onRemoveSecuredSecrets) {
            const { from, to, empty } = editorView.state.selection
            const matches = findSecretMatches(
              editorView.state.doc,
              latestRef.current.potentialSecrets,
              latestRef.current.securedSecrets
            ).filter((match) => match.kind === 'secured' && match.secret)
            const affected = matches.filter((match) => {
              if (!empty) return match.from < to && match.to > from
              return event.key === 'Backspace'
                ? match.from < from && match.to >= from
                : match.from <= from && match.to > from
            })

            if (affected.length > 0) {
              event.preventDefault()
              const tr = editorView.state.tr
              if (empty) {
                for (const match of [...affected].sort((a, b) => b.from - a.from)) {
                  tr.delete(match.from, match.to)
                }
              } else {
                tr.deleteSelection()
              }
              editorView.dispatch(tr.scrollIntoView())
              latestRef.current.onRemoveSecuredSecrets(
                affected.flatMap((match) => match.secret ? [match.secret] : [])
              )
              return true
            }
          }

          const isUnmodifiedEnter = event.key === 'Enter'
            && !event.shiftKey
            && !event.metaKey
            && !event.ctrlKey
            && !event.altKey
          if (isUnmodifiedEnter && codeFenceCommand(
            editorView.state,
            (tr) => editorView.dispatch(tr)
          )) {
            event.preventDefault()
            return true
          }

          // In a structured Markdown block, Enter belongs to the editor (new list
          // item, quote line, or code line). Everywhere else the owning composer
          // keeps its existing Enter-to-send behavior.
          if (!(isUnmodifiedEnter && isStructuredBlock(editorView))) {
            latestRef.current.onKeyDown?.(event, editorView)
          }
          return event.defaultPrevented
        },
      },
      // ProseMirror should scroll the caret in real browsers. JSDOM has no layout
      // and throws while measuring DOM Ranges, so only tests claim the scroll.
      ...(typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)
        ? { handleScrollToSelection: () => true }
        : {}),
      dispatchTransaction: (tr) => {
        const nextState = view.state.apply(tr)
        view.updateState(nextState)
        setEditorA11yState(view, latestRef.current.placeholder, latestRef.current.disabled)
        if (!tr.docChanged) return
        const markdown = serializeComposerMarkdown(
          nextState.doc,
          latestRef.current.securedSecrets
        )
        lastMarkdownRef.current = markdown
        if (markdown !== latestRef.current.value) latestRef.current.onChange(markdown)
      },
      handlePaste: (editorView, event) => {
        const hasFiles = Array.from(event.clipboardData?.items ?? [])
          .some((item) => item.kind === 'file')
        if (hasFiles) {
          // Stop ProseMirror from also inserting text/plain, but keep bubbling so
          // the owning composer can add the file attachment.
          event.preventDefault()
          return true
        }
        const text = event.clipboardData?.getData('text/plain')
        if (!text) return false
        event.preventDefault()
        editorView.dispatch(
          editorView.state.tr
            .replaceSelection(markdownClipboardSlice(text))
            .scrollIntoView()
        )
        return true
      },
    })

    viewRef.current = view
    editorViews.set(view.dom, view)
    setEditorA11yState(view, latestRef.current.placeholder, latestRef.current.disabled)
    onEditorElement?.(view.dom as HTMLDivElement)
    if (autoFocus) requestAnimationFrame(() => view.focus())

    return () => {
      onEditorElement?.(null)
      editorViews.delete(view.dom)
      viewRef.current = null
      view.destroy()
    }
  // The editor is intentionally created once. Controlled props are read through
  // latestRef and synchronized by the effects below, preserving selection/history.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view || value === lastMarkdownRef.current) return
    const nextDoc = parseComposerMarkdown(value)
    const tr = view.state.tr
      .replaceWith(0, view.state.doc.content.size, nextDoc.content)
      .setMeta('addToHistory', false)
    tr.setSelection(TextSelection.atEnd(tr.doc))
    view.updateState(view.state.apply(tr))
    lastMarkdownRef.current = value
    setEditorA11yState(view, placeholder, disabled)
  }, [disabled, placeholder, value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.setProps({ editable: () => !disabled })
    setEditorA11yState(view, placeholder, disabled)
  }, [disabled, placeholder])

  useEffect(() => {
    const view = viewRef.current
    if (!view || managedClassName === managedClassNameRef.current) return
    const wasFocused = view.dom.classList.contains('ProseMirror-focused')
    view.dom.className = `ProseMirror ${managedClassName}${wasFocused ? ' ProseMirror-focused' : ''}`
    managedClassNameRef.current = managedClassName
  }, [managedClassName])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch(view.state.tr.setMeta(secretDecorationsMeta, true).setMeta('addToHistory', false))
  }, [potentialSecrets, securedSecrets])

  // Before paint, so the toolbar appears with the editor instead of a frame later.
  useLayoutEffect(() => {
    if (toolbar) {
      viewRef.current?.dispatch(viewRef.current.state.tr)
    } else {
      statusKeyRef.current = ''
      setStatus(null)
    }
  }, [toolbar])

  return (
    <>
      {toolbar && status && (
        <FormattingToolbar
          formats={toolbarFormats}
          status={status}
          disabled={disabled}
          className={toolbarClassName}
          onFormat={(name) => {
            const format = formatsByName.get(name)
            if (format) runCommand(toggle(format))
          }}
          normalTextShortcut={NORMAL_TEXT_SHORTCUT}
          onNormalText={() => runCommand(removeBlockFormatting)}
          onMenuClose={() => viewRef.current?.focus()}
        />
      )}
      <div ref={hostRef} className="contents" />
    </>
  )
}
