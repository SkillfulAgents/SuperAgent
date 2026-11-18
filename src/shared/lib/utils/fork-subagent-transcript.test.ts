import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { subagentOwnEntries } from './fork-subagent-transcript'
import { transformMessages, type TransformedMessage } from './message-transform'
import type { JsonlEntry, JsonlMessageEntry } from '@shared/lib/types/agent'

const FIXTURES = path.resolve(__dirname, '../container/__fixtures__')

/** The one subagent transcript in a fixture's fs-snapshot (CLI 2.1.303 captures). */
function snapshotTranscript(fixture: string): JsonlEntry[] {
  const dir = path.join(FIXTURES, fixture, 'fs-snapshot')
  const name = fs.readdirSync(dir).find((n) => n.endsWith('.jsonl'))!
  return fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as JsonlEntry)
}

/** What the subagent messages route serves for these entries (untrimmed: what it served before forks). */
function served(entries: JsonlEntry[], { trim = true } = {}): TransformedMessage[] {
  const messages = (trim ? subagentOwnEntries(entries) : entries).filter(
    (e): e is JsonlMessageEntry => e.type === 'user' || e.type === 'assistant',
  )
  return transformMessages(messages).filter((m): m is TransformedMessage => 'toolCalls' in m)
}

const toolCalls = (messages: TransformedMessage[]) => messages.flatMap((m) => m.toolCalls)
const assistantText = (messages: TransformedMessage[]) =>
  messages.filter((m) => m.type === 'assistant').map((m) => m.content.text).join('\n')

describe('subagentOwnEntries', () => {
  it("drops a fork's inherited launch and directive, keeping its own work", () => {
    const entries = snapshotTranscript('sdk303-fork-subagent')
    // The capture opens with the inheritance this trims: untrimmed, the fork's
    // view shows the parent's Agent call that launched it.
    expect((entries[0] as { type: string }).type).toBe('fork-context-ref')
    expect(toolCalls(served(entries, { trim: false })).map((c) => c.name)).toEqual(['Agent', 'Bash'])

    const messages = served(entries)
    expect(toolCalls(messages).map((c) => c.name)).toEqual(['Bash'])
    expect(toolCalls(messages)[0].input).toMatchObject({ command: 'echo forked-child' })
    expect(assistantText(messages)).toContain('forked-child')
    expect(JSON.stringify(messages)).not.toContain('fork-boilerplate')
  })

  it('keeps every run of a fork resumed with SendMessage', () => {
    const messages = served(snapshotTranscript('sdk303-fork-sendmessage-resumed'))
    const text = assistantText(messages)
    expect(text).toContain('alpha')
    expect(text).toContain('second-run')
    expect(toolCalls(messages).map((c) => c.name)).toEqual(['Bash'])
  })

  it('has nothing of its own for a fork read before its directive is written', () => {
    const [ref, launchCopy] = snapshotTranscript('sdk303-fork-subagent')
    expect(subagentOwnEntries([ref, launchCopy])).toEqual([])
  })

  it('returns any other subagent transcript as is', () => {
    const dir = path.join(FIXTURES, 'parallel-subagents', 'fs-snapshot')
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
      const entries = fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as JsonlEntry)
      expect(subagentOwnEntries(entries)).toBe(entries)
    }
  })
})
