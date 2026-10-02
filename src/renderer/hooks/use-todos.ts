import { useMutation, useMutationState, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import type {
  CreateTodoInput,
  TodoStatusChange,
  TodoView,
  UpdateTodoInput,
} from '@shared/lib/todos/todo-schema'
import { todoPrompt } from '@shared/lib/todos/todo-schema'
import { useExperiment } from './use-experiment'
import { useCreateSession } from './use-sessions'

export type { TodoView }

export const TODOS_QUERY_KEY = ['todos'] as const

async function readError(res: Response, fallback: string): Promise<Error> {
  const body = await res.json().catch(() => null) as { error?: string } | null
  return new Error(body?.error || fallback)
}

async function send<T>(path: string, method: string, body: unknown, fallback: string): Promise<T> {
  const res = await apiFetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await readError(res, fallback)
  return res.json() as Promise<T>
}

/** Replace one item in the cached board, or add it when it is new. */
function putTodo(queryClient: QueryClient, todo: TodoView) {
  queryClient.setQueryData<TodoView[]>(TODOS_QUERY_KEY, (current) => {
    if (!current) return current
    return current.some((t) => t.id === todo.id)
      ? current.map((t) => (t.id === todo.id ? todo : t))
      : [todo, ...current]
  })
}

/**
 * The person's Todo board. Each active item's column is live session state,
 * so the global notification handler invalidates this on every session
 * lifecycle event; nothing here polls.
 */
export function useTodos() {
  const enabled = useExperiment('todo-board')
  return useQuery<TodoView[]>({
    queryKey: TODOS_QUERY_KEY,
    queryFn: async () => {
      const res = await apiFetch('/api/todos')
      if (!res.ok) throw await readError(res, 'Failed to load todos')
      return ((await res.json()) as { todos: TodoView[] }).todos
    },
    enabled,
  })
}

export function useCreateTodo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateTodoInput) => send<TodoView>('/api/todos', 'POST', input, 'Failed to save the draft'),
    onSuccess: (todo) => putTodo(queryClient, todo),
  })
}

export function useUpdateTodo() {
  const queryClient = useQueryClient()
  return useMutation({
    // Draft edits arrive one after another as the person types; keep them in order.
    scope: { id: 'todo-draft-edits' },
    mutationFn: ({ id, ...patch }: UpdateTodoInput & { id: string }) =>
      send<TodoView>(`/api/todos/${id}`, 'PATCH', patch, 'Failed to save the draft'),
    onSuccess: (todo) => putTodo(queryClient, todo),
  })
}

export function useSetTodoStatus() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: TodoStatusChange }) =>
      send<TodoView>(`/api/todos/${id}/status`, 'POST', { status }, 'Failed to update the todo'),
    onSuccess: (todo) => putTodo(queryClient, todo),
  })
}

export function useDeleteTodo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await apiFetch(`/api/todos/${id}`, { method: 'DELETE' })
      if (!res.ok) throw await readError(res, 'Failed to delete the draft')
      return id
    },
    onSuccess: (id) => {
      queryClient.setQueryData<TodoView[]>(TODOS_QUERY_KEY, (current) => current?.filter((t) => t.id !== id))
    },
  })
}

const START_TODO_MUTATION_KEY = ['start-todo'] as const

/**
 * Ids of the drafts being started right now, from any component. Starting
 * can take a while (the agent's container may have to boot first), so the
 * board shows it.
 */
export function useStartingTodoIds(): Set<string> {
  const ids = useMutationState({
    filters: { mutationKey: START_TODO_MUTATION_KEY, status: 'pending' },
    select: (mutation) => (mutation.state.variables as { id: string } | undefined)?.id,
  })
  return new Set(ids.filter((id): id is string => !!id))
}

/**
 * Hands a draft to its agent: a new session with the brief as its first
 * message, through the same endpoint the composer uses, then the link from
 * the item to that session. Resolves with the started item.
 */
export function useStartTodo() {
  const queryClient = useQueryClient()
  const createSession = useCreateSession()
  return useMutation({
    mutationKey: START_TODO_MUTATION_KEY,
    mutationFn: async (todo: Pick<TodoView, 'id' | 'title' | 'description' | 'agentSlug'>) => {
      if (!todo.agentSlug) throw new Error('Pick an agent to start this')
      const session = await createSession.mutateAsync({ agentSlug: todo.agentSlug, message: todoPrompt(todo) })
      return send<TodoView>(`/api/todos/${todo.id}/start`, 'POST', { sessionId: session.id }, 'The session started, but the todo could not be linked to it')
    },
    onSuccess: (todo) => putTodo(queryClient, todo),
    onSettled: () => queryClient.invalidateQueries({ queryKey: TODOS_QUERY_KEY }),
  })
}
