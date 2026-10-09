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
  update: vi.fn(),
  start: vi.fn(),
  rename: vi.fn(),
  starting: new Set<string>(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => state.navigate,
}))
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => ({ data: [{ slug: 'analyst', name: 'Analyst' }, { slug: 'ops', name: 'Ops' }] }),
}))
vi.mock('@renderer/hooks/use-user-settings', () => ({ useUserSettings: () => ({ data: undefined }) }))
vi.mock('@renderer/hooks/use-todos', () => ({
  useTodos: () => ({ data: state.todos, isPending: false, error: null }),
  useStartingTodoIds: () => state.starting,
  useStartTodo: () => ({ mutate: state.start }),
  useSetTodoStatus: () => ({ mutate: state.setStatus }),
  useMoveTodo: () => ({ mutate: state.move }),
  useCreateTodo: () => ({ mutateAsync: vi.fn() }),
  useUpdateTodo: () => ({ mutateAsync: state.update }),
  useDeleteTodo: () => ({ mutate: vi.fn() }),
  useRenameTodo: () => ({ mutateAsync: state.rename, isPending: false }),
}))

import { TodoBoard } from './todo-board'

function todo(partial: Partial<TodoView> & Pick<TodoView, 'id' | 'column'>): TodoView {
  const status = partial.column === 'drafts' ? 'draft' : partial.column === 'done' ? 'done' : partial.column === 'archived' ? 'archived' : 'active'
  return {
    title: `Task ${partial.id}`,
    description: '',
    agentSlug: 'analyst',
    newAgent: false,
    model: null,
    llmProviderId: null,
    effort: null,
    speed: null,
    sessionId: status === 'draft' ? null : `session-${partial.id}`,
    status,
    position: 0,
    starting: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    completedAt: null,
    ask: null,
    pendingWakeAt: null,
    ...partial,
  }
}

beforeEach(() => {
  state.todos = []
  state.navigate.mockReset()
  state.setStatus.mockReset()
  state.move.mockReset()
  state.update.mockReset()
  state.start.mockReset()
  state.rename.mockReset().mockResolvedValue(undefined)
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
    const needsYou = within(screen.getByTestId('todo-column-needs_you'))
    expect(needsYou.getAllByTestId('todo-card').map((card) => card.dataset.todoId)).toEqual(['c', 'd'])
  })

  it('lists blocked work above work with updates, and says which is which', () => {
    state.todos = [
      todo({ id: 'u', column: 'has_updates', position: 9 }),
      todo({ id: 'q', column: 'needs_input', position: 1, ask: 'answer' }),
    ]
    renderWithProviders(<TodoBoard />)
    const needsYou = within(screen.getByTestId('todo-column-needs_you'))
    expect(needsYou.getAllByTestId('todo-card').map((card) => card.dataset.todoId)).toEqual(['q', 'u'])
    expect(needsYou.getByTestId('todo-card-ask')).toHaveTextContent('Needs answer')
    expect(needsYou.getByTestId('todo-card-updates')).toHaveTextContent('Has updates')
  })

  it('says how long work that is asleep until a scheduled wake will wait, in gray', () => {
    state.todos = [
      todo({ id: 'w', column: 'has_updates', pendingWakeAt: Date.now() + 3 * 60 * 60_000 + 60_000 }),
      todo({ id: 'u', column: 'has_updates' }),
    ]
    renderWithProviders(<TodoBoard />)
    const waiting = within(screen.getByTestId('todo-card-waiting').closest('[data-testid="todo-card"]') as HTMLElement)
    expect(waiting.getByTestId('todo-card-waiting')).toHaveTextContent('Waiting for 3 hours')
    expect(waiting.getByTestId('todo-card-waiting')).toHaveClass('bg-muted')
    expect(waiting.queryByTestId('todo-card-updates')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('todo-card-updates')).toHaveLength(1)
  })

  it('shows the working orb by the agent of work in flight only', () => {
    state.todos = [todo({ id: 'b', column: 'working' }), todo({ id: 'd', column: 'has_updates' })]
    renderWithProviders(<TodoBoard />)
    expect(within(screen.getByTestId('todo-column-working')).getByTestId('todo-card-orb')).toBeInTheDocument()
    expect(within(screen.getByTestId('todo-column-needs_you')).queryByTestId('todo-card-orb')).not.toBeInTheDocument()
  })

  it('starts a draft meant for a new agent from its card', () => {
    const draft = todo({ id: 'n', column: 'drafts', agentSlug: null, newAgent: true })
    state.todos = [draft]
    renderWithProviders(<TodoBoard />)
    expect(screen.getByTestId('todo-card')).toHaveTextContent('New Agent')
    fireEvent.click(screen.getByTestId('todo-action-start'))
    expect(state.start).toHaveBeenCalledWith(draft)
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

  it('renames started work from its right-click menu; drafts have no such menu', async () => {
    state.todos = [todo({ id: 'a', column: 'drafts' }), todo({ id: 'b', column: 'has_updates', title: 'Summarize the weekly sales numbers' })]
    renderWithProviders(<TodoBoard />)
    fireEvent.contextMenu(screen.getByText('Task a'))
    expect(screen.queryByTestId('todo-card-menu')).not.toBeInTheDocument()

    fireEvent.contextMenu(screen.getByText('Summarize the weekly sales numbers'))
    fireEvent.click(await screen.findByTestId('todo-rename-item'))
    const input = await screen.findByTestId('todo-rename-input')
    expect(input).toHaveValue('Summarize the weekly sales numbers')
    fireEvent.change(input, { target: { value: 'Weekly sales summary' } })
    fireEvent.click(screen.getByTestId('todo-rename-submit'))
    await waitFor(() => expect(state.rename).toHaveBeenCalledWith({ id: 'b', title: 'Weekly sales summary' }))
    expect(state.navigate).not.toHaveBeenCalled()
  })

  it.each(['has_updates', 'needs_input'] as const)('keeps an unsaved rename when working moves to %s', async (column) => {
    state.todos = [todo({ id: 'b', column: 'working', title: 'Quarterly report' })]
    const { rerender } = renderWithProviders(<TodoBoard />)
    fireEvent.contextMenu(screen.getByText('Quarterly report'))
    fireEvent.click(await screen.findByTestId('todo-rename-item'))
    fireEvent.change(await screen.findByTestId('todo-rename-input'), { target: { value: 'Weekly sales summary' } })

    state.todos = state.todos.map((item) => ({ ...item, column }))
    rerender(<TodoBoard />)
    expect(screen.getByTestId('todo-card')).toHaveAttribute('data-column', column)
    expect(screen.getByTestId('todo-rename-input')).toHaveValue('Weekly sales summary')
    fireEvent.click(screen.getByTestId('todo-rename-submit'))
    await waitFor(() => expect(state.rename).toHaveBeenCalledWith({ id: 'b', title: 'Weekly sales summary' }))
    await waitFor(() => expect(screen.queryByTestId('todo-rename-input')).not.toBeInTheDocument())
    expect(state.navigate).not.toHaveBeenCalled()
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

  it('an edit undone while its save is in flight is saved too', async () => {
    // B's save hangs until released; then the title goes back to A.
    let landB: () => void = () => {}
    state.update.mockImplementationOnce(() => new Promise<void>((resolve) => { landB = resolve }))
    state.update.mockResolvedValue(undefined)
    state.todos = [todo({ id: 'a', column: 'drafts', title: 'A' })]
    renderWithProviders(<TodoBoard />)
    fireEvent.click(screen.getByRole('button', { name: 'Open A' }))
    const title = screen.getByTestId('todo-draft-title')

    fireEvent.change(title, { target: { value: 'B' } })
    await waitFor(() => expect(state.update).toHaveBeenCalledWith(expect.objectContaining({ title: 'B' })), { timeout: 2_000 })
    fireEvent.change(title, { target: { value: 'A' } })
    fireEvent.click(screen.getByTestId('todo-draft-close'))
    landB()
    await waitFor(() => expect(state.update).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'A' })))
  })

  it('gives a draft to an agent by name', async () => {
    state.update.mockResolvedValue(undefined)
    state.todos = [todo({ id: 'a', column: 'drafts' })]
    renderWithProviders(<TodoBoard />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Task a' }))
    const trigger = screen.getByTestId('todo-assign-agent')
    expect(trigger).toHaveTextContent('Analyst')
    fireEvent.click(trigger)
    expect(screen.getByRole('option', { name: 'Analyst' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('option', { name: 'Ops' }))
    expect(screen.getByTestId('todo-assign-agent')).toHaveTextContent('Ops')
  })

  it('gives a draft to a new agent, and offers a model only once it has an agent', async () => {
    state.update.mockResolvedValue(undefined)
    state.todos = [todo({ id: 'n', column: 'drafts', agentSlug: null })]
    renderWithProviders(<TodoBoard />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Task n' }))
    expect(screen.queryByTestId('composer-options-trigger')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('todo-assign-agent'))
    fireEvent.click(screen.getByRole('option', { name: 'New Agent' }))
    expect(screen.getByTestId('todo-assign-agent')).toHaveTextContent('New Agent')
    expect(screen.getByTestId('composer-options-trigger')).toHaveAccessibleName(/^Model and effort/)
    await waitFor(() => expect(state.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'n', agentSlug: null, newAgent: true })))

    fireEvent.click(screen.getByTestId('todo-assign-agent'))
    fireEvent.click(screen.getByRole('option', { name: 'Ops' }))
    await waitFor(() => expect(state.update).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'n', agentSlug: 'ops', newAgent: false })))
  })

  it('saves a draft and closes with Save draft', async () => {
    state.update.mockResolvedValue(undefined)
    state.todos = [todo({ id: 'a', column: 'drafts', title: 'A' })]
    renderWithProviders(<TodoBoard />)
    fireEvent.click(screen.getByRole('button', { name: 'Open A' }))
    fireEvent.change(screen.getByTestId('todo-draft-title'), { target: { value: 'A, sharper' } })
    fireEvent.click(screen.getByTestId('todo-draft-save'))
    await waitFor(() => expect(state.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', title: 'A, sharper' })))
    await waitFor(() => expect(screen.queryByTestId('todo-draft-dialog')).not.toBeInTheDocument())
  })
})
