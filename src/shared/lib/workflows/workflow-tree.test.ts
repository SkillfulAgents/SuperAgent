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

// Same contract against the newer capture taken on claude-agent-sdk 0.3.206 /
// CLI 2.1.206 (the CLI that backgrounds subagents by default) — guards the
// disk formats (journal, transcripts, script sidecar) against CLI drift.
describe('buildWorkflowTree — sdk 0.3.206 capture fixture', () => {
  const root = path.join(__dirname, '..', 'container', '__fixtures__', 'sdk206-workflow-probe')
  const sid = '18762a15-e1e9-443c-ae5e-e55f138989ac'
  const run = 'wf_255e9212-aaa'

  it('joins both agents (incl. the interpolated prompt) via prompt-regex', async () => {
    const tree = await buildWorkflowTree({ sessionsDir: root, sessionId: sid, runId: run })
    expect(tree).not.toBeNull()
    expect(tree!.name).toBe('capture-probe')
    expect(tree!.phases.map((p) => p.title)).toEqual(['Run'])
    expect(tree!.expectedAgents).toBe(2)

    const byResult = new Map(tree!.agents.map((a) => [a.result, a]))
    expect(byResult.get('wf-alpha')).toMatchObject({
      phase: 'Run',
      status: 'done',
      resolved: 'prompt-regex',
      prompt: 'Reply with exactly: wf-alpha',
    })
    // The template-literal call site — exact-string matching would miss it.
    expect(byResult.get('alpha-beta')).toMatchObject({
      phase: 'Run',
      status: 'done',
      resolved: 'prompt-regex',
      prompt: 'Concatenate these two words with a dash and reply with only the result: alpha beta',
    })
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

  it('falls back to the transcript-referenced script for scriptPath invocations', async () => {
    // scriptPath runs persist nothing under <session>/workflows/scripts — the only
    // pointer to the script is the Workflow tool result in the session transcript.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-tree-sp-'))
    tmpDirs.push(tmp)
    const workspace = path.join(tmp, 'workspace')
    const sessionsDir = path.join(workspace, '.claude', 'projects', '-workspace')
    const runDir = path.join(sessionsDir, 's1', 'subagents', 'workflows', 'wf_sp')
    await fs.mkdir(runDir, { recursive: true })
    await fs.writeFile(
      path.join(runDir, 'journal.jsonl'),
      JSON.stringify({ type: 'started', key: 'v2:1', agentId: 'k1' }) + '\n'
    )
    await fs.writeFile(
      path.join(runDir, 'agent-k1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'analyze v01' } }) + '\n'
    )
    const skillScripts = path.join(workspace, '.claude', 'skills', 'probe', 'scripts')
    await fs.mkdir(skillScripts, { recursive: true })
    await fs.writeFile(
      path.join(skillScripts, 'wf.js'),
      [
        "export const meta = { name: 'probe', description: 'd', phases: [{ title: 'Analyze' }] }",
        "phase('Analyze')",
        'const r = await parallel(args.videos.map(v => () => agent(`analyze ${v}`, { label: `analyze:${v}`, phase: \'Analyze\' })))',
        "const merged = await agent('merge it all', { label: 'merge' })",
      ].join('\n')
    )
    // The invocation as it appears in the transcript: the assistant tool_use carries
    // scriptPath + args; the paired tool_result names the script and the run id.
    const toolUseLine = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'Workflow',
            input: {
              scriptPath: '/workspace/.claude/skills/probe/scripts/wf.js',
              args: { videos: ['v01', 'v02', 'v03'] },
            },
          },
        ],
      },
    })
    const toolResultLine = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu1',
            content:
              'Workflow launched in background.\nScript file: /workspace/.claude/skills/probe/scripts/wf.js\nRun ID: wf_sp',
          },
        ],
      },
    })
    await fs.writeFile(path.join(sessionsDir, 's1.jsonl'), toolUseLine + '\n' + toolResultLine + '\n')
    const tree = await buildWorkflowTree({ sessionsDir, sessionId: 's1', runId: 'wf_sp' })
    expect(tree!.name).toBe('probe')
    expect(tree!.phases.map((p) => p.title)).toEqual(['Analyze'])
    // args.videos fan-out (3) + the single merge call site.
    expect(tree!.expectedAgents).toBe(4)
    expect(tree!.agents[0]).toMatchObject({ label: 'analyze:v01', phase: 'Analyze' })
  })

  it('rejects a transcript script path that escapes the workspace', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-tree-esc-'))
    tmpDirs.push(tmp)
    const workspace = path.join(tmp, 'workspace')
    const sessionsDir = path.join(workspace, '.claude', 'projects', '-workspace')
    const runDir = path.join(sessionsDir, 's1', 'subagents', 'workflows', 'wf_esc')
    await fs.mkdir(runDir, { recursive: true })
    await fs.writeFile(
      path.join(runDir, 'journal.jsonl'),
      JSON.stringify({ type: 'started', key: 'v2:1', agentId: 'k1' }) + '\n'
    )
    // A script OUTSIDE the workspace that a traversal path would otherwise reach.
    await fs.writeFile(
      path.join(tmp, 'evil.js'),
      "export const meta = { name: 'evil', description: 'd', phases: [] }"
    )
    await fs.writeFile(
      path.join(sessionsDir, 's1.jsonl'),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'Script file: /workspace/../evil.js\nRun ID: wf_esc' }],
        },
      }) + '\n'
    )
    const tree = await buildWorkflowTree({ sessionsDir, sessionId: 's1', runId: 'wf_esc' })
    expect(tree!.name).toBeNull() // traversal path ignored → degraded (script-less) tree
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
