import { useMutation, useMutationState, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { handleMutationError } from '@renderer/lib/query-client'
import type {
  AddSessionTodoInput,
  CreateTodoInput,
  TodoStatusChange,
  TodoView,
  UpdateTodoInput,
} from '@shared/lib/todos/todo-schema'
import { todoPrompt } from '@shared/lib/todos/todo-schema'
import { fromStoredSelection } from '@shared/lib/model-selection'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useCreateAgentForPrompt } from './use-create-agent-for-prompt'
import { useExperiment } from './use-experiment'
import { useCreateSession } from './use-sessions'

export type { TodoView }

import { TODOS_QUERY_KEY } from './todos-query-key'

export { TODOS_QUERY_KEY }

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

/**
 * After a failed write the board may be out of date (the item was started,
 * archived or unlinked elsewhere), so it reloads rather than keep offering
 * an action the server will refuse again.
 */
function refreshBoard(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: TODOS_QUERY_KEY })
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
 * lifecycle event; nothing here polls. Deleting a session or an agent from
 * this window refreshes it too, and coming back to the window catches up on
 * changes made elsewhere (another tab, sessions deleted automatically).
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
    refetchOnWindowFocus: true,
  })
}

export function useCreateTodo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateTodoInput) => send<TodoView>('/api/todos', 'POST', input, 'Failed to save the draft'),
    onSuccess: (todo) => putTodo(queryClient, todo),
    onError: () => refreshBoard(queryClient),
  })
}

/** Puts a session that already exists on the board; resolves with its item (the existing one if it was already there). */
export function useAddSessionTodo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: AddSessionTodoInput) => send<TodoView>('/api/todos/sessions', 'POST', input, 'Failed to add to Todo'),
    onSuccess: (todo) => putTodo(queryClient, todo),
    onError: () => refreshBoard(queryClient),
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
    onError: () => refreshBoard(queryClient),
  })
}

export function useRenameTodo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      send<TodoView>(`/api/todos/${id}/title`, 'POST', { title }, 'Failed to rename the todo'),
    onSuccess: (todo) => putTodo(queryClient, todo),
    onError: () => refreshBoard(queryClient),
  })
}

export function useSetTodoStatus() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: TodoStatusChange }) =>
      send<TodoView>(`/api/todos/${id}/status`, 'POST', { status }, 'Failed to update the todo'),
    onSuccess: (todo) => putTodo(queryClient, todo),
    onError: () => refreshBoard(queryClient),
  })
}

/**
 * Puts an item at a new place in its column. The board moves it straight
 * away; a failure puts the board back the way the server has it.
 */
export function useMoveTodo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, position }: { id: string; position: number }) =>
      send<TodoView>(`/api/todos/${id}/position`, 'POST', { position }, 'Failed to move the todo'),
    onMutate: async ({ id, position }) => {
      await queryClient.cancelQueries({ queryKey: TODOS_QUERY_KEY })
      queryClient.setQueryData<TodoView[]>(TODOS_QUERY_KEY, (current) =>
        current?.map((t) => (t.id === id ? { ...t, position } : t)))
    },
    onSuccess: (todo) => putTodo(queryClient, todo),
    onError: () => refreshBoard(queryClient),
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
    onError: () => refreshBoard(queryClient),
  })
}

const START_TODO_MUTATION_KEY = ['start-todo'] as const

/** Errors useCreateSession already toasted, so a failed start doesn't say it twice. */
const reportedBySessionCreation = new WeakSet<Error>()


/**
 * Ids of the drafts being started right now: by this tab (known at once)
 * or by another (known from the board, which reports held start claims).
 * Starting can take a while (the agent's container may have to boot
 * first), so the board shows it.
 */
export function useStartingTodoIds(): Set<string> {
  const ids = useMutationState({
    filters: { mutationKey: START_TODO_MUTATION_KEY, status: 'pending' },
    select: (mutation) => (mutation.state.variables as { id: string } | undefined)?.id,
  })
  const { data: todos } = useTodos()
  return new Set([
    ...ids.filter((id): id is string => !!id),
    ...(todos ?? []).filter((t) => t.starting).map((t) => t.id),
  ])
}

/** What starting needs to know about a draft. */
export type StartableTodo = Pick<TodoView, 'id' | 'title' | 'description' | 'agentSlug' | 'newAgent' | 'model' | 'llmProviderId' | 'effort' | 'speed'>

/**
 * Hands a draft to its agent: claims the draft on the server, creates a
 * session with the brief as its first message through the same endpoint the
 * composer uses, then links the item to that session. Resolves with the
 * started item.
 *
 * A draft for a new agent first gets one, named from its brief the same way
 * the new-agent composer names one from its first message, and is assigned
 * to it. Should the start then fail, the draft keeps that agent, so starting
 * again does not make another.
 *
 * The session runs on the draft's picked model, effort and speed, or the
 * agent's defaults for what was not picked.
 *
 * The claim is what keeps a draft to one session: a second start, from this
 * tab or another, is refused before it creates anything. The brief sent is
 * the one the claim returns, which is what the item keeps.
 *
 * Failures toast through the app's global mutation handler, like every
 * mutation here, except a failed session creation: that is its own
 * mutation and has already said so.
 */
export function useStartTodo() {
  const queryClient = useQueryClient()
  const createSession = useCreateSession()
  const createAgentForPrompt = useCreateAgentForPrompt()
  const { track } = useAnalyticsTracking()
  return useMutation({
    mutationKey: START_TODO_MUTATION_KEY,
    mutationFn: async (todo: StartableTodo) => {
      let agentSlug = todo.agentSlug
      if (!agentSlug && todo.newAgent) {
        const agent = await createAgentForPrompt(todoPrompt(todo))
        track('agent_created', { source: 'todo', num_skills_added_at_creation: 0 })
        putTodo(queryClient, await send<TodoView>(`/api/todos/${todo.id}`, 'PATCH', { agentSlug: agent.slug }, 'The agent was created, but the todo could not be given to it'))
        agentSlug = agent.slug
      }
      if (!agentSlug) throw new Error('Pick an agent to start this')
      const { claim, todo: claimed } = await send<{ claim: string; todo: TodoView }>(
        `/api/todos/${todo.id}/claim`, 'POST', {}, 'Could not start the todo',
      )
      let sessionId: string
      try {
        sessionId = (await createSession.mutateAsync({
          agentSlug: claimed.agentSlug ?? agentSlug,
          message: todoPrompt(claimed),
          ...fromStoredSelection(claimed),
        })).id
      } catch (error) {
        if (error instanceof Error) reportedBySessionCreation.add(error)
        // Nothing started: let the draft be started again.
        void apiFetch(`/api/todos/${todo.id}/release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claim }),
        }).catch(() => {})
        throw error
      }
      return send<TodoView>(`/api/todos/${todo.id}/start`, 'POST', { sessionId, claim }, 'The session started, but the todo could not be linked to it')
    },
    meta: { skipGlobalErrorToast: true },
    onSuccess: (todo) => putTodo(queryClient, todo),
    onError: (error) => {
      if (!reportedBySessionCreation.has(error)) handleMutationError(error)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: TODOS_QUERY_KEY }),
  })
}
