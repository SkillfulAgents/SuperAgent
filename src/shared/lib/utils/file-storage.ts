/**
 * File Storage Utilities
 *
 * Utilities for file-based agent storage including:
 * - Slug generation
 * - Markdown frontmatter parsing
 * - JSONL operations
 * - Directory operations
 * - Agent path helpers
 */

import * as fs from 'fs'
import * as path from 'path'
import type { ZodType } from 'zod'
import { getDataDir } from '@shared/lib/config/data-dir'

// ============================================================================
// Slug Generation
// ============================================================================

/**
 * Generate a random alphanumeric string of specified length
 */
function generateRandomSuffix(length: number = 6): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

/**
 * Convert a name to a URL-safe slug
 * "My Cool Agent" -> "my-cool-agent"
 */
function nameToSlugBase(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with hyphens
    .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
    .substring(0, 50) // Limit length
}

/**
 * Generate a URL-safe slug with unique suffix
 * "My Cool Agent" -> "my-cool-agent-k7x9m2"
 *
 * Note: Display name always comes from CLAUDE.md frontmatter, not the slug.
 * The slug is only used for directory names and URLs.
 */
export function generateAgentSlug(name: string): string {
  const base = nameToSlugBase(name)
  const suffix = generateRandomSuffix()
  return base ? `${base}-${suffix}` : suffix
}

/**
 * Generate a unique agent slug, checking for collisions
 * Regenerates random suffix if directory already exists
 */
export async function generateUniqueAgentSlug(name: string): Promise<string> {
  const maxAttempts = 10
  for (let i = 0; i < maxAttempts; i++) {
    const slug = generateAgentSlug(name)
    const agentDir = getAgentDir(slug)
    if (!await directoryExists(agentDir)) {
      return slug
    }
  }
  // Fallback: use timestamp for uniqueness
  const base = nameToSlugBase(name)
  const timestamp = Date.now().toString(36)
  return base ? `${base}-${timestamp}` : timestamp
}

// ============================================================================
// Frontmatter Parsing
// ============================================================================

export interface ParsedMarkdown<T = Record<string, unknown>> {
  frontmatter: T
  body: string
}

/**
 * Parse markdown file with YAML frontmatter
 * Returns { frontmatter: {...}, body: "..." }
 *
 * Frontmatter format:
 * ---
 * key: value
 * another: value
 * ---
 * Body content here
 */
export function parseMarkdownWithFrontmatter<T = Record<string, unknown>>(
  content: string
): ParsedMarkdown<T> {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
  const match = content.match(frontmatterRegex)

  if (!match) {
    // No frontmatter found, entire content is body
    return {
      frontmatter: {} as T,
      body: content,
    }
  }

  const [, frontmatterStr, body] = match
  const frontmatter: Record<string, unknown> = {}

  // Simple YAML parser for flat key-value pairs
  const lines = frontmatterStr.split(/\r?\n/)
  for (const line of lines) {
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue

    const key = line.substring(0, colonIndex).trim()
    let value: string | boolean | number = line.substring(colonIndex + 1).trim()

    // Remove surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    // Parse booleans and numbers
    if (value === 'true') value = true
    else if (value === 'false') value = false
    else if (!isNaN(Number(value)) && value !== '') value = Number(value)

    frontmatter[key] = value
  }

  return {
    frontmatter: frontmatter as T,
    body: body.trim(),
  }
}

/**
 * Serialize frontmatter + body back to markdown string
 */
export function serializeMarkdownWithFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string
): string {
  const lines: string[] = ['---']

  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null) continue

    let serialized: string
    if (typeof value === 'string') {
      // Quote strings that contain special characters
      if (value.includes(':') || value.includes('#') || value.includes('\n')) {
        serialized = `"${value.replace(/"/g, '\\"')}"`
      } else {
        serialized = value
      }
    } else {
      serialized = String(value)
    }

    lines.push(`${key}: ${serialized}`)
  }

  lines.push('---')
  lines.push('')
  lines.push(body)

  return lines.join('\n')
}

// ============================================================================
// Directory Operations
// ============================================================================

/**
 * List subdirectories in a path (for listing agents)
 */
export async function listDirectories(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

/**
 * Check if directory exists
 */
export async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(dirPath)
    return stat.isDirectory()
  } catch {
    return false
  }
}

/**
 * Check if file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath)
    return stat.isFile()
  } catch {
    return false
  }
}

/**
 * Safely remove directory recursively
 */
export async function removeDirectory(dirPath: string): Promise<void> {
  await fs.promises.rm(dirPath, { recursive: true, force: true })
}

/**
 * Create directory if it doesn't exist
 */
export async function ensureDirectory(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true })
}

/**
 * Read file contents, returns null if file doesn't exist
 */
export async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8')
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

/**
 * Write file with optional mode (for secrets)
 */
export async function writeFile(
  filePath: string,
  content: string,
  options?: { mode?: number }
): Promise<void> {
  await fs.promises.writeFile(filePath, content, {
    encoding: 'utf-8',
    mode: options?.mode,
  })
}

// ============================================================================
// JSONL Operations
// ============================================================================

/**
 * Parse JSONL content into array of objects
 * Skips empty lines and handles parse errors gracefully
 */
export function parseJsonl<T = unknown>(content: string): T[] {
  const lines = content.split(/\r?\n/)
  const results: T[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    try {
      results.push(JSON.parse(trimmed) as T)
    } catch (error) {
      // Skip malformed lines (common during concurrent writes by SDK)
    }
  }

  return results
}

/**
 * Read and parse a JSONL file
 * Returns empty array if file doesn't exist
 */
export async function readJsonlFile<T = unknown>(filePath: string): Promise<T[]> {
  const content = await readFileOrNull(filePath)
  if (content === null) {
    return []
  }
  return parseJsonl<T>(content)
}

/**
 * Stream-read JSONL file line by line (for large files)
 * Yields parsed objects one at a time
 */
export async function* streamJsonlFile<T = unknown>(
  filePath: string
): AsyncIterable<T> {
  const fileHandle = await fs.promises.open(filePath, 'r')
  const stream = fileHandle.createReadStream({ encoding: 'utf-8' })

  let buffer = ''

  for await (const chunk of stream) {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)

    // Keep the last potentially incomplete line in buffer
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        yield JSON.parse(trimmed) as T
      } catch {
        // Skip malformed lines
      }
    }
  }

  // Process any remaining content in buffer
  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer.trim()) as T
    } catch {
      // Skip malformed line
    }
  }

  await fileHandle.close()
}

// ============================================================================
// Temp Upload Helpers
// ============================================================================

/**
 * Get the temp uploads directory for chunked file uploads
 * ~/.superagent/tmp/uploads/
 */
export function getTempUploadsDir(): string {
  return path.join(getDataDir(), 'tmp', 'uploads')
}

// ============================================================================
// Agent Path Helpers
// ============================================================================

/**
 * Get the agents root directory
 * ~/.superagent/agents/
 */
export function getAgentsDir(): string {
  return path.join(getDataDir(), 'agents')
}

/**
 * Get agent root directory
 * ~/.superagent/agents/{slug}/
 */
export function getAgentDir(slug: string): string {
  return path.join(getAgentsDir(), slug)
}

/**
 * Get agent workspace directory (mounted to container at /workspace)
 * ~/.superagent/agents/{slug}/workspace/
 */
export function getAgentWorkspaceDir(slug: string): string {
  return path.join(getAgentDir(slug), 'workspace')
}

/**
 * Get CLAUDE.md path for agent (inside workspace)
 * ~/.superagent/agents/{slug}/workspace/CLAUDE.md
 */
export function getAgentClaudeMdPath(slug: string): string {
  return path.join(getAgentWorkspaceDir(slug), 'CLAUDE.md')
}

/**
 * Get .env path for agent secrets
 * ~/.superagent/agents/{slug}/workspace/.env
 */
export function getAgentEnvPath(slug: string): string {
  return path.join(getAgentWorkspaceDir(slug), '.env')
}

/**
 * Get session metadata path
 * ~/.superagent/agents/{slug}/workspace/session-metadata.json
 */
export function getAgentSessionMetadataPath(slug: string): string {
  return path.join(getAgentWorkspaceDir(slug), 'session-metadata.json')
}

/**
 * Get agent preferences path
 * ~/.superagent/agents/{slug}/workspace/agent-preferences.json
 */
export function getAgentPreferencesPath(slug: string): string {
  return path.join(getAgentWorkspaceDir(slug), 'agent-preferences.json')
}

/**
 * Get Claude config directory (for CLAUDE_CONFIG_DIR env var)
 * ~/.superagent/agents/{slug}/workspace/.claude/
 */
export function getAgentClaudeConfigDir(slug: string): string {
  return path.join(getAgentWorkspaceDir(slug), '.claude')
}

/**
 * Get sessions directory where JSONL files are stored
 * ~/.superagent/agents/{slug}/workspace/.claude/projects/-workspace/
 */
export function getAgentSessionsDir(slug: string): string {
  return path.join(getAgentClaudeConfigDir(slug), 'projects', '-workspace')
}

/**
 * Get path to a specific session's JSONL file
 * ~/.superagent/agents/{slug}/workspace/.claude/projects/-workspace/{sessionId}.jsonl
 */
export function getSessionJsonlPath(slug: string, sessionId: string): string {
  return path.join(getAgentSessionsDir(slug), `${sessionId}.jsonl`)
}

// ============================================================================
// Copy / Write Helpers
// ============================================================================

const DEFAULT_COPY_EXCLUDED = new Set(['.git', '.skillset-metadata.json', '.skillset-original.md'])

export async function copyDirectoryFiltered(
  src: string,
  dest: string,
  extraExclusions?: string[],
): Promise<void> {
  await ensureDirectory(dest)
  const entries = await fs.promises.readdir(src, { withFileTypes: true })

  const excluded = extraExclusions
    ? new Set([...DEFAULT_COPY_EXCLUDED, ...extraExclusions])
    : DEFAULT_COPY_EXCLUDED

  for (const entry of entries) {
    if (excluded.has(entry.name)) continue

    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      await copyDirectoryFiltered(srcPath, destPath, extraExclusions)
    } else {
      await fs.promises.copyFile(srcPath, destPath)
    }
  }
}

/**
 * Write a value as pretty-printed JSON.
 *
 * Delegates to {@link writeJsonFileAtomic} so every existing caller gets crash-safe
 * temp-file + rename semantics for free — a torn/half-written JSON file can never
 * replace a good one (the data-loss bug-class). The parent directory must
 * already exist (same precondition as before).
 */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await writeJsonFileAtomic(filePath, data)
}

// ============================================================================
// Atomic Writes, Serialized Read-Modify-Write & Strict JSON Reads
// ============================================================================
//
// The file-based stores in this app (session metadata, settings, secrets,
// mounts, host-browser context maps, agent prefs, …) historically used plain
// `fs.writeFile` overwrites with read-modify-write of a whole map/array and no
// serialization, plus reads that swallowed parse errors into an empty default.
// Under concurrent or interrupted writes that combination silently and
// permanently destroys data (34 session names wiped in an earlier incident). The primitives
// below close that bug-class:
//
//  * writeFileAtomic / writeJsonFileAtomic — temp-file → fsync → rename → fsync
//    dir. A reader sees the whole old file or the whole new file, never a mix,
//    and a crash mid-write leaves the previous good file intact.
//  * withFileLock — in-process promise-chain mutex keyed by resolved path, so
//    read-modify-write cycles for the same file never interleave.
//  * readJsonFileStrict — returns the fallback ONLY when the file is absent
//    (ENOENT); a present-but-unreadable file (torn/corrupt/IO error) THROWS a
//    CorruptFileError so the surrounding write is aborted instead of clobbering
//    the file with a default.
//  * withCrossProcessFileLock — O_EXCL lockfile for the cross-process cases
//    (the agent `.env` written by both the app and the container).
//
// Each has a sync twin for the synchronous call sites (settings, mounts,
// host-browser providers) that can't easily become async.

/**
 * Thrown by the strict JSON readers when a file EXISTS but cannot be read as
 * valid JSON matching the expected schema (truncated/torn write, corrupt bytes,
 * or wrong shape) — as distinct from the file simply being absent.
 *
 * Callers MUST let this propagate and abort the surrounding read-modify-write
 * rather than treating it as an empty default and overwriting (the original
 * failure mode). The on-disk file is left untouched so it can be recovered.
 */
export class CorruptFileError extends Error {
  readonly filePath: string
  readonly reason: string
  constructor(filePath: string, reason: string, options?: { cause?: unknown }) {
    super(`Refusing to use corrupt file ${filePath}: ${reason}`, options)
    this.name = 'CorruptFileError'
    this.filePath = filePath
    this.reason = reason
  }
}

let tmpWriteCounter = 0

/** Sibling temp path in the same directory as `filePath` (so rename is atomic —
 *  same filesystem). Leading dot + pid + counter + random keeps it unique and
 *  out of the way of glob/dir listings. */
function tempPathFor(filePath: string): string {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  return path.join(dir, `.${base}.${process.pid}.${++tmpWriteCounter}.${generateRandomSuffix(8)}.tmp`)
}

/**
 * fsync a directory so a rename inside it is durable across a power loss.
 * Best-effort: some platforms (notably Windows) can't fsync a directory handle.
 */
async function fsyncDir(dir: string): Promise<void> {
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(dir, 'r')
    await handle.sync()
  } catch {
    // best-effort durability — ignore platforms that disallow dir fsync
  } finally {
    await handle?.close().catch(() => {})
  }
}

function fsyncDirSync(dir: string): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    // best-effort durability
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

// Windows can transiently fail a rename-replace with EPERM/EACCES/EBUSY when an
// external process (antivirus, Search indexer, backup) briefly holds the target
// open WITHOUT FILE_SHARE_DELETE — POSIX renames don't hit this. Retry a few
// times with a short backoff (mirrors npm `write-file-atomic`); a no-op on
// platforms/filesystems where rename doesn't raise these codes.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'])

async function renameWithRetry(from: string, to: string, attempts = 10): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.promises.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (i >= attempts || !code || !RENAME_RETRY_CODES.has(code)) throw err
      await new Promise((r) => setTimeout(r, 10 * (i + 1)))
    }
  }
}

/** Sync rename with bounded immediate retries (a sync sleep would block the
 *  event loop). Best-effort Windows resilience for the synchronous writers. */
function renameWithRetrySync(from: string, to: string, attempts = 10): void {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (i >= attempts || !code || !RENAME_RETRY_CODES.has(code)) throw err
    }
  }
}

/**
 * Atomically write `content` to `filePath`:
 *   1. write to a sibling temp file in the same directory
 *   2. fsync the temp file (contents durable on disk)
 *   3. rename temp → target (atomic on the same filesystem)
 *   4. fsync the parent directory (the rename itself is durable)
 *
 * On ANY error the temp file is removed and the existing target is left exactly
 * as it was — a failed/interrupted write never replaces a good file.
 *
 * The parent directory must already exist (callers ensure this), matching the
 * precondition of the plain `writeFile` it replaces.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  options?: { mode?: number }
): Promise<void> {
  const dir = path.dirname(filePath)
  const tmpPath = tempPathFor(filePath)
  // Match fs.writeFile(mode) semantics: `mode` applies only when CREATING the
  // target. If it already exists, preserve its current permissions — an atomic
  // rename would otherwise reset perms to the temp file's (which could, e.g.,
  // make a world-writable .env or relax a 0o600 secrets file).
  let existingMode: number | undefined
  try {
    existingMode = (await fs.promises.stat(filePath)).mode & 0o777
  } catch {
    // target absent (or unstattable) → this is a create; apply options.mode
  }
  try {
    // 'wx' = O_EXCL: never reuse a stray temp file. Unique name makes this safe.
    const handle = await fs.promises.open(tmpPath, 'wx', options?.mode ?? 0o666)
    try {
      await handle.writeFile(content, 'utf-8')
      // Best-effort: object-storage / perms-less mounts (e.g. an S3 FUSE driver)
      // may reject chmod — a permission tweak must never fail the data write.
      if (existingMode !== undefined) await handle.chmod(existingMode).catch(() => {})
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(tmpPath, filePath)
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {})
    throw err
  }
  await fsyncDir(dir)
}

/** Synchronous twin of {@link writeFileAtomic}. */
export function writeFileAtomicSync(
  filePath: string,
  content: string,
  options?: { mode?: number }
): void {
  const dir = path.dirname(filePath)
  const tmpPath = tempPathFor(filePath)
  let existingMode: number | undefined
  try {
    existingMode = (fs.statSync(filePath).mode & 0o777)
  } catch {
    // target absent → create with options.mode
  }
  try {
    const fd = fs.openSync(tmpPath, 'wx', options?.mode ?? 0o666)
    try {
      fs.writeFileSync(fd, content, 'utf-8')
      // Best-effort (see writeFileAtomic): never let a perms-less mount's chmod
      // rejection fail the data write.
      if (existingMode !== undefined) {
        try {
          fs.fchmodSync(fd, existingMode)
        } catch {
          // ignore — perms are advisory on object-storage mounts
        }
      }
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    renameWithRetrySync(tmpPath, filePath)
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true })
    } catch {
      // ignore cleanup failure
    }
    throw err
  }
  fsyncDirSync(dir)
}

/** Atomically write `data` as pretty-printed JSON. See {@link writeFileAtomic}. */
export async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(data, null, 2))
}

/** Synchronous twin of {@link writeJsonFileAtomic}. */
export function writeJsonFileAtomicSync(filePath: string, data: unknown): void {
  writeFileAtomicSync(filePath, JSON.stringify(data, null, 2))
}

// ---------------------------------------------------------------------------
// In-process serialization (per-path async mutex)
// ---------------------------------------------------------------------------

const fileWriteQueues = new Map<string, Promise<unknown>>()

/**
 * Serialize `fn` against other `withFileLock` callers for the SAME file, so a
 * read-modify-write cycle can't interleave with another in this process.
 *
 * Keyed by the resolved absolute path. The lock is NON-reentrant: never call
 * `withFileLock(p, …)` for the same `p` from inside another `withFileLock(p)` —
 * it would deadlock. Keep the read AND the write inside one `withFileLock` body;
 * the read/write primitives above deliberately do NOT take the lock themselves.
 *
 * This covers only THIS process. Cross-process races (the `.env` app-vs-container
 * case) need {@link withCrossProcessFileLock}.
 */
export function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath)
  const prev = fileWriteQueues.get(key) ?? Promise.resolve()
  // Run fn after prev settles, whether it resolved or rejected. `prev` is always
  // a never-rejecting tail, so the onRejected branch is just belt-and-suspenders.
  const result = prev.then(fn, fn)
  const tail = result.then(
    () => undefined,
    () => undefined
  )
  fileWriteQueues.set(key, tail)
  // Drop the map entry once this is the last queued op, so the map can't grow
  // unbounded across many distinct paths.
  void tail.then(() => {
    if (fileWriteQueues.get(key) === tail) fileWriteQueues.delete(key)
  })
  return result
}

// ---------------------------------------------------------------------------
// Strict JSON reads (fail-closed on corruption)
// ---------------------------------------------------------------------------

function parseJsonStrict<T>(filePath: string, content: string, schema: ZodType<T>): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    throw new CorruptFileError(filePath, 'file is not valid JSON', { cause: err })
  }
  const result = schema.safeParse(parsed)
  if (!result.success) {
    throw new CorruptFileError(filePath, `does not match expected schema: ${result.error.message}`, {
      cause: result.error,
    })
  }
  return result.data
}

/**
 * Read + Zod-validate a JSON file, distinguishing "absent" from "unreadable":
 *   - file missing (ENOENT)            → return `fallbackIfAbsent`
 *   - present but invalid JSON / wrong shape / IO error → THROW
 *
 * Use this everywhere a read-modify-write previously swallowed errors into an
 * empty default, so a transiently-unreadable file aborts the write instead of
 * being overwritten with the default (the CLAUDE.md fail-closed rule).
 */
export async function readJsonFileStrict<T>(
  filePath: string,
  schema: ZodType<T>,
  fallbackIfAbsent: T
): Promise<T> {
  let content: string
  try {
    content = await fs.promises.readFile(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return fallbackIfAbsent
    throw err // EIO / EACCES / EBUSY / … — never swallow
  }
  return parseJsonStrict(filePath, content, schema)
}

/** Synchronous twin of {@link readJsonFileStrict}. */
export function readJsonFileStrictSync<T>(
  filePath: string,
  schema: ZodType<T>,
  fallbackIfAbsent: T
): T {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return fallbackIfAbsent
    throw err
  }
  return parseJsonStrict(filePath, content, schema)
}

// ---------------------------------------------------------------------------
// Cross-process advisory lock (O_EXCL lockfile)
// ---------------------------------------------------------------------------

export interface CrossProcessLockOptions {
  /** Max time to wait to acquire the lock before throwing (ms). Default 5000. */
  timeoutMs?: number
  /** Poll interval while the lock is held by someone else (ms). Default 50. */
  retryIntervalMs?: number
  /** A lock whose file is older than this is considered stale and stolen (ms). Default 30000. */
  staleMs?: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Run `fn` while holding an on-disk `<targetPath>.lock` (O_EXCL), serializing
 * across processes that honor the same lockfile convention. Also wraps the body
 * in {@link withFileLock} so concurrent callers within THIS process queue rather
 * than fight over the lockfile.
 *
 * A stale lock (file older than `staleMs`, e.g. left by a crashed process) is
 * stolen so a dead writer can't wedge the file forever. The lock is always
 * released in a `finally`.
 */
export async function withCrossProcessFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  options?: CrossProcessLockOptions
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 5000
  const retryIntervalMs = options?.retryIntervalMs ?? 50
  const staleMs = options?.staleMs ?? 30_000
  const lockPath = `${targetPath}.lock`
  // Unique per-acquisition owner token written INTO the lockfile, so release can
  // verify we still own it (see the finally below).
  const ownerToken = `${process.pid}.${generateRandomSuffix(12)}`

  return withFileLock(targetPath, async () => {
    const deadline = Date.now() + timeoutMs
    // Acquire
    for (;;) {
      try {
        const handle = await fs.promises.open(lockPath, 'wx')
        try {
          await handle.writeFile(ownerToken)
        } finally {
          await handle.close()
        }
        break // acquired
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
        // Held by someone else — steal it if it's stale.
        try {
          const stat = await fs.promises.stat(lockPath)
          if (Date.now() - stat.mtimeMs > staleMs) {
            await fs.promises.rm(lockPath, { force: true }).catch(() => {})
            continue // retry immediately
          }
        } catch {
          // lock vanished between open and stat — retry immediately
          continue
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out after ${timeoutMs}ms acquiring cross-process lock ${lockPath}`)
        }
        await sleep(retryIntervalMs)
      }
    }
    // Critical section
    try {
      return await fn()
    } finally {
      // Release ONLY if we still own the lock. If a later writer stole it as
      // stale (we stalled past staleMs — plausible on a hung network fs), the
      // file now holds THEIR token; deleting it would let a third writer in
      // while they're mid-critical-section, reopening the lost-update race.
      const current = await fs.promises.readFile(lockPath, 'utf-8').catch(() => null)
      if (current === ownerToken) {
        await fs.promises.rm(lockPath, { force: true }).catch(() => {})
      }
    }
  })
}
