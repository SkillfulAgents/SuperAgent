import { useEffect, useLayoutEffect, useRef } from 'react'
import MarkdownIt from 'markdown-it'
import { baseKeymap, chainCommands, exitCode, newlineInCode, toggleMark } from 'prosemirror-commands'
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
import { Fragment, Schema, Slice, type MarkType, type Node as ProseMirrorNode } from 'prosemirror-model'
import {
  liftListItem,
  sinkListItem,
  splitListItem,
} from 'prosemirror-schema-list'
import { AllSelection, EditorState, Plugin, PluginKey, TextSelection, type Command, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view'
import 'prosemirror-view/style/prosemirror.css'
import { cn } from '@shared/lib/utils'
import type { PotentialSecret, SecuredSecret } from '@renderer/lib/secret-detection'

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

const markdownTokenizer = new MarkdownIt('commonmark', {
  html: false,
  linkify: true,
}).enable('strikethrough')

const markdownParser = new MarkdownParser(markdownSchema, markdownTokenizer, {
  ...defaultMarkdownParser.tokens,
  softbreak: { node: 'soft_break' },
  s: { mark: 'strike' },
})

const markdownSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    soft_break: (state) => state.write('\n'),
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
  const { nodes, marks } = markdownSchema
  return keymap({
    Backspace: chainCommands(removeTrailingSoftBreak, undoInputRule),
    Enter: chainCommands(codeFenceCommand, splitListItem(nodes.list_item)),
    'Shift-Enter': chainCommands(newlineInCode, insertSoftBreak),
    Tab: sinkListItem(nodes.list_item),
    'Shift-Tab': liftListItem(nodes.list_item),
    'Mod-b': toggleMark(marks.strong),
    'Mod-i': toggleMark(marks.em),
    'Mod-`': toggleMark(marks.code),
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
}: MarkdownComposerEditorProps) {
  const managedClassName = cn(
    'markdown-composer-editor relative w-full overflow-y-auto rounded-md bg-transparent pl-1 pr-4 py-0 text-sm leading-5 focus-visible:outline-none',
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
  })
  const lastMarkdownRef = useRef(value)

  latestRef.current = {
    onChange,
    onKeyDown,
    value,
    placeholder,
    disabled,
    potentialSecrets,
    securedSecrets,
    onRemoveSecuredSecrets,
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
        style: `min-height: ${Math.max(1, minRows) * 20}px`,
        class: managedClassNameRef.current,
      },
      handleDOMEvents: {
        mousedown: () => typeof document.elementFromPoint !== 'function',
        keydown: (editorView, event) => {
          if (event.isComposing) return false

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

  return <div ref={hostRef} className="contents" />
}
