export interface TaskCreateInput {
  subject?: string
  description?: string
  activeForm?: string
}

export interface TaskUpdateInput {
  taskId?: string
  status?: string
}

function parseTaskCreateInput(input: unknown): TaskCreateInput {
  return typeof input === 'object' && input !== null ? (input as TaskCreateInput) : {}
}

function parseTaskUpdateInput(input: unknown): TaskUpdateInput {
  return typeof input === 'object' && input !== null ? (input as TaskUpdateInput) : {}
}

function getTaskCreateSummary(input: unknown): string | null {
  const { subject } = parseTaskCreateInput(input)
  return subject || null
}

function getTaskUpdateSummary(input: unknown): string | null {
  const { taskId, status } = parseTaskUpdateInput(input)
  if (!taskId) return null
  return `Task #${taskId} ${status || 'updated'}`
}

function getTaskListSummary(_input: unknown): string | null {
  return 'Listed tasks'
}

export const taskCreateDef = {
  displayName: 'Create Task',
  iconName: 'ListPlus',
  parseInput: parseTaskCreateInput,
  getSummary: getTaskCreateSummary,
} as const

export const taskUpdateDef = {
  displayName: 'Update Task',
  iconName: 'ListChecks',
  parseInput: parseTaskUpdateInput,
  getSummary: getTaskUpdateSummary,
} as const

export const taskListDef = {
  displayName: 'List Tasks',
  iconName: 'ListTodo',
  getSummary: getTaskListSummary,
} as const
