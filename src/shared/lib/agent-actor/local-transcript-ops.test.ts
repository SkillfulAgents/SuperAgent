import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyDerivedSessionFiles, listSubagents, readConversationCarryOver, readSubagentTranscript } from './local-transcript-ops'
import { WorkspaceFileError } from './workspace-path'
import { createLocalSessionStore } from '@shared/lib/agent-actor/local-session-store'

// Real directories: the sessions directory lives inside the workspace the
// container bind-mounts, so the agent can plant links in it, and these reads
// are what a planted link must not turn into another agent's transcript.

const AGENT = 'agent-a'
const OTHER = 'agent-b'
const SESSION = 'session-1'

function sessionsDirOf(dataDir: string, slug: string): string {
  return path.join(dataDir, 'agents', slug, 'workspace', '.claude', 'projects', '-workspace')
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof WorkspaceFileError) return error.code
    throw error
  }
  throw new Error('expected a WorkspaceFileError')
}

describe('local transcript ops — containment', () => {
  let dataDir: string
  let previousDataDir: string | undefined
  let subagentsDir: string
  let otherTranscript: string

  beforeEach(async () => {
    dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-ops-'))
    previousDataDir = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = dataDir

    subagentsDir = path.join(sessionsDirOf(dataDir, AGENT), SESSION, 'subagents')
    await fs.promises.mkdir(subagentsDir, { recursive: true })

    const otherSessions = sessionsDirOf(dataDir, OTHER)
    await fs.promises.mkdir(otherSessions, { recursive: true })
    otherTranscript = path.join(otherSessions, 'secret.jsonl')
    await fs.promises.writeFile(otherTranscript, JSON.stringify({ type: 'user', secret: true }) + '\n')
  })

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = previousDataDir
    await fs.promises.rm(dataDir, { recursive: true, force: true })
  })

  it('reads a subagent transcript that really is inside the workspace', async () => {
    await fs.promises.writeFile(path.join(subagentsDir, 'agent-x.jsonl'), JSON.stringify({ type: 'assistant', n: 1 }) + '\n')
    await fs.promises.writeFile(path.join(subagentsDir, 'agent-x.meta.json'), JSON.stringify({ toolUseId: 'tu-1' }))

    expect(await readSubagentTranscript(createLocalSessionStore(AGENT), SESSION, 'x')).toEqual([{ type: 'assistant', n: 1 }])
    expect(await listSubagents(createLocalSessionStore(AGENT), SESSION)).toEqual([{ id: 'x', toolUseId: 'tu-1' }])
  })

  it('does not read the sidecars of the subagents the caller already knows', async () => {
    await fs.promises.writeFile(path.join(subagentsDir, 'agent-known.meta.json'), JSON.stringify({ toolUseId: 'tu-1' }))
    await fs.promises.writeFile(path.join(subagentsDir, 'agent-new.meta.json'), JSON.stringify({ toolUseId: 'tu-2' }))
    const reads = vi.spyOn(fs.promises, 'readFile')
    try {
      expect(await listSubagents(createLocalSessionStore(AGENT), SESSION, { except: new Set(['known']) })).toEqual([{ id: 'new', toolUseId: 'tu-2' }])
      expect(reads.mock.calls.map(([file]) => path.basename(String(file)))).toEqual(['agent-new.meta.json'])
    } finally {
      reads.mockRestore()
    }
  })

  it("a link planted in the subagents directory does not read another agent's transcript", async () => {
    await fs.promises.symlink(otherTranscript, path.join(subagentsDir, 'agent-x.jsonl'))

    expect(await codeOf(readSubagentTranscript(createLocalSessionStore(AGENT), SESSION, 'x'))).toBe('not-found')
  })

  it('a link swapped in for the sessions directory itself is caught against the workspace', async () => {
    const sessionsDir = sessionsDirOf(dataDir, AGENT)
    await fs.promises.rm(sessionsDir, { recursive: true, force: true })
    await fs.promises.symlink(path.dirname(otherTranscript), sessionsDir)

    expect(await codeOf(readSubagentTranscript(createLocalSessionStore(AGENT), 'anything', 'x'))).toBe('not-found')
  })

  it('a traversal in a segment is rejected before the filesystem is consulted', async () => {
    expect(await codeOf(readSubagentTranscript(createLocalSessionStore(AGENT), '../../..', 'x'))).toBe('invalid-path')
  })
})

// Real capture: CLI 2.1.303, a fork subagent launched after a Bash step.
const FORK_FIXTURE = path.resolve(__dirname, '../container/__fixtures__/sdk303-fork-subagent')

describe('copyDerivedSessionFiles — fork subagents', () => {
  let dataDir: string
  let previousDataDir: string | undefined
  let sessionsDir: string
  let forkFile: string
  const COPY = 'session-copy'

  /** The transcript a session fork writes: every entry re-id'd, its source named in forkedFrom. */
  function copyOf(lines: string[], uuids: Map<string, string>): string {
    return lines.map((line) => {
      const entry = JSON.parse(line)
      if (typeof entry.uuid !== 'string') return line
      return JSON.stringify({
        ...entry,
        uuid: uuids.get(entry.uuid),
        parentUuid: entry.parentUuid ? uuids.get(entry.parentUuid) ?? null : null,
        sessionId: COPY,
        forkedFrom: { sessionId: SESSION, messageUuid: entry.uuid },
      })
    }).join('\n') + '\n'
  }

  beforeEach(async () => {
    dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-ops-fork-'))
    previousDataDir = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = dataDir
    sessionsDir = sessionsDirOf(dataDir, AGENT)
    const subagentsDir = path.join(sessionsDir, SESSION, 'subagents')
    await fs.promises.mkdir(subagentsDir, { recursive: true })

    // The capture names its own session; rename it to SESSION here.
    const meta = JSON.parse(await fs.promises.readFile(path.join(FORK_FIXTURE, 'metadata.json'), 'utf8'))
    const lead = (await fs.promises.readFile(path.join(FORK_FIXTURE, 'lead-transcript.jsonl'), 'utf8')).replaceAll(meta.sessionId, SESSION).trim().split('\n')
    await fs.promises.writeFile(path.join(sessionsDir, `${SESSION}.jsonl`), lead.join('\n') + '\n')
    const uuids = new Map<string, string>(
      lead.map((line) => JSON.parse(line).uuid).filter((uuid): uuid is string => typeof uuid === 'string').map((uuid, i) => [uuid, `copy-${i}`]),
    )
    await fs.promises.writeFile(path.join(sessionsDir, `${COPY}.jsonl`), copyOf(lead, uuids))
    for (const name of await fs.promises.readdir(path.join(FORK_FIXTURE, 'fs-snapshot'))) {
      const body = (await fs.promises.readFile(path.join(FORK_FIXTURE, 'fs-snapshot', name), 'utf8')).replaceAll(meta.sessionId, SESSION)
      await fs.promises.writeFile(path.join(subagentsDir, name), body)
      if (name.endsWith('.jsonl')) forkFile = name
    }
  })

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = previousDataDir
    await fs.promises.rm(dataDir, { recursive: true, force: true })
  })

  const lines = async (session: string, name: string) =>
    (await fs.promises.readFile(path.join(sessionsDir, session, 'subagents', name), 'utf8')).split('\n')

  it("repoints a copied fork's inherited context at the copy", async () => {
    const [sourceRef, ...sourceRest] = await lines(SESSION, forkFile)
    const { parentLastUuid } = JSON.parse(sourceRef)
    expect(JSON.parse(sourceRef)).toMatchObject({ type: 'fork-context-ref', parentSessionId: SESSION })

    await copyDerivedSessionFiles(createLocalSessionStore(AGENT), SESSION, COPY)

    const [ref, ...rest] = await lines(COPY, forkFile)
    const copied = (await fs.promises.readFile(path.join(sessionsDir, `${COPY}.jsonl`), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    const counterpart = copied.find((e) => e.forkedFrom?.messageUuid === parentLastUuid)
    expect(counterpart).toBeDefined()
    expect(JSON.parse(ref)).toEqual({ ...JSON.parse(sourceRef), parentSessionId: COPY, parentLastUuid: counterpart.uuid })
    expect(rest).toEqual(sourceRest)
    // The source keeps its own.
    expect((await lines(SESSION, forkFile))[0]).toBe(sourceRef)
  })

  it('leaves a ref with no copied counterpart, and any other subagent transcript, as copied', async () => {
    const subagentsDir = path.join(sessionsDir, SESSION, 'subagents')
    const [sourceRef, ...sourceRest] = await lines(SESSION, forkFile)
    const unmapped = JSON.stringify({ ...JSON.parse(sourceRef), parentLastUuid: 'not-copied' })
    await fs.promises.writeFile(path.join(subagentsDir, forkFile), [unmapped, ...sourceRest].join('\n'))
    const plain = JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }) + '\n'
    await fs.promises.writeFile(path.join(subagentsDir, 'agent-plain.jsonl'), plain)

    await copyDerivedSessionFiles(createLocalSessionStore(AGENT), SESSION, COPY)

    expect((await lines(COPY, forkFile))[0]).toBe(unmapped)
    expect(await fs.promises.readFile(path.join(sessionsDir, COPY, 'subagents', 'agent-plain.jsonl'), 'utf8')).toBe(plain)
  })
})

describe('readConversationCarryOver — rotated chat sessions', () => {
  let dataDir: string
  let previousDataDir: string | undefined
  let sessionsDir: string

  const user = (text: string, extra: object = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, ...extra })
  const assistant = (text: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
  const toolResult = (output: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: output }] } })
  const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' } })
  const summary = (text: string) => user(text, { isCompactSummary: true, isVisibleInTranscriptOnly: true })

  async function write(sessionId: string, lines: string[]) {
    await fs.promises.writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), lines.join('\n') + '\n')
  }

  beforeEach(async () => {
    dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-ops-carry-'))
    previousDataDir = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = dataDir
    sessionsDir = sessionsDirOf(dataDir, AGENT)
    await fs.promises.mkdir(sessionsDir, { recursive: true })
  })

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = previousDataDir
    await fs.promises.rm(dataDir, { recursive: true, force: true })
  })

  it('returns the newest compact summary and the text turns after it, oldest first', async () => {
    await write('old', [
      user('Book the dentist for Tuesday.'),
      boundary,
      summary('Old summary: the user asked for a dentist booking.'),
      user('Draft the weekly report.'),
      boundary,
      summary('Newest summary: the dentist is booked for Tuesday at 9 AM.'),
      user('Who is the advocate on the Ellis file?'),
      toolResult('a very long CRM export'),
      user('Base directory for this skill: /workspace/.claude/skills/crm', { isMeta: true }),
      assistant('Olga Garnica is the advocate.'),
    ])

    const carry = await readConversationCarryOver(createLocalSessionStore(AGENT), ['old'])

    expect(carry.summary).toBe('Newest summary: the dentist is booked for Tuesday at 9 AM.')
    expect(carry.recent).toEqual([
      { role: 'user', text: 'Who is the advocate on the Ellis file?' },
      { role: 'assistant', text: 'Olga Garnica is the advocate.' },
    ])
  })

  it('continues into the earlier session when the newer one has no summary', async () => {
    await write('old', [
      summary('Summary: the weekly report goes out every Friday.'),
      user('Thanks, that works.'),
    ])
    await write('outbound-only', [
      assistant('[SYSTEM] A message was sent to the user on your behalf via chat integration:\nThe 8 AM report is ready.'),
    ])

    const carry = await readConversationCarryOver(createLocalSessionStore(AGENT), ['outbound-only', 'old'])

    expect(carry.summary).toBe('Summary: the weekly report goes out every Friday.')
    expect(carry.recent.map((turn) => turn.text)).toEqual([
      'Thanks, that works.',
      '[SYSTEM] A message was sent to the user on your behalf via chat integration:\nThe 8 AM report is ready.',
    ])
  })

  it('returns nothing for a session with no transcript', async () => {
    expect(await readConversationCarryOver(createLocalSessionStore(AGENT), ['missing'])).toEqual({ summary: null, recent: [] })
  })
})
