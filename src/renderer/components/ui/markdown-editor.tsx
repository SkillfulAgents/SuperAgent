import { useRef } from 'react'
import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx, serializerCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { clipboard } from '@milkdown/kit/plugin/clipboard'
import { Plugin } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { cn } from '@shared/lib/utils/cn'

interface MarkdownEditorProps {
  /** Read once on mount; remount (e.g. via `key`) to load a new value. */
  value: string
  onChange?: (value: string) => void
  readOnly?: boolean
  className?: string
}

function MilkdownEditor({ value, onChange, readOnly }: Omit<MarkdownEditorProps, 'className'>) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEditor((root) => {
    // Synchronous, unlike plugin-listener's debounce, which drops the last edit on unmount.
    // Fires only on real document edits, so viewing never re-serializes the source.
    const changeReporter = $prose(
      (ctx) =>
        new Plugin({
          view: () => ({
            update: (view, prevState) => {
              if (view.state.doc.eq(prevState.doc)) return
              onChangeRef.current?.(ctx.get(serializerCtx)(view.state.doc))
            },
          }),
        })
    )
    return Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        ctx.set(defaultValueCtx, value)
        ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => !readOnly }))
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(clipboard)
      .use(changeReporter)
  }, [readOnly])

  return <Milkdown />
}

export function MarkdownEditor({ className, ...props }: MarkdownEditorProps) {
  return (
    <div
      className={cn(
        'prose prose-sm max-w-none break-words dark:prose-invert',
        '[&_.ProseMirror]:min-h-full [&_.ProseMirror]:whitespace-pre-wrap [&_.ProseMirror]:outline-none',
        className
      )}
      data-testid="markdown-editor"
    >
      <MilkdownProvider>
        <MilkdownEditor {...props} />
      </MilkdownProvider>
    </div>
  )
}
