import { canonicalWorkspacePath } from '@shared/lib/utils/workspace-path'

/**
 * What a finished tool call may have written in the agent's workspace: one file,
 * or `'any'` for tools that run arbitrary code and can touch anything. Null means
 * the tool cannot write files, so nothing showing a workspace file needs to look
 * again.
 *
 * Paths come back in one spelling, absolute under `/workspace`, whatever form the
 * tool was given. A path outside the workspace is null: no preview can be showing it.
 */
export type WorkspaceWrite = string | 'any'

const PATH_FIELD_BY_TOOL: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

const CODE_RUNNING_TOOLS = new Set(['Bash', 'Task', 'Agent', 'Workflow', 'Skill'])

/** `rawInput` is the tool's streamed JSON input, parsed only for tools that name a file. */
export function workspaceWriteOf(toolName: string, rawInput: string): WorkspaceWrite | null {
  if (CODE_RUNNING_TOOLS.has(toolName)) return 'any'
  const field = PATH_FIELD_BY_TOOL[toolName]
  if (!field) return null
  let input: unknown
  try {
    input = JSON.parse(rawInput)
  } catch {
    return null
  }
  if (typeof input !== 'object' || input === null) return null
  const path: unknown = Reflect.get(input, field)
  if (typeof path !== 'string') return null
  const relative = canonicalWorkspacePath(path)
  return relative === null ? null : `/workspace/${relative}`
}
