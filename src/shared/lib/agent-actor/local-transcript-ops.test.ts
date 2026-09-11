import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSubagents, readSubagentTranscript, readWorkflowAgentTranscript } from './local-transcript-ops'
import { WorkspaceFileError } from './workspace-path'

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

    expect(await readSubagentTranscript(AGENT, SESSION, 'x')).toEqual([{ type: 'assistant', n: 1 }])
    expect(await listSubagents(AGENT, SESSION)).toEqual([{ id: 'x', toolUseId: 'tu-1' }])
  })

  it("a link planted in the subagents directory does not read another agent's transcript", async () => {
    await fs.promises.symlink(otherTranscript, path.join(subagentsDir, 'agent-x.jsonl'))

    expect(await codeOf(readSubagentTranscript(AGENT, SESSION, 'x'))).toBe('not-found')
  })

  it('a link planted as the workflow run directory does not either', async () => {
    const workflows = path.join(subagentsDir, 'workflows')
    await fs.promises.mkdir(workflows, { recursive: true })
    await fs.promises.symlink(path.dirname(otherTranscript), path.join(workflows, 'wf_run'))

    expect(await codeOf(readWorkflowAgentTranscript(AGENT, SESSION, 'wf_run', 'secret'))).toBe('not-found')
  })

  it('a link swapped in for the sessions directory itself is caught against the workspace', async () => {
    const sessionsDir = sessionsDirOf(dataDir, AGENT)
    await fs.promises.rm(sessionsDir, { recursive: true, force: true })
    await fs.promises.symlink(path.dirname(otherTranscript), sessionsDir)

    expect(await codeOf(readSubagentTranscript(AGENT, 'anything', 'x'))).toBe('not-found')
    expect(await listSubagents(AGENT, 'anything').catch((error: WorkspaceFileError) => error.code)).toBe('not-found')
  })

  it('a traversal in a segment is rejected before the filesystem is consulted', async () => {
    expect(await codeOf(readSubagentTranscript(AGENT, '../../..', 'x'))).toBe('invalid-path')
  })
})
