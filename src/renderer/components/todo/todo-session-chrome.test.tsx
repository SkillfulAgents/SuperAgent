// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from '@renderer/test/test-utils'
import type { TodoView } from '@shared/lib/todos/todo-schema'

const state = vi.hoisted(() => ({
  experimentOn: true,
  todos: [] as TodoView[],
  navigate: vi.fn(),
  setStatus: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => state.navigate,
}))
vi.mock('@renderer/hooks/use-experiment', () => ({ useExperiment: () => state.experimentOn }))
vi.mock('@renderer/hooks/use-todos', () => ({
  useTodos: () => ({ data: state.todos }),
  useStartTodo: () => ({ mutate: vi.fn() }),
  useSetTodoStatus: () => ({ mutate: state.setStatus }),
}))

import { TodoSessionBack, TodoSessionControls, todoQueue } from './todo-session-chrome'

let clock = 1_000
function todo(id: string, column: TodoView['column']): TodoView {
  clock += 1_000
  return {
    id,
    title: id,
    description: '',
    agentSlug: 'analyst',
    sessionId: `session-${id}`,
    status: column === 'done' ? 'done' : 'active',
    column,
    position: clock,
    starting: false,
    createdAt: clock,
    updatedAt: clock,
    startedAt: clock,
    completedAt: null,
    ask: null,
  }
}

function renderChrome(sessionId: string) {
  return renderWithProviders(
    <div>
      <TodoSessionBack agentSlug="analyst" sessionId={sessionId} />
      <TodoSessionControls agentSlug="analyst" sessionId={sessionId} />
    </div>,
  )
}

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

beforeEach(() => {
  state.experimentOn = true
  state.navigate.mockReset()
  state.setStatus.mockReset()
  // Highest position last: the queue lists input first, then updates, each in board order.
  state.todos = [
    todo('updates-old', 'has_updates'),
    todo('input-old', 'needs_input'),
    todo('working', 'working'),
    todo('input-new', 'needs_input'),
    todo('finished', 'done'),
  ]
})

describe('todoQueue', () => {
  it('lists what needs input before what has updates, each in board order', () => {
    expect(todoQueue(state.todos).map((t) => t.id)).toEqual(['input-new', 'input-old', 'updates-old'])
  })
})

describe('the Todo chrome in a session header', () => {
  it('is absent for a session that is not on the board', () => {
    renderChrome('session-elsewhere')
    expect(screen.queryByTestId('todo-session-back')).toBeNull()
    expect(screen.queryByTestId('todo-session-controls')).toBeNull()
  })

  it('is absent with the experiment off', () => {
    state.experimentOn = false
    renderChrome('session-input-old')
    expect(screen.queryByTestId('todo-session-back')).toBeNull()
  })

  it('goes back to the board', () => {
    renderChrome('session-input-old')
    fireEvent.click(screen.getByTestId('todo-session-back'))
    expect(state.navigate).toHaveBeenCalledWith({ to: '/todo' })
  })

  it('shows where the item sits in the queue and steps through it', () => {
    renderChrome('session-input-old')
    expect(screen.getByTestId('todo-session-position')).toHaveTextContent('2 / 3')

    fireEvent.click(screen.getByTestId('todo-session-next'))
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: '/agents/$slug/sessions/$sessionId',
      params: { slug: 'analyst', sessionId: 'session-updates-old' },
    })
    fireEvent.click(screen.getByTestId('todo-session-prev'))
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: '/agents/$slug/sessions/$sessionId',
      params: { slug: 'analyst', sessionId: 'session-input-new' },
    })
  })

  it('from an item outside the queue, down enters it at the top', () => {
    renderChrome('session-working')
    expect(screen.getByTestId('todo-session-position')).toHaveTextContent('3 waiting')
    expect(screen.getByTestId('todo-session-prev')).toBeDisabled()
    press('j')
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: '/agents/$slug/sessions/$sessionId',
      params: { slug: 'analyst', sessionId: 'session-input-new' },
    })
  })

  it('marks the item done, by button or by D', () => {
    renderChrome('session-working')
    fireEvent.click(screen.getByTestId('todo-action-done'))
    press('d')
    expect(state.setStatus).toHaveBeenCalledTimes(2)
    expect(state.setStatus).toHaveBeenCalledWith({ id: 'working', status: 'done' })
  })

  it('archives a finished item', () => {
    renderChrome('session-finished')
    fireEvent.click(screen.getByTestId('todo-action-archive'))
    expect(state.setStatus).toHaveBeenCalledWith({ id: 'finished', status: 'archived' })
  })

  it('Esc goes back, but not while a dialog has the keyboard', () => {
    renderChrome('session-input-old')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    press('Escape')
    expect(state.navigate).not.toHaveBeenCalled()
    dialog.remove()
    press('Escape')
    expect(state.navigate).toHaveBeenCalledWith({ to: '/todo' })
  })
})
