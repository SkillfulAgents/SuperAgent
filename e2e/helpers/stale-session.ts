import fs from 'fs'
import path from 'path'

/**
 * Resolve the data directory used by the E2E server process.
 *
 * The Playwright web-server command sets SUPERAGENT_DATA_DIR=.e2e-data on the
 * *server* process, but that variable is NOT forwarded to the test-runner
 * process by default.  We replicate the same defaulting logic as
 * playwright.config.ts: honour the env var when present, otherwise assume the
 * conventional .e2e-data directory relative to the project root (which is the
 * CWD of the Playwright test runner).
 */
function getE2eDataDir(): string {
  const env = process.env.SUPERAGENT_DATA_DIR
  return env ? path.resolve(env) : path.resolve('.e2e-data')
}

/**
 * Seed a session to satisfy the AND trigger (idle > 6 h AND context > 100 k tokens).
 *
 * Call AFTER the session has completed at least one turn — both the JSONL file
 * and session-metadata.json must already exist on disk.
 *
 * Mechanism
 *  1. Every JSONL entry timestamp → 7 h ago.
 *     parseSessionInfo() reads `messages[last].timestamp` as lastActivityAt,
 *     so this makes the single-session GET return lastActivityAt = 7 h ago.
 *  2. JSONL file mtime → 7 h ago.
 *     listSessions() uses stat.mtimeMs; keeping mtime aligned avoids confusion
 *     between the list endpoint and the single-session endpoint.
 *  3. session-metadata.json lastUsage.inputTokens = 110 000.
 *     currentContextTokens(lastUsage) sums inputTokens + cacheReadInputTokens
 *     + cacheCreationInputTokens. 110 000 > STALE_CONTEXT_TOKENS (100 000).
 *
 * The server reads these files on every request (no in-process cache for
 * lastActivityAt / lastUsage), so the seeded values are visible immediately
 * after the call.
 */
export function seedStaleSession(agentSlug: string, sessionId: string): void {
  const dataDir = getE2eDataDir()

  const jsonlPath = path.join(
    dataDir,
    'agents',
    agentSlug,
    'workspace',
    '.claude',
    'projects',
    '-workspace',
    `${sessionId}.jsonl`,
  )
  const metaPath = path.join(
    dataDir,
    'agents',
    agentSlug,
    'workspace',
    'session-metadata.json',
  )

  const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000)

  // Step 1 + 2: rewrite JSONL timestamps and update file mtime
  if (fs.existsSync(jsonlPath)) {
    const rewritten =
      fs
        .readFileSync(jsonlPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            const entry = JSON.parse(line) as Record<string, unknown>
            entry.timestamp = sevenHoursAgo.toISOString()
            return JSON.stringify(entry)
          } catch {
            return line
          }
        })
        .join('\n') + '\n'

    fs.writeFileSync(jsonlPath, rewritten)
    fs.utimesSync(jsonlPath, sevenHoursAgo, sevenHoursAgo)
  }

  // Step 3: inject large lastUsage into session metadata
  let metadata: Record<string, Record<string, unknown>> = {}
  if (fs.existsSync(metaPath)) {
    try {
      metadata = JSON.parse(
        fs.readFileSync(metaPath, 'utf8'),
      ) as typeof metadata
    } catch {
      /* start fresh on corrupt file */
    }
  }

  metadata[sessionId] = {
    ...(metadata[sessionId] ?? {}),
    lastUsage: {
      inputTokens: 110_000,         // sum > STALE_CONTEXT_TOKENS (100_000)
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 1_000,
      contextWindow: 200_000,
    },
  }
  // Ensure the workspace directory exists before writing (registerSession
  // normally creates it, but guard against edge-cases in test teardown timing)
  fs.mkdirSync(path.dirname(metaPath), { recursive: true })
  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2))
}
