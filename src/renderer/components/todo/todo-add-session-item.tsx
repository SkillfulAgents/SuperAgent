import { ListTodo } from 'lucide-react'
import { toast } from 'sonner'
import { TODO_TITLE_MAX } from '@shared/lib/todos/todo-schema'
import { ContextMenuItem } from '@renderer/components/ui/context-menu'
import { useExperiment } from '@renderer/hooks/use-experiment'
import { useAddSessionTodo, useTodos } from '@renderer/hooks/use-todos'

/** The session menu's "Add to Todo", for a session not on the board yet. Hidden without the experiment. */
export function AddSessionToTodoItem({ agentSlug, sessionId, sessionName }: { agentSlug: string; sessionId: string; sessionName: string }) {
  const enabled = useExperiment('todo-board')
  const { data: todos } = useTodos()
  const todo = todos?.find((t) => t.agentSlug === agentSlug && t.sessionId === sessionId)
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
