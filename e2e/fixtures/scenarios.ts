/**
 * E2E Test Scenarios
 *
 * This file provides utilities for setting up mock scenarios in E2E tests.
 * The MockContainerClient reads these scenarios when processing messages.
 */

// Note: In a real implementation, these scenarios would be registered
// with the MockContainerClient before tests run. For now, the mock client
// uses built-in default scenarios.

export const SCENARIOS = {
  // Simple text response
  SIMPLE_TEXT: 'hello',

  // Trigger a tool use response
  TOOL_USE: 'list files',
} as const

/**
 * Message patterns that trigger specific mock responses:
 *
 * - Any message: Returns a simple text response
 * - "list files": Returns a tool use response (Bash command)
 *
 * These patterns are matched case-insensitively in the MockContainerClient.
 */
export function getExpectedResponseType(message: string): 'text' | 'tool_use' {
  const lower = message.toLowerCase()
  if (lower.includes('list files')) {
    return 'tool_use'
  }
  return 'text'
}
