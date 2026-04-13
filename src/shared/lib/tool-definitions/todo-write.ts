export interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

export interface TodoWriteInput {
  todos?: Todo[]
}

function parseInput(input: unknown): TodoWriteInput {
  return typeof input === 'object' && input !== null ? (input as TodoWriteInput) : {}
}

function getSummary(input: unknown): string | null {
  const { todos } = parseInput(input)
  if (!todos || !Array.isArray(todos)) return null
  return `Updated ${todos.length} todo item${todos.length !== 1 ? 's' : ''}`
}

export const todoWriteDef = { displayName: 'Todo List', iconName: 'ListTodo', parseInput, getSummary } as const
