import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { transformMessages, TransformedMessage } from './message-transform'
import { deriveTaskList, TaskSourceMessage, Todo } from './derive-task-list'
import { JsonlMessageEntry, JsonlSystemEntry } from '@shared/lib/types/agent'

// ============================================================================
// Fixture: distilled from a real 2.1.206 transcript where the CLI re-appended
// the full prior history VERBATIM (same uuids, same message ids) on each of
// two session resumes. The file contains:
//   - batch 1: TaskCreate #1-#4 (per-block assistant entries sharing one
//     message.id) + results + TaskUpdates marking all four completed
//   - batch 2: TaskCreate #12-#17 + updates (#12-#16 completed, in order)
//   - two resume replays: byte-identical copies of the batch-1 block
//   - post-replay live updates: #15 completed, #17 in_progress
// Real task IDs live ONLY in the TaskCreate tool RESULT text
// ("Task #N created successfully: ..."), and after a replay the Nth
// TaskCreate call seen is no longer task #N — which is the bug this
// fixture reproduces.
// ============================================================================

function loadFixtureMessages(): TransformedMessage[] {
  const raw = fs.readFileSync(
    path.join(__dirname, '__fixtures__', 'resume-replay-tasks.jsonl'),
    'utf-8'
  )
  const entries = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string })
    // Mirror session-service's isMessageOrSystemDisplayEntry filter
    .filter((e) => e.type === 'user' || e.type === 'assistant' || e.type === 'system')
  return transformMessages(entries as (JsonlMessageEntry | JsonlSystemEntry)[]).filter(
    (item): item is TransformedMessage => item.type === 'user' || item.type === 'assistant'
  )
}

const BATCH1 = [
  'Research Vox style + social explainer craft (subagent)',
  'Verify API landscape: ElevenLabs, OpenAI, Replicate (subagent)',
  'Install Remotion skills + scaffold template (subagent)',
  'Define pipeline conventions + project layout',
]
const BATCH2 = [
  'Research Iran situation (subagent, recent news)',
  'Write script + checkpoint with user',
  'Generate voiceover + align beats',
  'Produce assets (subagent)',
  'Sound design (subagent, parallel)',
  'Assemble in Remotion (subagent)',
]

describe('transformMessages on a resume-replayed transcript', () => {
  it('drops replayed duplicate entries instead of stacking their blocks', () => {
    const messages = loadFixtureMessages()
    const taskCreates = messages.flatMap((m) => m.toolCalls.filter((tc) => tc.name === 'TaskCreate'))
    // 10 unique tasks were created; the two replays must not inflate this to 18
    expect(taskCreates).toHaveLength(10)
    // No tool call id may appear twice (replays reuse the exact same ids)
    const ids = taskCreates.map((tc) => tc.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('does not triple the merged batch-1 assistant message', () => {
    const messages = loadFixtureMessages()
    // All batch-1 creates stream as per-block entries of ONE assistant message;
    // the replayed copies share its message.id and must merge to nothing
    const batch1Msg = messages.find((m) =>
      m.toolCalls.some((tc) => (tc.input as { subject?: string }).subject === BATCH1[0])
    )
    expect(batch1Msg).toBeDefined()
    expect(batch1Msg!.toolCalls.filter((tc) => tc.name === 'TaskCreate')).toHaveLength(4)
  })

  it('still attaches results to every TaskCreate call', () => {
    const messages = loadFixtureMessages()
    const taskCreates = messages.flatMap((m) => m.toolCalls.filter((tc) => tc.name === 'TaskCreate'))
    for (const tc of taskCreates) {
      expect(tc.result).toMatch(/^Task #\d+ created successfully/)
    }
  })
})

describe('deriveTaskList on a resume-replayed transcript (end-to-end)', () => {
  it('derives each task exactly once with its final status', () => {
    const { todos, activeItem } = deriveTaskList(loadFixtureMessages())

    expect(todos).not.toBeNull()
    const subjects = todos!.map((t) => t.content)
    expect(subjects).toEqual([...BATCH1, ...BATCH2])

    const byContent = new Map(todos!.map((t) => [t.content, t.status]))
    for (const subject of BATCH1) {
      expect(byContent.get(subject), subject).toBe('completed')
    }
    // Batch 2: #12-#16 completed (the #15 completion arrives AFTER the
    // replays — it must land on the real task, not a replayed copy)
    for (const subject of BATCH2.slice(0, 5)) {
      expect(byContent.get(subject), subject).toBe('completed')
    }
    expect(byContent.get('Assemble in Remotion (subagent)')).toBe('in_progress')
    expect(activeItem?.content).toBe('Assemble in Remotion (subagent)')
  })
})

// ============================================================================
// Derivation-level guarantees, independent of the transform-layer dedup —
// duplicated tool calls must not corrupt the list even if they reach the
// derivation (e.g. a future persistence path without uuid dedup).
// ============================================================================

function assistantMsg(toolCalls: TaskSourceMessage['toolCalls']): TaskSourceMessage {
  return { type: 'assistant', toolCalls }
}

function taskCreate(subject: string, realId: number | null, extras: { isError?: boolean } = {}) {
  return {
    name: 'TaskCreate',
    input: { subject, activeForm: `${subject}...` },
    ...(realId !== null ? { result: `Task #${realId} created successfully: ${subject}` } : {}),
    ...extras,
  }
}

function taskUpdate(taskId: string, status: string) {
  return {
    name: 'TaskUpdate',
    input: { taskId, status },
    result: `Updated task #${taskId} status`,
  }
}

describe('deriveTaskList keying by real task id', () => {
  it('matches updates by the id in the TaskCreate result, not call order', () => {
    // Task ids continue from an earlier (compacted-away or replay-shifted)
    // numbering: the 1st visible create is task #12, the 2nd is #13
    const messages = [
      assistantMsg([taskCreate('Write the report', 12), taskCreate('Review the report', 13)]),
      assistantMsg([taskUpdate('12', 'completed'), taskUpdate('13', 'in_progress')]),
    ]
    const { todos, activeItem } = deriveTaskList(messages)
    expect(todos).toEqual([
      { content: 'Write the report', status: 'completed', activeForm: 'Write the report...' },
      { content: 'Review the report', status: 'in_progress', activeForm: 'Review the report...' },
    ])
    expect(activeItem?.content).toBe('Review the report')
  })

  it('collapses duplicated creates that carry the same real task id', () => {
    const create = taskCreate('Ship the fix', 1)
    const messages = [
      assistantMsg([create]),
      assistantMsg([taskUpdate('1', 'completed')]),
      // replayed history reaching the derivation unchanged
      assistantMsg([create]),
    ]
    const { todos } = deriveTaskList(messages)
    expect(todos).toEqual([
      { content: 'Ship the fix', status: 'completed', activeForm: 'Ship the fix...' },
    ])
  })

  it('keeps an in-flight create (no result yet) visible as pending', () => {
    const messages = [assistantMsg([taskCreate('Streaming task', null)])]
    const { todos } = deriveTaskList(messages)
    expect(todos).toEqual([
      { content: 'Streaming task', status: 'pending', activeForm: 'Streaming task...' },
    ])
  })

  it('ignores failed TaskCreate calls', () => {
    const messages = [
      assistantMsg([
        { ...taskCreate('Doomed task', null), result: 'Error: task store unavailable', isError: true },
        taskCreate('Real task', 1),
      ]),
    ]
    const { todos } = deriveTaskList(messages)
    expect(todos).toEqual([
      { content: 'Real task', status: 'pending', activeForm: 'Real task...' },
    ])
  })
})

describe('deriveTaskList TodoWrite fallback', () => {
  it('uses the last TodoWrite when no TaskCreate calls exist', () => {
    const todosInput: Todo[] = [
      { content: 'a', status: 'completed', activeForm: 'doing a' },
      { content: 'b', status: 'in_progress', activeForm: 'doing b' },
    ]
    const messages = [
      assistantMsg([{ name: 'TodoWrite', input: { todos: [todosInput[0]] } }]),
      assistantMsg([{ name: 'TodoWrite', input: { todos: todosInput } }]),
    ]
    const { todos, activeItem } = deriveTaskList(messages)
    expect(todos).toEqual(todosInput)
    expect(activeItem?.content).toBe('b')
  })
})
