export function isBlockingUserInputToolName(toolName: unknown): boolean {
  return toolName === 'AskUserQuestion' ||
    (typeof toolName === 'string' &&
      toolName.startsWith('mcp__user-input__request_') &&
      toolName !== 'mcp__user-input__request_script_run')
}
