import { useState, type ReactNode } from 'react'
import { Pencil } from 'lucide-react'
import { TODO_TITLE_MAX, todoDisplayTitle } from '@shared/lib/todos/todo-schema'
import { Button } from '@renderer/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { useRenameTodo, type TodoView } from '@renderer/hooks/use-todos'

export function TodoCardMenu({ todo, onRename, children }: { todo: TodoView; onRename: (todo: TodoView) => void; children: ReactNode }) {
  if (todo.status === 'draft') return <>{children}</>

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56 rounded-xl p-2" data-testid="todo-card-menu">
        <ContextMenuItem data-testid="todo-rename-item" onClick={() => onRename(todo)}>
          <Pencil className="h-4 w-4 mr-2" />
          Rename
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function TodoRenameDialog({ todo, onClose }: { todo: TodoView; onClose: () => void }) {
  const [title, setTitle] = useState(() => todoDisplayTitle(todo))
  const renameTodo = useRenameTodo()

  const submit = async () => {
    const trimmed = title.trim()
    if (!trimmed || trimmed === todo.title) {
      onClose()
      return
    }
    try {
      await renameTodo.mutateAsync({ id: todo.id, title: trimmed })
      onClose()
    } catch (error) {
      console.error('Failed to rename todo:', error)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="overflow-hidden">
        <DialogHeader>
          <DialogTitle>Rename Todo</DialogTitle>
          <DialogDescription>Enter a new title for this todo.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); void submit() }}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={TODO_TITLE_MAX}
            placeholder="Todo title"
            autoFocus
            data-testid="todo-rename-input"
          />
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={renameTodo.isPending || !title.trim()} data-testid="todo-rename-submit">
              {renameTodo.isPending ? 'Renaming...' : 'Rename'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
