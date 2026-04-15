import { describe, it, expect } from 'vitest'
import { formatToolName } from './types'
import { getToolDefinition, getRegisteredDefinitionNames } from './registry'
import { getRegisteredRendererNames } from '@renderer/components/messages/tool-renderers'
import { cronToHuman } from './schedule-task'

// ── formatToolName ───────────────────────────────────────────────────

describe('formatToolName', () => {
  it('formats mcp tool names', () => {
    expect(formatToolName('mcp__granola__list_meetings')).toBe('Granola MCP: List Meetings')
  })

  it('handles hyphenated server names', () => {
    expect(formatToolName('mcp__user-input__request_secret')).toBe('User Input MCP: Request Secret')
  })

  it('handles camelCase tool names', () => {
    expect(formatToolName('mcp__ide__getDiagnostics')).toBe('Ide MCP: Get Diagnostics')
  })

  it('returns non-mcp names unchanged', () => {
    expect(formatToolName('Bash')).toBe('Bash')
    expect(formatToolName('Read')).toBe('Read')
  })
})

// ── cronToHuman ──────────────────────────────────────────────────────

describe('cronToHuman', () => {
  it('handles common presets', () => {
    expect(cronToHuman('* * * * *')).toBe('Every minute')
    expect(cronToHuman('0 * * * *')).toBe('Every hour')
    expect(cronToHuman('0 0 * * *')).toBe('Daily at midnight')
    expect(cronToHuman('0 0 * * 0')).toBe('Weekly on Sunday')
    expect(cronToHuman('0 0 1 * *')).toBe('Monthly on the 1st')
  })

  it('handles */N minute intervals', () => {
    expect(cronToHuman('*/5 * * * *')).toBe('Every 5 minutes')
    expect(cronToHuman('*/15 * * * *')).toBe('Every 15 minutes')
    expect(cronToHuman('*/30 * * * *')).toBe('Every 30 minutes')
  })

  it('handles */N hour intervals', () => {
    expect(cronToHuman('0 */2 * * *')).toBe('Every 2 hours')
    expect(cronToHuman('0 */6 * * *')).toBe('Every 6 hours')
  })

  it('handles specific daily times', () => {
    expect(cronToHuman('0 9 * * *')).toBe('Daily at 9:00 AM')
    expect(cronToHuman('30 14 * * *')).toBe('Daily at 2:30 PM')
    expect(cronToHuman('0 0 * * *')).toBe('Daily at midnight') // caught by preset
    expect(cronToHuman('0 12 * * *')).toBe('Daily at 12:00 PM')
    expect(cronToHuman('15 23 * * *')).toBe('Daily at 11:15 PM')
  })

  it('handles weekday/weekend schedules', () => {
    expect(cronToHuman('0 9 * * 1-5')).toBe('Weekdays at 9:00 AM')
    expect(cronToHuman('0 10 * * 0,6')).toBe('Weekends at 10:00 AM')
  })

  it('returns raw expression for unrecognized patterns', () => {
    expect(cronToHuman('0 9 1,15 * *')).toBe('0 9 1,15 * *')
    expect(cronToHuman('invalid')).toBe('invalid')
  })

  it('handles expressions with extra whitespace', () => {
    expect(cronToHuman('  0  9  *  *  *  ')).toBe('Daily at 9:00 AM')
  })
})

// ── getSummary (via registry) ────────────────────────────────────────

describe('tool definition getSummary', () => {
  function summary(toolName: string, input: Record<string, unknown>): string | null {
    return getToolDefinition(toolName)?.getSummary(input) ?? null
  }

  describe('AskUserQuestion', () => {
    it('returns first question text', () => {
      expect(summary('AskUserQuestion', { questions: [{ question: 'What color?' }] })).toBe('What color?')
    })

    it('truncates long questions at 50 chars', () => {
      const long = 'A'.repeat(60)
      expect(summary('AskUserQuestion', { questions: [{ question: long }] })).toBe('A'.repeat(47) + '...')
    })

    it('appends count for multiple questions', () => {
      expect(summary('AskUserQuestion', {
        questions: [{ question: 'First?' }, { question: 'Second?' }, { question: 'Third?' }],
      })).toBe('First? (+ 2 more)')
    })

    it('returns null for empty/missing questions', () => {
      expect(summary('AskUserQuestion', { questions: [] })).toBeNull()
      expect(summary('AskUserQuestion', {})).toBeNull()
    })
  })

  describe('request_secret', () => {
    it('returns secretName', () => {
      expect(summary('mcp__user-input__request_secret', { secretName: 'GITHUB_TOKEN' })).toBe('GITHUB_TOKEN')
    })
    it('returns null when missing', () => {
      expect(summary('mcp__user-input__request_secret', {})).toBeNull()
    })
  })

  describe('request_file', () => {
    it('returns description', () => {
      expect(summary('mcp__user-input__request_file', { description: 'Upload CSV' })).toBe('Upload CSV')
    })
    it('returns null when missing', () => {
      expect(summary('mcp__user-input__request_file', {})).toBeNull()
    })
  })

  describe('deliver_file', () => {
    it('returns filename from path', () => {
      expect(summary('mcp__user-input__deliver_file', { filePath: '/workspace/output/report.pdf' })).toBe('report.pdf')
    })
    it('returns null when missing', () => {
      expect(summary('mcp__user-input__deliver_file', {})).toBeNull()
    })
  })

  describe('request_connected_account', () => {
    it('returns something for a toolkit', () => {
      expect(summary('mcp__user-input__request_connected_account', { toolkit: 'github' })).toBeTruthy()
    })
    it('returns null when missing', () => {
      expect(summary('mcp__user-input__request_connected_account', {})).toBeNull()
    })
  })

  describe('request_remote_mcp', () => {
    it('prefers name over url', () => {
      expect(summary('mcp__user-input__request_remote_mcp', { name: 'My Server', url: 'https://x.com' })).toBe('My Server')
    })
    it('falls back to url', () => {
      expect(summary('mcp__user-input__request_remote_mcp', { url: 'https://x.com' })).toBe('https://x.com')
    })
    it('returns null when both missing', () => {
      expect(summary('mcp__user-input__request_remote_mcp', {})).toBeNull()
    })
  })

  describe('request_browser_input', () => {
    it('returns message', () => {
      expect(summary('mcp__user-input__request_browser_input', { message: 'Enter code' })).toBe('Enter code')
    })
    it('truncates at 60 chars', () => {
      const long = 'C'.repeat(70)
      expect(summary('mcp__user-input__request_browser_input', { message: long })).toBe('C'.repeat(57) + '...')
    })
    it('returns null when missing', () => {
      expect(summary('mcp__user-input__request_browser_input', {})).toBeNull()
    })
  })

  describe('request_script_run', () => {
    it('returns type and explanation', () => {
      expect(summary('mcp__user-input__request_script_run', {
        scriptType: 'applescript', explanation: 'Open Safari',
      })).toBe('AppleScript: Open Safari')
    })
    it('returns null for empty input', () => {
      expect(summary('mcp__user-input__request_script_run', {})).toBeNull()
    })
  })

  describe('standard tools', () => {
    it('Bash: prefers description, falls back to command', () => {
      expect(summary('Bash', { description: 'List files' })).toBe('List files')
      expect(summary('Bash', { command: 'ls -la' })).toBe('$ ls -la')
    })
    it('Read: strips /workspace/ prefix', () => {
      expect(summary('Read', { file_path: '/workspace/src/index.ts' })).toBe('src/index.ts')
    })
    it('Write: returns path with arrow', () => {
      expect(summary('Write', { file_path: '/workspace/out.txt' })).toBe('→ out.txt')
    })
    it('Glob: returns pattern', () => {
      expect(summary('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
    })
    it('Grep: returns pattern and path', () => {
      expect(summary('Grep', { pattern: 'TODO', path: 'src/' })).toBe('/TODO/ in src/')
    })
    it('WebSearch: returns query', () => {
      expect(summary('WebSearch', { query: 'typescript generics' })).toBe('typescript generics')
    })
    it('WebFetch: returns hostname', () => {
      expect(summary('WebFetch', { url: 'https://example.com/api/v1' })).toBe('example.com/api/v1')
    })
    it('Task: returns type and description', () => {
      expect(summary('Task', { subagent_type: 'Explore', description: 'Find files' })).toBe('[Explore] Find files')
    })
    it('TodoWrite: returns count', () => {
      expect(summary('TodoWrite', { todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'completed' }] })).toBe('Updated 2 todo items')
    })
  })

  describe('unknown tools', () => {
    it('returns null via registry', () => {
      expect(summary('UnknownTool', { foo: 'bar' })).toBeNull()
    })
  })
})

// ── Registry completeness ────────────────────────────────────────────

describe('registry completeness', () => {
  const definitionNames = new Set(getRegisteredDefinitionNames())
  const rendererNames = new Set(getRegisteredRendererNames())

  it('every renderer has a matching definition', () => {
    const missingDefinitions = [...rendererNames].filter((name) => !definitionNames.has(name))
    expect(missingDefinitions).toEqual([])
  })

  it('every definition has a matching renderer (except backend-only tools)', () => {
    // Some definitions serve the backend only (e.g., chat integrations)
    // and render generically in the UI — no custom renderer needed.
    const backendOnly = new Set([
      'mcp__user-input__request_browser_input', // rendered inline in browser subagent view
    ])
    const missingRenderers = [...definitionNames].filter(
      (name) => !rendererNames.has(name) && !backendOnly.has(name)
    )
    expect(missingRenderers).toEqual([])
  })
})
