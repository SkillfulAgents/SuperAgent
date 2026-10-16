/**
 * Deterministic on-disk fixtures for the perf suite.
 *
 * Everything is derived from the profile and a seeded PRNG — names, timestamps,
 * which sessions are hidden automations — so two runs of the same profile
 * issue the same filesystem operations and produce the same op counts.
 * Transcript mtimes are pinned with `utimes`.
 */
import * as fs from 'fs'
import * as path from 'path'

export interface SeedProfile {
  name: string
  agents: number
  sessionsPerAgent: number
  /** Every Nth transcript-backed session is a hidden automation (0 = none). */
  hiddenEvery: number
  /** Registered sessions with no transcript yet, per agent. */
  metadataOnlyPerAgent: number
  /** Unregistered empty JSONLs (SDK subagent artifacts), per agent. */
  sdkArtifactsPerAgent: number
  /** user/assistant turn pairs per transcript. */
  turnsPerTranscript: number
  artifactsPerAgent: number
  /** One extra, long agentic session on the first agent (see LongTranscriptSpec). */
  longTranscript?: LongTranscriptSpec
}

/**
 * A long agentic session: every turn is a question, a tool call whose result
 * is a file read (recorded twice, in the tool_result block and in
 * `toolUseResult`, as the CLI writes it), and a final answer. On this shape
 * the trailing page's byte window, not its item count, decides what a read
 * costs: 300 display items span far more than the page budget.
 */
export interface LongTranscriptSpec {
  turns: number
  /** File-read payload, drawn per turn from the PRNG, in bytes. */
  minResultBytes: number
  maxResultBytes: number
}

export const PROFILES = {
  /** A typical single-user install: a handful of agents, modest history. */
  small: {
    name: 'small',
    agents: 5,
    sessionsPerAgent: 50,
    hiddenEvery: 4,
    metadataOnlyPerAgent: 1,
    sdkArtifactsPerAgent: 2,
    turnsPerTranscript: 12,
    artifactsPerAgent: 2,
  },
  /** A long-lived automation-heavy agent: one agent, thousands of sessions. */
  big: {
    name: 'big',
    agents: 1,
    sessionsPerAgent: 5000,
    hiddenEvery: 3,
    metadataOnlyPerAgent: 2,
    sdkArtifactsPerAgent: 5,
    turnsPerTranscript: 12,
    artifactsPerAgent: 3,
  },
  /** One agent whose latest session is a long tool-heavy transcript (~20 MB). */
  transcript: {
    name: 'transcript',
    agents: 1,
    sessionsPerAgent: 2,
    hiddenEvery: 0,
    metadataOnlyPerAgent: 0,
    sdkArtifactsPerAgent: 0,
    turnsPerTranscript: 12,
    artifactsPerAgent: 0,
    longTranscript: { turns: 300, minResultBytes: 4 * 1024, maxResultBytes: 60 * 1024 },
  },
} as const satisfies Record<string, SeedProfile>

export interface SeededData {
  dataDir: string
  agentSlugs: string[]
  /** Newest visible (non-hidden, non-empty-unregistered) session per agent. */
  latestVisibleByAgent: Record<string, string>
  /** Total transcript files written (including SDK artifacts). */
  transcriptCount: number
  /** The profile's long session, when it has one. */
  longSession?: {
    agentSlug: string
    sessionId: string
    bytes: number
    /** Display-item id of the newest item (the last turn's answer). */
    newestItemId: string
  }
}

/** Small deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The clock every fixture date hangs off. The harness pins `Date.now` to it
 * while the app runs, so what the fixtures say about age holds whenever the
 * suite runs: a registration minutes before it is a new session, not an
 * orphaned one the listing would drop and prune.
 */
export const BASE_TIME = Date.UTC(2026, 0, 1)

function transcriptLines(sessionId: string, turns: number, rand: () => number): string {
  const lines: string[] = []
  let ts = BASE_TIME
  for (let i = 0; i < turns; i++) {
    ts += 1000
    lines.push(JSON.stringify({
      type: 'user',
      uuid: `${sessionId}-u${i}`,
      parentUuid: i === 0 ? null : `${sessionId}-a${i - 1}`,
      sessionId,
      timestamp: new Date(ts).toISOString(),
      message: { role: 'user', content: `Question ${i}: ${'lorem ipsum '.repeat(8 + Math.floor(rand() * 8))}` },
    }))
    ts += 1000
    lines.push(JSON.stringify({
      type: 'assistant',
      uuid: `${sessionId}-a${i}`,
      parentUuid: `${sessionId}-u${i}`,
      sessionId,
      timestamp: new Date(ts).toISOString(),
      message: {
        id: `msg_${sessionId}_${i}`,
        role: 'assistant',
        content: [{ type: 'text', text: `Answer ${i}: ${'dolor sit amet '.repeat(20 + Math.floor(rand() * 40))}` }],
      },
    }))
  }
  return lines.join('\n') + '\n'
}

/** Deterministic file content of exactly `bytes` ASCII bytes. */
function filePayload(turn: number, bytes: number): string {
  const lines: string[] = []
  let size = 0
  for (let n = 1; size < bytes; n++) {
    const line = `${String(n).padStart(5)}\tconst value${turn}_${n} = compute(${n}, '${'abcdefgh'.repeat(4)}')\n`
    lines.push(line)
    size += line.length
  }
  return lines.join('').slice(0, bytes)
}

function longTranscriptLines(
  sessionId: string,
  spec: LongTranscriptSpec,
): { content: string; newestItemId: string } {
  const rand = prng(0x5eed)
  const lines: string[] = []
  let ts = BASE_TIME
  let parent: string | null = null
  const stamp = () => new Date((ts += 1000)).toISOString()
  for (let i = 0; i < spec.turns; i++) {
    const userId = `${sessionId}-u${i}`
    const callId = `${sessionId}-a${i}`
    const resultId = `${sessionId}-r${i}`
    const answerId = `${sessionId}-f${i}`
    const toolUseId = `toolu_${String(i).padStart(5, '0')}`
    const filePath = `/workspace/src/module-${i}.ts`
    const payloadBytes =
      spec.minResultBytes + Math.floor(rand() * (spec.maxResultBytes - spec.minResultBytes))
    const payload = filePayload(i, payloadBytes)
    lines.push(JSON.stringify({
      type: 'user', uuid: userId, parentUuid: parent, sessionId, timestamp: stamp(),
      message: { role: 'user', content: `Step ${i}: look at module ${i} and summarize what changed.` },
    }))
    lines.push(JSON.stringify({
      type: 'assistant', uuid: callId, parentUuid: userId, sessionId, timestamp: stamp(),
      message: {
        id: `msg_${sessionId}_${i}_call`, role: 'assistant',
        content: [
          { type: 'text', text: `Reading module ${i}.` },
          { type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: filePath } },
        ],
      },
    }))
    lines.push(JSON.stringify({
      type: 'user', uuid: resultId, parentUuid: callId, sessionId, timestamp: stamp(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: payload }] },
      toolUseResult: { type: 'text', file: { filePath, content: payload, numLines: payload.split('\n').length, startLine: 1 } },
    }))
    lines.push(JSON.stringify({
      type: 'assistant', uuid: answerId, parentUuid: resultId, sessionId, timestamp: stamp(),
      message: {
        id: `msg_${sessionId}_${i}_answer`, role: 'assistant',
        content: [{ type: 'text', text: `Module ${i}: ${'the change is contained and tested. '.repeat(4 + Math.floor(rand() * 12))}` }],
      },
    }))
    parent = answerId
  }
  return { content: lines.join('\n') + '\n', newestItemId: `${sessionId}-f${spec.turns - 1}` }
}

export async function seedDataDir(dataDir: string, profile: SeedProfile): Promise<SeededData> {
  const rand = prng(0xc0ffee)
  const agentsDir = path.join(dataDir, 'agents')
  const agentSlugs: string[] = []
  const latestVisibleByAgent: Record<string, string> = {}
  let transcriptCount = 0
  let longSession: SeededData['longSession']

  for (let a = 0; a < profile.agents; a++) {
    const slug = `agent-${String(a).padStart(3, '0')}`
    agentSlugs.push(slug)
    const workspace = path.join(agentsDir, slug, 'workspace')
    const sessionsDir = path.join(workspace, '.claude', 'projects', '-workspace')
    await fs.promises.mkdir(sessionsDir, { recursive: true })

    await fs.promises.writeFile(
      path.join(workspace, 'AGENTS.md'),
      `---\nname: Agent ${a}\ncreatedAt: "${new Date(BASE_TIME - a * 86_400_000).toISOString()}"\n---\n# Agent ${a}\n\nYou are a perf fixture.\n`,
    )

    const metadata: Record<string, Record<string, unknown>> = {}
    let latestVisible: { id: string; at: number } | null = null

    for (let s = 0; s < profile.sessionsPerAgent; s++) {
      const id = `${slug}-s${String(s).padStart(5, '0')}`
      // Activity spread over ~100 days, in a shuffled order so directory
      // order and activity order disagree.
      const at = BASE_TIME + Math.floor(rand() * 100 * 86_400_000)
      const hidden = profile.hiddenEvery > 0 && s % profile.hiddenEvery === profile.hiddenEvery - 1
      metadata[id] = {
        name: `Session ${s}`,
        createdAt: new Date(at - 3_600_000).toISOString(),
        ...(hidden ? { isScheduledExecution: true, scheduledTaskId: `task-${s % 7}` } : {}),
      }
      const file = path.join(sessionsDir, `${id}.jsonl`)
      await fs.promises.writeFile(file, transcriptLines(id, profile.turnsPerTranscript, rand))
      const when = new Date(at)
      await fs.promises.utimes(file, when, when)
      transcriptCount++
      if (!hidden && (!latestVisible || at > latestVisible.at)) latestVisible = { id, at }
    }

    for (let m = 0; m < profile.metadataOnlyPerAgent; m++) {
      const id = `${slug}-pending${m}`
      // Registered minutes before the pinned clock, so it is still a new
      // session and not an orphan; older than every transcript so it never
      // becomes "latest" (keeps the latest-session tail read on a real
      // transcript).
      metadata[id] = { name: `Pending ${m}`, createdAt: new Date(BASE_TIME - 600_000 * (m + 1)).toISOString() }
    }

    for (let e = 0; e < profile.sdkArtifactsPerAgent; e++) {
      const id = `${slug}-artifact${e}`
      const file = path.join(sessionsDir, `${id}.jsonl`)
      await fs.promises.writeFile(file, '')
      // Newest of all, so a listing that forgets the empty-unregistered rule
      // would wrongly pick one of these as latest.
      const when = new Date(BASE_TIME + 200 * 86_400_000 + e)
      await fs.promises.utimes(file, when, when)
      transcriptCount++
    }

    if (profile.longTranscript && a === 0) {
      const id = `${slug}-long`
      const { content, newestItemId } = longTranscriptLines(id, profile.longTranscript)
      const file = path.join(sessionsDir, `${id}.jsonl`)
      await fs.promises.writeFile(file, content)
      // The newest session, so it is also what the agent's home card tails.
      const at = BASE_TIME + 150 * 86_400_000
      await fs.promises.utimes(file, new Date(at), new Date(at))
      metadata[id] = { name: 'Long session', createdAt: new Date(at - 3_600_000).toISOString() }
      transcriptCount++
      latestVisible = { id, at }
      longSession = { agentSlug: slug, sessionId: id, bytes: Buffer.byteLength(content), newestItemId }
    }

    await fs.promises.writeFile(
      path.join(workspace, 'session-metadata.json'),
      JSON.stringify(metadata),
    )

    for (let d = 0; d < profile.artifactsPerAgent; d++) {
      const dir = path.join(workspace, 'artifacts', `dash-${d}`)
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: `dash-${d}`, description: `Dashboard ${d}` }),
      )
      if (d % 2 === 0) await fs.promises.mkdir(path.join(dir, 'node_modules'))
      if (d % 2 === 1) await fs.promises.writeFile(path.join(dir, 'screenshot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    }

    if (latestVisible) latestVisibleByAgent[slug] = latestVisible.id
  }

  return { dataDir, agentSlugs, latestVisibleByAgent, transcriptCount, ...(longSession ? { longSession } : {}) }
}
