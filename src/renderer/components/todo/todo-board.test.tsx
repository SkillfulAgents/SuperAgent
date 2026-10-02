// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import type { TodoView } from '@shared/lib/todos/todo-schema'

const state = vi.hoisted(() => ({
  todos: [] as TodoView[],
  navigate: vi.fn(),
  setStatus: vi.fn(),
  move: vi.fn(),
  start: vi.fn(),
  starting: new Set<string>(),
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
  useStartingTodoIds: () => state.starting,
  useStartTodo: () => ({ mutate: state.start }),
  useSetTodoStatus: () => ({ mutate: state.setStatus }),
  useMoveTodo: () => ({ mutate: state.move }),
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
    position: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    completedAt: null,
    ask: null,
    ...partial,
  }
}

beforeEach(() => {
  state.todos = []
  state.navigate.mockReset()
  state.setStatus.mockReset()
  state.move.mockReset()
  state.start.mockReset()
  state.starting = new Set()
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

  it('labels what a Needs input card is waiting for', () => {
    state.todos = [
      todo({ id: 'q', column: 'needs_input', ask: 'answer' }),
      todo({ id: 'p', column: 'needs_input', ask: 'permission' }),
      todo({ id: 'r', column: 'needs_input', ask: 'reconnect' }),
    ]
    renderWithProviders(<TodoBoard />)
    expect(screen.getAllByTestId('todo-card-ask').map((pill) => pill.textContent)).toEqual(
      expect.arrayContaining(['Needs answer', 'Permission', 'Reconnect']),
    )
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
    expect(state.setStatus).toHaveBeenCalledWith({ id: 'b', status: 'done' })
    unmount()

    state.todos = [todo({ id: 'e', column: 'done' })]
    renderWithProviders(<TodoBoard />)
    fireEvent.click(screen.getByRole('button', { name: 'Show Done, 1 items' }))
    fireEvent.click(screen.getByTestId('todo-action-archive'))
    expect(state.setStatus).toHaveBeenCalledWith({ id: 'e', status: 'archived' })
  })

  it('starts a draft that has an agent from its card', () => {
    state.todos = [todo({ id: 'a', column: 'drafts' })]
    renderWithProviders(<TodoBoard />)
    fireEvent.click(screen.getByTestId('todo-action-start'))
    expect(state.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', agentSlug: 'analyst' }))
  })

  it('opens a draft with no agent instead of starting it', () => {
    state.todos = [todo({ id: 'a', column: 'drafts', agentSlug: null })]
    renderWithProviders(<TodoBoard />)
    fireEvent.click(screen.getByTestId('todo-action-start'))
    expect(state.start).not.toHaveBeenCalled()
    expect(screen.getByTestId('todo-draft-dialog')).toBeInTheDocument()
  })

  it('does not open a draft while it is starting', () => {
    state.todos = [todo({ id: 'a', column: 'drafts' })]
    state.starting = new Set(['a'])
    renderWithProviders(<TodoBoard />)
    expect(screen.queryByRole('button', { name: 'Open Task a' })).not.toBeInTheDocument()
    fireEvent.mouseEnter(screen.getByTestId('todo-card'))
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(screen.queryByTestId('todo-draft-dialog')).not.toBeInTheDocument()
  })

  it('walks the keyboard into Archived when that is what Done shows', () => {
    state.todos = [
      todo({ id: 'd', column: 'has_updates' }),
      todo({ id: 'e', column: 'done' }),
      todo({ id: 'z', column: 'archived' }),
    ]
    renderWithProviders(<TodoBoard />)
    const show = screen.queryByRole('button', { name: /^Show Done/ })
    if (show) fireEvent.click(show)
    fireEvent.click(screen.getByTestId('todo-archive-tab'))

    fireEvent.mouseEnter(document.querySelector('[data-todo-id="d"]')!)
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(document.querySelector('[data-todo-id="z"]')).toHaveAttribute('data-selected', 'true')
  })

  it('orders each column as it was arranged, not by when it changed', () => {
    state.todos = [
      todo({ id: 'low', column: 'drafts', position: 1, updatedAt: 9_000 }),
      todo({ id: 'high', column: 'drafts', position: 2, updatedAt: 1_000 }),
    ]
    renderWithProviders(<TodoBoard />)
    const ids = within(screen.getByTestId('todo-column-drafts')).getAllByTestId('todo-card').map((card) => card.dataset.todoId)
    expect(ids).toEqual(['high', 'low'])
  })

  it('archives a selected draft with E', () => {
    state.todos = [todo({ id: 'a', column: 'drafts' })]
    renderWithProviders(<TodoBoard />)
    fireEvent.mouseEnter(screen.getByTestId('todo-card'))
    fireEvent.keyDown(window, { key: 'e' })
    expect(state.setStatus).toHaveBeenCalledWith({ id: 'a', status: 'archived' })
  })

  it('unarchives a draft to Drafts and started work to Done', () => {
    state.todos = [
      todo({ id: 'never', column: 'archived', startedAt: null, sessionId: null }),
      todo({ id: 'ran', column: 'archived', startedAt: 1_000 }),
    ]
    renderWithProviders(<TodoBoard />)
    const show = screen.queryByRole('button', { name: /^Show Done/ })
    if (show) fireEvent.click(show)
    fireEvent.click(screen.getByTestId('todo-archive-tab'))

    const card = (id: string) => document.querySelector(`[data-todo-id="${id}"]`) as HTMLElement
    expect(within(card('never')).getByText(/^Draft, archived/)).toBeInTheDocument()
    fireEvent.click(within(card('never')).getByTestId('todo-action-unarchive'))
    expect(state.setStatus).toHaveBeenCalledWith({ id: 'never', status: 'draft' })
    fireEvent.mouseEnter(card('ran'))
    fireEvent.keyDown(window, { key: 'u' })
    expect(state.setStatus).toHaveBeenCalledWith({ id: 'ran', status: 'done' })
  })

  it('archives a draft from its dialog', async () => {
    state.todos = [todo({ id: 'a', column: 'drafts', description: 'The brief' })]
    renderWithProviders(<TodoBoard />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Task a' }))
    fireEvent.click(screen.getByTestId('todo-draft-archive'))
    await waitFor(() => expect(state.setStatus).toHaveBeenCalledWith({ id: 'a', status: 'archived' }))
    expect(screen.queryByTestId('todo-draft-dialog')).not.toBeInTheDocument()
  })
})
