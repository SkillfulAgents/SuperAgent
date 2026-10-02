// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import type { TodoView } from '@shared/lib/todos/todo-schema'

const state = vi.hoisted(() => ({
  todos: [] as TodoView[],
  navigate: vi.fn(),
  setStatus: vi.fn(),
  start: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => state.navigate,
}))
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => ({ data: [{ slug: 'analyst', name: 'Analyst' }] }),
}))
vi.mock('@renderer/hooks/use-todos', () => ({
  useTodos: () => ({ data: state.todos, isPending: false, error: null }),
  useStartingTodoIds: () => new Set<string>(),
  useStartTodo: () => ({ mutate: state.start }),
  useSetTodoStatus: () => ({ mutate: state.setStatus }),
  useCreateTodo: () => ({ mutateAsync: vi.fn() }),
  useUpdateTodo: () => ({ mutateAsync: vi.fn() }),
  useDeleteTodo: () => ({ mutate: vi.fn() }),
}))

import { TodoBoard } from './todo-board'

function todo(partial: Partial<TodoView> & Pick<TodoView, 'id' | 'column'>): TodoView {
  const status = partial.column === 'drafts' ? 'draft' : partial.column === 'done' ? 'done' : partial.column === 'archived' ? 'archived' : 'active'
  return {
    title: `Task ${partial.id}`,
    description: '',
    agentSlug: 'analyst',
    sessionId: status === 'draft' ? null : `session-${partial.id}`,
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    completedAt: null,
    ...partial,
  }
}

beforeEach(() => {
  state.todos = []
  state.navigate.mockReset()
  state.setStatus.mockReset()
  state.start.mockReset()
})

describe('TodoBoard', () => {
  it('puts each item in its column', () => {
    state.todos = [
      todo({ id: 'a', column: 'drafts' }),
      todo({ id: 'b', column: 'working' }),
      todo({ id: 'c', column: 'needs_input' }),
      todo({ id: 'd', column: 'has_updates' }),
    ]
    renderWithProviders(<TodoBoard />)
    expect(within(screen.getByTestId('todo-column-drafts')).getByText('Task a')).toBeInTheDocument()
    expect(within(screen.getByTestId('todo-column-working')).getByText('Task b')).toBeInTheDocument()
    expect(within(screen.getByTestId('todo-column-needs_input')).getByText('Task c')).toBeInTheDocument()
    expect(within(screen.getByTestId('todo-column-has_updates')).getByText('Task d')).toBeInTheDocument()
  })

  it('names an untitled item from its description', () => {
    state.todos = [todo({ id: 'a', column: 'drafts', title: '', description: 'Look into churn. It spiked.' })]
    renderWithProviders(<TodoBoard />)
    expect(screen.getByText('Look into churn')).toBeInTheDocument()
  })

  it('opens started work in its session', () => {
    state.todos = [todo({ id: 'b', column: 'needs_input' })]
    renderWithProviders(<TodoBoard />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Task b' }))
    expect(state.navigate).toHaveBeenCalledWith({
      to: '/agents/$slug/sessions/$sessionId',
      params: { slug: 'analyst', sessionId: 'session-b' },
    })
  })

  it('opens a draft in the draft dialog', () => {
    state.todos = [todo({ id: 'a', column: 'drafts', description: 'The brief' })]
    renderWithProviders(<TodoBoard />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Task a' }))
    expect(screen.getByTestId('todo-draft-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('todo-draft-title')).toHaveValue('Task a')
    expect(state.navigate).not.toHaveBeenCalled()
  })

  it('marks work done and archives what is done', () => {
    state.todos = [todo({ id: 'b', column: 'has_updates' })]
    const { unmount } = renderWithProviders(<TodoBoard />)
    fireEvent.click(screen.getByTestId('todo-action-done'))
    expect(state.setStatus).toHaveBeenCalledWith({ id: 'b', status: 'done' }, expect.anything())
    unmount()

    state.todos = [todo({ id: 'e', column: 'done' })]
    renderWithProviders(<TodoBoard />)
    fireEvent.click(screen.getByRole('button', { name: 'Show Done, 1 items' }))
    fireEvent.click(screen.getByTestId('todo-action-archive'))
    expect(state.setStatus).toHaveBeenCalledWith({ id: 'e', status: 'archived' }, expect.anything())
  })

  it('starts a draft that has an agent from its card', () => {
    state.todos = [todo({ id: 'a', column: 'drafts' })]
    renderWithProviders(<TodoBoard />)
    fireEvent.click(screen.getByTestId('todo-action-start'))
    expect(state.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', agentSlug: 'analyst' }), expect.anything())
  })

  it('opens a draft with no agent instead of starting it', () => {
    state.todos = [todo({ id: 'a', column: 'drafts', agentSlug: null })]
    renderWithProviders(<TodoBoard />)
    fireEvent.click(screen.getByTestId('todo-action-start'))
    expect(state.start).not.toHaveBeenCalled()
    expect(screen.getByTestId('todo-draft-dialog')).toBeInTheDocument()
  })
})
