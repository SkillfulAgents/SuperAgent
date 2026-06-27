/* eslint-disable no-template-curly-in-string -- these strings embed workflow-script SOURCE (literal `${expr}`), not interpolation */
import { describe, it, expect, afterEach } from 'vitest'
import * as path from 'path'
import * as os from 'os'
import { promises as fs } from 'fs'
import { buildWorkflowTree } from './workflow-tree'

const FIXTURE_ROOT = path.join(
  __dirname,
  '..',
  'container',
  '__fixtures__',
  'local-workflow-capture-probe'
)
const SID = 'd63a9cbc-2f5e-44dd-8017-231ac99bef35'
const RUN = 'wf_818f758a-c17'

describe('buildWorkflowTree — real capture-probe fixture', () => {
  it('joins every agent to its label/phase/status/result via prompt-regex', async () => {
    const tree = await buildWorkflowTree({ sessionsDir: FIXTURE_ROOT, sessionId: SID, runId: RUN })
    expect(tree).not.toBeNull()
    expect(tree!.name).toBe('capture-probe')
    expect(tree!.phases.map((p) => p.title)).toEqual(['Scan', 'Summarize'])
    expect(tree!.expectedAgents).toBe(3) // 3 agent() call sites in the script

    const byId = new Map(tree!.agents.map((a) => [a.agentId, a]))
    expect(byId.get('ae6ffae379942dd19')).toMatchObject({
      label: 'word-alpha',
      phase: 'Scan',
      status: 'done',
      result: 'alpha',
      resolved: 'prompt-regex',
    })
    expect(byId.get('a682ec6403fb0c730')).toMatchObject({
      label: 'word-beta',
      phase: 'Scan',
      status: 'done',
      result: 'beta',
      resolved: 'prompt-regex',
    })
    // The interpolated concat agent — exact-string match would fail; regex join works.
    expect(byId.get('a7720e731ec4c42db')).toMatchObject({
      label: 'concat',
      phase: 'Summarize',
      status: 'done',
      result: 'alpha-beta',
      resolved: 'prompt-regex',
    })

    // Per-agent metadata derived from the transcript.
    expect(byId.get('ae6ffae379942dd19')!.prompt).toBe('Return ONLY the single word: alpha')
    expect(byId.get('a7720e731ec4c42db')!.prompt).toContain('Concatenate')
    for (const a of tree!.agents) {
      expect(a.toolCount).toBeGreaterThanOrEqual(0)
      expect(a.tokens).toBeGreaterThanOrEqual(0)
    }
    // Workflow rollups present.
    expect(tree!.totals.tokens).toBeGreaterThanOrEqual(0)
    expect(tree!.totals.toolCount).toBeGreaterThanOrEqual(0)
  })

  it('returns null for an unknown runId', async () => {
    const tree = await buildWorkflowTree({
      sessionsDir: FIXTURE_ROOT,
      sessionId: SID,
      runId: 'wf_does-not-exist',
    })
    expect(tree).toBeNull()
  })
})

// --- synthetic on-disk runs for the harder join cases ----------------------

const tmpDirs: string[] = []
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function scaffold(opts: {
  script: string
  journal: Array<Record<string, unknown>>
  agents: Array<{ agentId: string; firstPrompt: string }>
}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-tree-'))
  tmpDirs.push(root)
  const sid = 's1'
  const run = 'wf_test'
  const runDir = path.join(root, sid, 'subagents', 'workflows', run)
  await fs.mkdir(runDir, { recursive: true })
  await fs.mkdir(path.join(root, sid, 'workflows', 'scripts'), { recursive: true })
  await fs.writeFile(path.join(runDir, 'journal.jsonl'), opts.journal.map((j) => JSON.stringify(j)).join('\n'))
  for (const a of opts.agents) {
    const line = JSON.stringify({
      type: 'user',
      isSidechain: true,
      agentId: a.agentId,
      message: { role: 'user', content: a.firstPrompt },
    })
    await fs.writeFile(path.join(runDir, `agent-${a.agentId}.jsonl`), line + '\n')
  }
  await fs.writeFile(path.join(root, sid, 'workflows', 'scripts', `probe-${run}.js`), opts.script)
  return root
}

describe('buildWorkflowTree — synthetic edge cases', () => {
  it('resolves a templated label from the prompt capture (fact:${p} → fact:Mars)', async () => {
    const script = [
      "export const meta = { name: 'planets', description: 'd', phases: [{ title: 'Gather' }] }",
      "phase('Gather')",
      'const facts = await parallel(planets.map((p) => () => agent(`Tell me a fun fact about ${p}.`, { label: `fact:${p}` })))',
    ].join('\n')
    const root = await scaffold({
      script,
      journal: [
        { type: 'started', key: 'v2:1', agentId: 'g1' },
        { type: 'started', key: 'v2:2', agentId: 'g2' },
        { type: 'result', key: 'v2:1', agentId: 'g1', result: 'Mars has the largest volcano.' },
        { type: 'result', key: 'v2:2', agentId: 'g2', result: 'Jupiter is huge.' },
      ],
      agents: [
        { agentId: 'g1', firstPrompt: 'Tell me a fun fact about Mars.' },
        { agentId: 'g2', firstPrompt: 'Tell me a fun fact about Jupiter.' },
      ],
    })
    const tree = await buildWorkflowTree({ sessionsDir: root, sessionId: 's1', runId: 'wf_test' })
    const byId = new Map(tree!.agents.map((a) => [a.agentId, a]))
    expect(byId.get('g1')).toMatchObject({ label: 'fact:Mars', phase: 'Gather', resolved: 'prompt-regex' })
    expect(byId.get('g2')).toMatchObject({ label: 'fact:Jupiter', phase: 'Gather', resolved: 'prompt-regex' })
  })

  it('degrades to "agent N" when the label var is absent from the prompt, and stringifies object results', async () => {
    const script = [
      "export const meta = { name: 'd', description: 'd', phases: [{ title: 'P' }] }",
      "phase('P')",
      'const r = await parallel(items.map((item, i) => () => agent(`Process ${item}.`, { label: `task-${i}` })))',
    ].join('\n')
    const root = await scaffold({
      script,
      journal: [
        { type: 'started', key: 'v2:1', agentId: 'd1' },
        { type: 'result', key: 'v2:1', agentId: 'd1', result: { score: 9 } },
      ],
      agents: [{ agentId: 'd1', firstPrompt: 'Process widget.' }],
    })
    const tree = await buildWorkflowTree({ sessionsDir: root, sessionId: 's1', runId: 'wf_test' })
    expect(tree!.agents[0]).toMatchObject({
      label: 'agent 1', // `${i}` is not in the prompt, so it can't be resolved
      phase: 'P',
      result: '{"score":9}',
      resolved: 'prompt-regex',
    })
  })

  it('marks a still-running agent (started, no result yet) as running', async () => {
    const script = [
      "export const meta = { name: 'r', description: 'd', phases: [{ title: 'Go' }] }",
      "phase('Go')",
      "const x = await agent('do the thing', { label: 'worker' })",
    ].join('\n')
    const root = await scaffold({
      script,
      journal: [{ type: 'started', key: 'v2:1', agentId: 'w1' }],
      agents: [{ agentId: 'w1', firstPrompt: 'do the thing' }],
    })
    const tree = await buildWorkflowTree({ sessionsDir: root, sessionId: 's1', runId: 'wf_test' })
    expect(tree!.agents[0]).toMatchObject({ label: 'worker', phase: 'Go', status: 'running', result: null })
  })
})
