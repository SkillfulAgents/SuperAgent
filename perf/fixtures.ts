/**
 * Deterministic on-disk fixtures for the perf suite.
 *
 * Everything is derived from the profile and a seeded PRNG — names, timestamps,
 * which sessions are hidden automations — so two runs of the same profile
 * issue the same filesystem operations and produce the same op counts.
 * Transcript mtimes are pinned with `utimes`, and the ownership index is
 * written up front so the one-time legacy discovery migration is never part
 * of a measurement.
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
} as const satisfies Record<string, SeedProfile>

export interface SeededData {
  dataDir: string
  agentSlugs: string[]
  /** Newest visible (non-hidden, non-empty-unregistered) session per agent. */
  latestVisibleByAgent: Record<string, string>
  /** Total transcript files written (including SDK artifacts). */
  transcriptCount: number
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

const BASE_TIME = Date.UTC(2026, 0, 1)

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

export async function seedDataDir(dataDir: string, profile: SeedProfile): Promise<SeededData> {
  const rand = prng(0xc0ffee)
  const agentsDir = path.join(dataDir, 'agents')
  const ownership: Record<string, string> = {}
  const agentSlugs: string[] = []
  const latestVisibleByAgent: Record<string, string> = {}
  let transcriptCount = 0

  for (let a = 0; a < profile.agents; a++) {
    const slug = `agent-${String(a).padStart(3, '0')}`
    agentSlugs.push(slug)
    const workspace = path.join(agentsDir, slug, 'workspace')
    const sessionsDir = path.join(workspace, '.claude', 'projects', '-workspace')
    await fs.promises.mkdir(sessionsDir, { recursive: true })

    await fs.promises.writeFile(
      path.join(workspace, 'CLAUDE.md'),
      `---\nname: Agent ${a}\ncreatedAt: "${new Date(BASE_TIME - a * 86_400_000).toISOString()}"\n---\n# Agent ${a}\n\nYou are a perf fixture.\n`,
    )

    const metadata: Record<string, Record<string, unknown>> = {}
    let latestVisible: { id: string; at: number } | null = null

    for (let s = 0; s < profile.sessionsPerAgent; s++) {
      const id = `${slug}-s${String(s).padStart(5, '0')}`
      ownership[id] = slug
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
      ownership[id] = slug
      // Older than every transcript so it never becomes "latest" (keeps the
      // latest-session tail read on a real transcript).
      metadata[id] = { name: `Pending ${m}`, createdAt: new Date(BASE_TIME - 86_400_000 * (m + 1)).toISOString() }
    }

    for (let e = 0; e < profile.sdkArtifactsPerAgent; e++) {
      const id = `${slug}-artifact${e}`
      ownership[id] = slug
      const file = path.join(sessionsDir, `${id}.jsonl`)
      await fs.promises.writeFile(file, '')
      // Newest of all, so a listing that forgets the empty-unregistered rule
      // would wrongly pick one of these as latest.
      const when = new Date(BASE_TIME + 200 * 86_400_000 + e)
      await fs.promises.utimes(file, when, when)
      transcriptCount++
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

  await fs.promises.writeFile(path.join(dataDir, 'session-ownership.json'), JSON.stringify(ownership))

  return { dataDir, agentSlugs, latestVisibleByAgent, transcriptCount }
}
