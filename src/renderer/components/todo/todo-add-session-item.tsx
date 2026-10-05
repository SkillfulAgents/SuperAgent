import { ListTodo } from 'lucide-react'
import { toast } from 'sonner'
import { TODO_TITLE_MAX } from '@shared/lib/todos/todo-schema'
import { ContextMenuItem } from '@renderer/components/ui/context-menu'
import { useAddSessionTodo } from '@renderer/hooks/use-todos'
import { useSessionTodo } from './todo-session-chrome'

/** The session menu's "Add to Todo", for a session not on the board yet. Hidden without the experiment. */
export function AddSessionToTodoItem({ agentSlug, sessionId, sessionName }: { agentSlug: string; sessionId: string; sessionName: string }) {
  const { todo, enabled } = useSessionTodo(agentSlug, sessionId)
  const addSessionTodo = useAddSessionTodo()
  if (!enabled || todo) return null

  const add = () => {
    const title = sessionName.trim().slice(0, TODO_TITLE_MAX) || 'Untitled session'
    addSessionTodo.mutate(
      { agentSlug, sessionId, title },
      { onSuccess: () => toast.success('Added to Todo') },
    )
  }

  return (
    <ContextMenuItem onClick={add} disabled={addSessionTodo.isPending} data-testid="add-session-to-todo-item">
      <ListTodo className="h-4 w-4 mr-2" />
      Add to Todo
    </ContextMenuItem>
  )
}
