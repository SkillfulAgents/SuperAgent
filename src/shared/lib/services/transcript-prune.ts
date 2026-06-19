import type {
  JsonlEntry,
  JsonlMessageEntry,
  JsonlAttachmentEntry,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
} from '@shared/lib/types/agent'
import { SUMMARY_INPUT_BUDGET_TOKENS } from '../stale-session/stale-session-config'

/** Max chars of a tool result we keep as signal before eliding. */
export const TOOL_RESULT_CAP_CHARS = 500

/** Tools whose long successful output is a raw dump with no continuation value. */
const BULK_OUTPUT_TOOLS = new Set(['Read', 'Grep', 'Glob'])

export interface PrunedLine {
  kind: 'user' | 'assistant' | 'tool' | 'attachment'
  text: string
  tokens: number
}

interface ToolResultSignal {
  content: string
  isError: boolean
  stderr?: string
  interrupted?: boolean
  status?: string
}

/** Cheap character-count heuristic; 4 chars ~ 1 token. */
export function estTokens(s: string): number {
  return Math.ceil(s.length / 4)
}

function line(kind: PrunedLine['kind'], text: string): PrunedLine {
  return { kind, text, tokens: estTokens(text) }
}

export function isMessageEntry(e: JsonlEntry): e is JsonlMessageEntry {
  return e.type === 'user' || e.type === 'assistant'
}
function isAttachmentEntry(e: JsonlEntry): e is JsonlAttachmentEntry {
  return e.type === 'attachment'
}

export function textFromContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function firstLine(s: string): string {
  const nl = s.indexOf('\n')
  const head = nl === -1 ? s : s.slice(0, nl)
  return head.length > 120 ? head.slice(0, 120) + '…' : head
}

/** Compact one-line trace per tool call: `[tool] <verb> <target>`. Lossy on purpose. */
function renderToolCall(block: ToolUseBlock): string {
  const input = block.input ?? {}
  const get = (k: string): string | undefined =>
    typeof input[k] === 'string' ? (input[k] as string) : undefined
  switch (block.name) {
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return `[tool] ${block.name} ${get('file_path') ?? get('notebook_path') ?? ''}`.trimEnd()
    case 'Bash':
      return `[tool] Bash: ${firstLine(get('command') ?? '')}`
    case 'Grep':
      return `[tool] Grep ${get('pattern') ?? ''}`.trimEnd()
    case 'Glob':
      return `[tool] Glob ${get('pattern') ?? ''}`.trimEnd()
    case 'Task':
      return `[tool] Task: ${firstLine(get('description') ?? get('prompt') ?? '')}`
    default:
      return `[tool] ${block.name}`
  }
}

function cap(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > TOOL_RESULT_CAP_CHARS
    ? oneLine.slice(0, TOOL_RESULT_CAP_CHARS) + '… [truncated]'
    : oneLine
}

/**
 * Signal of a tool result, or undefined to strip it. Failures (interrupted /
 * is_error / stderr) and final-state results (Task summaries) are always kept and
 * capped; short successes are kept; long successful output from bulk read/search
 * tools is dropped; other long output is capped rather than lost.
 */
function renderToolResultSignal(toolName: string, res: ToolResultSignal): string | undefined {
  if (res.interrupted) return '  -> interrupted'
  if (res.isError) return `  -> error: ${cap(res.content || res.stderr || '')}`
  if (res.stderr && res.stderr.trim()) return `  -> stderr: ${cap(res.stderr)}`
  const body = res.content.trim()
  if (toolName === 'Task') {
    return body ? `  -> ${cap(body)}` : (res.status ? `  -> ${res.status}` : '  -> done')
  }
  if (body.length === 0) return '  -> ok'
  if (body.length <= TOOL_RESULT_CAP_CHARS) return `  -> ${cap(body)}`
  if (BULK_OUTPUT_TOOLS.has(toolName)) return undefined // raw file/search dump
  return `  -> ${cap(body)}`
}

/**
 * Filter a raw transcript to an actions-in/dumps-out view. Keeps user/assistant
 * text, queued-command steering, one compact line per tool call, and signal from
 * each call's result (errors, stderr, interrupts, Task summaries, short outputs);
 * strips thinking, bulk read/search output, system + file-history entries, and
 * compact-summary injections.
 *
 * Accepts a flat `JsonlEntry[]`, so a future caller can concatenate subagent-file
 * entries before calling without changing this function.
 */
export function pruneTranscript(entries: JsonlEntry[]): PrunedLine[] {
  // tool_result arrives in the NEXT user entry; index by tool_use_id so each call
  // can join its own result even with several tool_use blocks per assistant message.
  // Structured stdout/stderr/interrupted live on the entry's singular toolUseResult;
  // attach them to the result block only when the entry holds exactly one (unambiguous).
  const resultById = new Map<string, ToolResultSignal>()
  for (const e of entries) {
    if (!isMessageEntry(e) || !Array.isArray(e.message.content)) continue
    const toolResults = e.message.content.filter((b): b is ToolResultBlock => b.type === 'tool_result')
    for (const b of toolResults) {
      resultById.set(b.tool_use_id, {
        content: typeof b.content === 'string' ? b.content : '',
        isError: !!b.is_error,
      })
    }
    if (toolResults.length === 1 && e.toolUseResult) {
      const sig = resultById.get(toolResults[0].tool_use_id)
      if (sig) {
        sig.stderr = e.toolUseResult.stderr || undefined
        sig.interrupted = e.toolUseResult.interrupted || undefined
        sig.status = e.toolUseResult.status
      }
    }
  }

  const lines: PrunedLine[] = []
  for (const e of entries) {
    if (isAttachmentEntry(e)) {
      if (e.attachment.type === 'queued_command') {
        const text = typeof e.attachment.prompt === 'string'
          ? e.attachment.prompt
          : Array.isArray(e.attachment.prompt) ? textFromContent(e.attachment.prompt) : ''
        if (text.trim()) lines.push(line('user', `USER: ${text.trim()}`))
      } else {
        lines.push(line('attachment', `[attachment: ${e.attachment.type}]`))
      }
      continue
    }

    if (!isMessageEntry(e)) continue // strip system + file-history
    if (e.isCompactSummary) continue // boundary summary captured by the loader

    const content = e.message.content

    if (e.type === 'user') {
      if (Array.isArray(content) && content.length > 0 && content.every((b) => b.type === 'tool_result')) continue
      const text = textFromContent(content)
      if (text.trim()) lines.push(line('user', `USER: ${text.trim()}`))
      continue
    }

    const text = textFromContent(content)
    if (text.trim()) lines.push(line('assistant', `ASSISTANT: ${text.trim()}`))
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'tool_use') {
          const call = renderToolCall(b)
          const res = resultById.get(b.id)
          const signal = res ? renderToolResultSignal(b.name, res) : undefined
          lines.push(line('tool', signal ? `${call}\n${signal}` : call))
        }
        // thinking blocks intentionally dropped
      }
    }
  }
  return lines
}

/** Walk newest-first up to `budget` tokens; return kept lines chronologically. */
export function budgetPrunedLines(
  lines: PrunedLine[],
  budget = SUMMARY_INPUT_BUDGET_TOKENS,
): PrunedLine[] {
  const kept: PrunedLine[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].tokens > budget && kept.length > 0) break
    kept.unshift(lines[i])
    used += lines[i].tokens
  }
  return kept
}

export function renderPrunedLines(lines: PrunedLine[]): string {
  return lines.map((l) => l.text).join('\n')
}
