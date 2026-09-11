/**
 * Agent Template Service
 *
 * Handles exporting/importing agents as ZIP templates and
 * managing agents from skillset repositories (install, update, publish, PR).
 *
 * Two kinds of storage meet here. The skillset cache (a git clone under the
 * data dir) is a directory on this machine, read and written with `fs`. The
 * agent workspace is reached only through the agent actor: its files by
 * operation (`files`) and its `CLAUDE.md` and template metadata as
 * configuration documents (`config`), all addressed by workspace path.
 */

import crypto from 'crypto'
import path from 'path'
import fs from 'fs'
import { Readable } from 'stream'
import pLimit from 'p-limit'
import archiver from 'archiver'
import {
  openZipFromBuffer,
  openZipFromFile,
  detectZipPrefix,
  type ZipEntryMeta,
  type ZipReader,
} from '@shared/lib/utils/zip'
import {
  directoryExists,
  parseMarkdownWithFrontmatter,
  serializeMarkdownWithFrontmatter,
} from '@shared/lib/utils/file-storage'
import {
  agentCatalog,
  agentRegistry,
  CONFIG_DOCS,
  ConfigDocError,
  WorkspaceFileError,
  type AgentActor,
  type FileEntry,
  type FileOps,
} from '@shared/lib/agent-actor'
import { copyHostDirIntoWorkspace } from '@shared/lib/agent-actor/copy-into-workspace'
import { getEffectiveModels } from '@shared/lib/config/settings'
import { getConfiguredLlmClient, createSummarizerText } from '@shared/lib/llm-provider/helpers'
import { resolveActiveProviderModel } from '@shared/lib/llm-provider'
import {
  readIndexJson,
  ensureSkillsetCached,
  isCacheReady,
  getSkillsetIndex,
  getSkillsetRepoDir,
  refreshSkillset,
} from '@shared/lib/services/skillset-service'
import { getSkillsetProvider } from '@shared/lib/skillset-provider'
import { createAgentFromExistingWorkspace, getAgentWithStatus, listAgents } from '@shared/lib/services/agent-service'
import type {
  SkillsetConfig,
  InstalledAgentMetadata,
  AgentTemplateStatus,
  DiscoverableAgent,
  SkillProvider,
} from '@shared/lib/types/skillset'
import type { ApiAgent } from '@shared/lib/types/api'
import type { AgentFrontmatter } from '@shared/lib/types/agent'
import { captureException } from '@shared/lib/error-reporting'
import { pruneInstalledTemplateIfInvalid } from './skillset-reconcile'

// ============================================================================
// Constants
// ============================================================================

const MAX_UNCOMPRESSED_SIZE = 500 * 1024 * 1024 // 500MB
export const MAX_COMPRESSED_SIZE = 500 * 1024 * 1024 // 500MB
const MAX_FILE_COUNT = 10_000
export const MAX_TEMPLATE_PROMPT_SIZE = 16 * 1024 // 16KB

/** Bytes of SKILL.md to read for frontmatter. The skill body may be larger. */
const ONBOARDING_SKILL_READ_LIMIT = MAX_TEMPLATE_PROMPT_SIZE + 16 * 1024

/** Canonical prompt handoff file, plus a lowercase compatibility spelling. */
const TEMPLATE_PROMPT_FILE_NAMES = ['PROMPT.md', 'prompt.md'] as const

/** Files/dirs excluded from templates (matched by name at any level) */
const TEMPLATE_EXCLUDE = new Set([
  '.env',
  '.DS_Store',
  'node_modules',
  '__pycache__',
  'session-metadata.json',
  '.superagent-sessions.json',
  '.skillset-agent-metadata.json',
  'bookmarks.json',
  'agent-preferences.json',
])

/** File extensions excluded from templates at any level */
const TEMPLATE_EXCLUDE_EXTENSIONS = new Set([
  '.pyc',
])

/** Dirs/files excluded from full exports (matched by name at any level) */
const FULL_EXPORT_EXCLUDE = new Set([
  '.DS_Store',
  'node_modules',
  '__pycache__',
  '.browser-profile',
])

/** Top-level directories excluded from templates entirely */
const TEMPLATE_EXCLUDE_TOP_DIRS = new Set([
  'uploads',
  'downloads',
  '.browser-profile',
])

/**
 * Inside .claude/, only these subdirectories are included in templates.
 * Everything else (.claude/projects, .claude/debug, .claude/todos,
 * .claude/.claude.json, .claude/stats-cache.json, etc.) is excluded.
 */
const CLAUDE_DIR_ALLOWLIST = new Set([
  'skills',
])


// ============================================================================
// Metadata Helpers
// ============================================================================

/** Workspace path of the template metadata document. */
const SKILLSET_METADATA_PATH = CONFIG_DOCS.skillsetMetadata.path

/**
 * Store the template metadata document. Spread so the schema receives an
 * object literal: the interface has no index signature, the loose document
 * type does.
 */
async function putInstalledAgentMetadata(actor: AgentActor, meta: InstalledAgentMetadata): Promise<void> {
  await actor.config.put('skillsetMetadata', { ...meta })
}

/** Decode file bytes the way `fs.readFile(path, 'utf-8')` did, so hashes and text round-trips are unchanged. */
function bytesToUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf-8')
}

async function readStreamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of Readable.fromWeb(stream as import('stream/web').ReadableStream<Uint8Array>)) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

type SkillsetRef = {
  skillsetId: string
  skillsetUrl: string
  provider?: SkillProvider
  skillsetName?: string
  providerData?: SkillsetConfig['providerData']
}

function toSkillsetRefFromConfig(config: Pick<SkillsetConfig, 'id' | 'url' | 'name' | 'provider' | 'providerData'>): SkillsetRef {
  const provider = getSkillsetProvider(config.provider)
  return {
    skillsetId: config.id,
    skillsetUrl: config.url,
    provider: config.provider,
    skillsetName: config.name,
    providerData: provider.normalizeProviderData(config),
  }
}

function toSkillsetRefFromMeta(
  meta: Pick<InstalledAgentMetadata, 'skillsetId' | 'skillsetUrl' | 'skillsetName' | 'provider' | 'providerData'>,
): SkillsetRef {
  const provider = getSkillsetProvider(meta.provider)
  return {
    skillsetId: meta.skillsetId,
    skillsetUrl: meta.skillsetUrl,
    provider: meta.provider,
    skillsetName: meta.skillsetName,
    providerData: provider.normalizeProviderData(meta),
  }
}

function getSkillsetRepoDirForRef(ref: Pick<SkillsetRef, 'skillsetId' | 'provider' | 'providerData'>): string {
  const provider = getSkillsetProvider(ref.provider)
  return getSkillsetRepoDir(provider.getEffectiveRepoId(ref))
}

// ============================================================================
// Template File Walking
// ============================================================================

/**
 * A read-only view of a file tree the template rules apply to: the agent
 * workspace through the actor, or a directory of the skillset cache on this
 * machine. Paths are relative to the tree's root, posix, `''` for the root.
 */
interface TemplateTree {
  /** Immediate children of a directory. Throws when it cannot be listed. */
  list(dir: string): Promise<Array<Pick<FileEntry, 'name' | 'kind'>>>
  /** A whole file, or null when it cannot be read. */
  read(relativePath: string): Promise<Uint8Array | null>
}

function workspaceTree(files: FileOps): TemplateTree {
  return {
    list: (dir) => files.list(dir),
    read: (relativePath) => files.getDoc(relativePath),
  }
}

/**
 * A directory of the skillset cache. Anything that is not a directory (a link
 * included) lists as a file, as `readdir` reports it.
 */
function hostTree(rootDir: string): TemplateTree {
  return {
    async list(dir) {
      const entries = await fs.promises.readdir(path.join(rootDir, dir), { withFileTypes: true })
      return entries.map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' }))
    },
    async read(relativePath) {
      try {
        return new Uint8Array(await fs.promises.readFile(path.join(rootDir, relativePath)))
      } catch {
        return null
      }
    },
  }
}

function joinTreePath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`
}

/**
 * Walk a tree and return the paths of all template-eligible files, relative
 * to its root.
 *
 * Inclusion rules:
 * - `CLAUDE.md` and other non-excluded root files are included
 * - `.claude/skills/**` is included
 * - Everything else under `.claude/` is excluded (debug, todos, projects, state files)
 * - `.browser-profile/`, `uploads/` are excluded entirely
 * - `.DS_Store`, `.env`, session files are excluded at any level
 */
async function walkTemplateFiles(tree: TemplateTree): Promise<string[]> {
  const files: string[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    const entries = await tree.list(dir)

    for (const entry of entries) {
      const relativePath = joinTreePath(dir, entry.name)

      // Skip excluded files at any level
      if (TEMPLATE_EXCLUDE.has(entry.name)) continue

      if (entry.kind === 'directory') {
        // Skip top-level excluded directories
        if (depth === 0 && TEMPLATE_EXCLUDE_TOP_DIRS.has(entry.name)) continue

        // For .claude/ directory, only recurse into allowlisted subdirs
        if (depth === 0 && entry.name === '.claude') {
          // Walk .claude/ but only include allowlisted subdirectories
          await walkClaudeDir(relativePath)
          continue
        }

        await walk(relativePath, depth + 1)
      } else {
        if (!TEMPLATE_EXCLUDE_EXTENSIONS.has(path.extname(entry.name))) {
          files.push(relativePath)
        }
      }
    }
  }

  async function walkClaudeDir(claudeDir: string): Promise<void> {
    let entries: Array<Pick<FileEntry, 'name' | 'kind'>>
    try {
      entries = await tree.list(claudeDir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (TEMPLATE_EXCLUDE.has(entry.name)) continue

      if (entry.kind === 'directory') {
        // Only recurse into allowlisted subdirectories of .claude/
        if (!CLAUDE_DIR_ALLOWLIST.has(entry.name)) continue
        await walk(joinTreePath(claudeDir, entry.name), 2)
      }
      // Skip files directly in .claude/ (e.g., .claude.json, stats-cache.json, backups)
    }
  }

  await walk('', 0)
  return files
}

// Visitor walk over the workspace. No path list in RAM. The actor never lists
// a symbolic link, so a broken or escaping link cannot reach the archive.
async function walkFullExportFiles(
  files: FileOps,
  onFile: (workspacePath: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  async function walk(dir: string): Promise<void> {
    if (signal?.aborted) return

    let entries: FileEntry[]
    try {
      entries = await files.list(dir)
    } catch {
      return // skip directories we can't read
    }

    for (const entry of entries) {
      if (signal?.aborted) return
      if (FULL_EXPORT_EXCLUDE.has(entry.name)) continue

      if (entry.kind === 'directory') {
        await walk(entry.path)
      } else {
        await onFile(entry.path)
      }
    }
  }

  await walk('')
}

// ============================================================================
// ZIP Export
// ============================================================================

export class ExportInProgressError extends Error {
  constructor() {
    super('An export is already in progress')
    this.name = 'ExportInProgressError'
  }
}

// One zip at a time on the host. Two large exports OOM a 1 GB box.
let hostExportBusy = false

function beginHostExport(): void {
  if (hostExportBusy) throw new ExportInProgressError()
  hostExportBusy = true
}

function endHostExport(): void {
  hostExportBusy = false
}

export function resetHostExportLockForTests(): void {
  hostExportBusy = false
}

export function isHostExportBusy(): boolean {
  return hostExportBusy
}

async function withHostExportLock<T>(fn: () => Promise<T>): Promise<T> {
  beginHostExport()
  try {
    return await fn()
  } catch (err) {
    endHostExport()
    throw err
  }
}

/** Entries queued in archiver ahead of the one it is writing: enough to keep it busy, few enough to bound open files. */
const ZIP_APPEND_WINDOW = 4

// Queue files into an archiver and return it immediately so the HTTP response
// can start flushing. zlibLevel is per-call: full export uses 1, templates stay at 9.
//
// `addFiles` receives `add`, which opens one workspace file through the actor
// and appends it. archiver starts reading a source the moment it is appended,
// so `add` waits for the queue to drain below a small window before opening
// the next file: a ten-thousand-file workspace never has ten thousand files
// open at once.
function createWorkspaceZipStream(
  files: FileOps,
  addFiles: (add: (workspacePath: string) => Promise<void>) => Promise<void>,
  signal: AbortSignal | undefined,
  zlibLevel: number,
): Readable {
  let released = false
  const release = () => {
    if (released) return
    released = true
    endHostExport()
  }

  const archive = archiver('zip', { zlib: { level: zlibLevel } })
  archive.once('close', release)

  const stopArchive = (err?: Error) => {
    if (archive.destroyed) return
    archive.abort()
    archive.destroy(err)
  }

  // Backpressure for `add`: how many appended entries archiver has not
  // written yet, and a waiter for the next one it finishes. `add` is called
  // sequentially by the walk, so one waiter suffices.
  let inFlight = 0
  let stopped = false
  let wake: (() => void) | undefined
  const notify = () => {
    const resume = wake
    wake = undefined
    resume?.()
  }
  const stopAppending = () => {
    stopped = true
    notify()
  }
  archive.on('entry', () => {
    inFlight -= 1
    notify()
  })
  archive.once('close', stopAppending)

  // on(), not once(): a workspace that changes under the walk (agent deleted
  // mid-export) can make archiver emit one error per queued entry, and the
  // first listener would be the only one. Zero listeners on the second error
  // is an uncaughtException, which quits the app. release() is idempotent,
  // and stopArchive() is a no-op once the archive is destroyed. A source
  // stream that fails mid-read surfaces here too; archiver would otherwise
  // carry on and finalize a valid-looking but INCOMPLETE zip.
  archive.on('error', (err) => {
    release()
    stopAppending()
    stopArchive(err)
  })

  // A warning is what archiver emits when it drops an entry on its own (a
  // path it could not lstat). Every entry here is a stream `add` opened
  // itself, so a warning always means something was silently dropped —
  // escalate it to a stream error.
  archive.on('warning', (warning) => {
    stopArchive(warning)
    release()
  })

  // destroy() alone — a caller tearing the stream down without the request
  // abort signal firing — only destroys the Transform; archiver keeps its
  // queued entries and in-flight worker reading source files. Bridge the
  // post-destroy 'close' event to archiver's own abort(), which drains the
  // work queues. abort() is a no-op once the archive finalized normally or
  // was already aborted.
  archive.on('close', () => {
    archive.abort()
  })

  const add = async (workspacePath: string): Promise<void> => {
    while (inFlight >= ZIP_APPEND_WINDOW && !stopped) {
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
    if (stopped || signal?.aborted) return
    // Enumerated a moment ago; gone now means the workspace changed under the
    // export. Fail the stream rather than finalize a zip missing the file.
    const stat = await files.stat(workspacePath)
    if (!stat || stat.kind !== 'file') throw new WorkspaceFileError('not-found', `${workspacePath}: File not found`)
    const body = await files.read(workspacePath)
    if (stopped) {
      await body.cancel().catch(() => undefined)
      return
    }
    inFlight += 1
    archive.append(Readable.fromWeb(body as import('stream/web').ReadableStream<Uint8Array>), {
      name: workspacePath,
      date: new Date(stat.mtimeMs),
    })
  }

  const onAbort = () => {
    release()
    stopArchive()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  void (async () => {
    try {
      if (signal?.aborted) {
        onAbort()
        return
      }
      await addFiles(add)
      if (signal?.aborted || archive.destroyed) return
      await archive.finalize()
    } catch (err) {
      stopArchive(err instanceof Error ? err : new Error(String(err)))
      release()
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  })()

  return archive
}

export async function exportAgentTemplate(agentSlug: string, signal?: AbortSignal): Promise<Readable> {
  return withHostExportLock(async () => {
    if (!(await agentCatalog.exists(agentSlug))) {
      throw new Error('Agent workspace not found')
    }

    const actor = agentRegistry.get(agentSlug)
    const claudeMdContent = await actor.config.get('instructions')
    if (!claudeMdContent) {
      throw new Error('CLAUDE.md not found in agent workspace')
    }

    const templateFiles = await walkTemplateFiles(workspaceTree(actor.files))
    return createWorkspaceZipStream(actor.files, async (add) => {
      for (const workspacePath of templateFiles) {
        if (signal?.aborted) return
        await add(workspacePath)
      }
    }, signal, 9) // shareable .agent — size over host CPU
  })
}

export async function exportAgentFull(agentSlug: string, signal?: AbortSignal): Promise<Readable> {
  return withHostExportLock(async () => {
    if (!(await agentCatalog.exists(agentSlug))) {
      throw new Error('Agent workspace not found')
    }

    const { files } = agentRegistry.get(agentSlug)
    return createWorkspaceZipStream(
      files,
      (add) => walkFullExportFiles(files, add, signal),
      signal,
      1, // large workspaces — level 9 pegs 0.5 vCPU hosts
    )
  })
}

// ============================================================================
// ZIP Validation
// ============================================================================

/**
 * ZIP input for validation/import: either raw bytes, or a path to a ZIP
 * already on disk. Prefer the file form when available — it reads entries on
 * demand instead of pinning the whole (up to 500MB) buffer in memory for the
 * entire extraction.
 */
export type TemplateZipSource = Buffer | { filePath: string }

function openZipSource(zip: TemplateZipSource): Promise<ZipReader> {
  return Buffer.isBuffer(zip) ? openZipFromBuffer(zip) : openZipFromFile(zip.filePath)
}

export interface TemplateValidationResult {
  valid: boolean
  error?: string
  agentName?: string
  fileCount: number
  /** Detected wrapper directory prefix to strip during import */
  stripPrefix: string
}

/**
 * Validate ZIP entry metadata without extracting file contents.
 * Checks file count, declared uncompressed size, and path traversal.
 */
export function validateTemplateEntries(
  entries: ZipEntryMeta[],
  mode: 'template' | 'full',
): Omit<TemplateValidationResult, 'agentName'> {
  const realEntries = entries.filter((e) => {
    if (e.fileName.startsWith('__MACOSX/')) return false
    if (mode === 'template') {
      const parts = e.fileName.split('/')
      if (parts.some((p) => TEMPLATE_EXCLUDE.has(p))) return false
      if (!e.isDirectory && TEMPLATE_EXCLUDE_EXTENSIONS.has(path.extname(e.fileName))) return false
    }
    return true
  })

  if (realEntries.length > MAX_FILE_COUNT) {
    return { valid: false, error: `Too many files (${realEntries.length}, max ${MAX_FILE_COUNT})`, fileCount: realEntries.length, stripPrefix: '' }
  }

  let totalSize = 0
  for (const entry of realEntries) {
    totalSize += entry.uncompressedSize
    if (totalSize > MAX_UNCOMPRESSED_SIZE) {
      return { valid: false, error: `Template too large (exceeds ${MAX_UNCOMPRESSED_SIZE / 1024 / 1024}MB)`, fileCount: realEntries.length, stripPrefix: '' }
    }
  }

  for (const entry of realEntries) {
    if (entry.fileName.split('/').includes('..') || path.isAbsolute(entry.fileName)) {
      return { valid: false, error: `Invalid path in template: ${entry.fileName}`, fileCount: realEntries.length, stripPrefix: '' }
    }
  }

  const stripPrefix = detectZipPrefix(entries)

  const claudeMdEntry = realEntries.find((e) => {
    const name = stripPrefix ? e.fileName.replace(stripPrefix, '') : e.fileName
    const normalized = name.replace(/^\.\//, '')
    return normalized === 'CLAUDE.md'
  })
  if (!claudeMdEntry) {
    return { valid: false, error: 'CLAUDE.md not found in template', fileCount: realEntries.length, stripPrefix }
  }

  return { valid: true, fileCount: realEntries.length, stripPrefix }
}

/**
 * Validate a ZIP buffer as an agent template.
 * Handles ZIPs with or without a wrapper directory (e.g., from macOS Finder).
 * In 'full' mode, only __MACOSX entries are filtered — all other entries count
 * toward size/count limits and are checked for path traversal.
 */
export async function validateAgentTemplate(zip: TemplateZipSource, mode: 'template' | 'full' = 'template'): Promise<TemplateValidationResult> {
  let reader: ZipReader | undefined
  try {
    reader = await openZipSource(zip)

    const result = validateTemplateEntries(reader.entries, mode)
    if (!result.valid) return { ...result, agentName: undefined }

    const claudeMdFileName = reader.entries.find((e) => {
      const name = result.stripPrefix ? e.fileName.replace(result.stripPrefix, '') : e.fileName
      return name.replace(/^\.\//, '') === 'CLAUDE.md'
    })!.fileName

    const claudeMdBuf = await reader.readEntry(claudeMdFileName)
    const { frontmatter } = parseMarkdownWithFrontmatter<AgentFrontmatter>(claudeMdBuf.toString('utf-8'))
    const agentName = frontmatter.name || undefined

    return { valid: true, agentName, fileCount: result.fileCount, stripPrefix: result.stripPrefix }
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Failed to read ZIP file',
      fileCount: 0,
      stripPrefix: '',
    }
  } finally {
    reader?.close()
  }
}

// ============================================================================
// ZIP Import
// ============================================================================

/**
 * Import an agent from a ZIP template buffer.
 * Creates a new agent with the template contents.
 */
export async function importAgentFromTemplate(
  zip: TemplateZipSource,
  nameOverride?: string,
  mode: 'template' | 'full' = 'template',
): Promise<ApiAgent> {
  const reader = await openZipSource(zip)
  try {
    const validation = validateTemplateEntries(reader.entries, mode)
    if (!validation.valid) {
      throw new Error(validation.error || 'Invalid template')
    }

    // Read CLAUDE.md to extract agent name
    const claudeMdFileName = reader.entries.find((e) => {
      const name = validation.stripPrefix ? e.fileName.replace(validation.stripPrefix, '') : e.fileName
      return name.replace(/^\.\//, '') === 'CLAUDE.md'
    })!.fileName
    const claudeMdBuf = await reader.readEntry(claudeMdFileName)
    const { frontmatter } = parseMarkdownWithFrontmatter<AgentFrontmatter>(claudeMdBuf.toString('utf-8'))
    const agentName = frontmatter.name || undefined

    const effectiveName = nameOverride?.trim() || agentName

    const agent = await createAgentFromExistingWorkspace(effectiveName || 'Imported Agent')
    const actor = agentRegistry.get(agent.slug)

    const stripPrefix = validation.stripPrefix
    let totalExtracted = 0
    for (const entry of reader.entries) {
      if (entry.isDirectory) continue
      if (entry.fileName.startsWith('__MACOSX/')) continue

      let entryName = stripPrefix
        ? entry.fileName.replace(stripPrefix, '')
        : entry.fileName
      entryName = entryName.replace(/^\.\//, '')

      if (!entryName) continue

      if (mode === 'template') {
        const entryParts = entry.fileName.split('/')
        if (entryParts.some((p) => TEMPLATE_EXCLUDE.has(p))) continue
        if (TEMPLATE_EXCLUDE_EXTENSIONS.has(path.extname(entry.fileName))) continue

        const baseName = path.basename(entryName)
        if (baseName === '.env' || baseName === 'session-metadata.json') continue
      }

      const bytes = await reader.readEntry(entry.fileName, MAX_UNCOMPRESSED_SIZE - totalExtracted)
      try {
        await actor.files.write(entryName, bytes)
      } catch (error) {
        // validateTemplateEntries already rejects `..`/absolute entries
        // upfront; the actor refuses anything else that would land outside
        // the workspace, and such an entry is skipped as before.
        if (error instanceof WorkspaceFileError && (error.code === 'invalid-path' || error.code === 'outside-workspace')) {
          continue
        }
        throw error
      }
      totalExtracted += bytes.length
    }

    if (nameOverride?.trim()) {
      let content = await actor.config.get('instructions')
      if (content) {
        content = content.replace(
          /^(---\s*\n[\s\S]*?)(name:\s*).+$/m,
          `$1$2${nameOverride.trim()}`
        )
        await actor.config.put('instructions', content)
      }
    }

    const result = await getAgentWithStatus(agent.slug)
    return result || agent
  } finally {
    reader.close()
  }
}

// ============================================================================
// Skillset Integration - Install
// ============================================================================

/**
 * Install an agent from a skillset repository.
 * Copies the agent template directory into a new agent workspace.
 */
export async function installAgentFromSkillset(
  skillsetRef: SkillsetRef,
  agentPath: string,
  agentName: string,
  agentVersion: string,
): Promise<ApiAgent> {
  const repoDir = getSkillsetRepoDirForRef(skillsetRef)
  if (!(await isCacheReady(repoDir, skillsetRef.provider))) {
    await ensureSkillsetCached(skillsetRef)
  }

  // The agent path in the repo (e.g., "agents/research-assistant/")
  const agentDirInRepo = path.join(repoDir, agentPath.replace(/\/$/, ''))

  if (!(await directoryExists(agentDirInRepo))) {
    throw new Error(`Agent directory not found in skillset: ${agentPath}`)
  }

  // Create a new agent
  const agent = await createAgentFromExistingWorkspace(agentName)
  const actor = agentRegistry.get(agent.slug)

  // Copy template files from repo to workspace
  await copyHostDirIntoWorkspace(actor.files, agentDirInRepo, '', { followSymlinks: true })

  // The template's CLAUDE.md overwrites the one createAgentFromExistingWorkspace
  // wrote, so patch the frontmatter name and createdAt to the install time.
  const claudeMdContent = await actor.config.get('instructions')
  if (claudeMdContent) {
    const { frontmatter, body } = parseMarkdownWithFrontmatter<AgentFrontmatter>(claudeMdContent)
    frontmatter.name = agentName
    frontmatter.createdAt = agent.createdAt.toISOString()
    await actor.config.put('instructions', serializeMarkdownWithFrontmatter(frontmatter, body))
  }

  // Compute hash of template files
  const hash = await computeWorkspaceTemplateHash(actor.files)

  // Write agent metadata
  const metadata: InstalledAgentMetadata = {
    skillsetId: skillsetRef.skillsetId,
    skillsetUrl: skillsetRef.skillsetUrl,
    agentName,
    agentPath,
    installedVersion: agentVersion,
    installedAt: new Date().toISOString(),
    originalContentHash: hash,
    provider: skillsetRef.provider,
    providerData: skillsetRef.providerData,
    skillsetName: skillsetRef.skillsetName,
  }

  await putInstalledAgentMetadata(actor, metadata)

  // Re-read the agent
  const result = await getAgentWithStatus(agent.slug)
  return result || agent
}

// ============================================================================
// Skillset Integration - Update
// ============================================================================

/**
 * Update an installed agent from its skillset.
 * Re-copies template files, preserving .env, sessions, and uploads.
 */
export async function updateAgentFromSkillset(
  agentSlug: string,
): Promise<{ updated: boolean }> {
  const meta = await getInstalledAgentMetadata(agentSlug)
  if (!meta) {
    return { updated: false }
  }

  const skillsetRef = toSkillsetRefFromMeta(meta)

  await refreshSkillset(skillsetRef)

  // Re-read the index to get the latest version
  const index = await getSkillsetIndex(skillsetRef)
  if (!index || !index.agents) return { updated: false }

  const agentEntry = index.agents.find((a) => a.path === meta.agentPath)
  if (!agentEntry) return { updated: false }

  const repoDir = getSkillsetRepoDirForRef(skillsetRef)
  const agentDirInRepo = path.join(repoDir, meta.agentPath.replace(/\/$/, ''))

  if (!(await directoryExists(agentDirInRepo))) {
    return { updated: false }
  }

  const actor = agentRegistry.get(agentSlug)

  // Walk the template source and copy files, preserving .env/session-metadata
  await copyTemplateFiles(agentDirInRepo, actor.files)

  // Recompute hash
  const hash = await computeWorkspaceTemplateHash(actor.files)

  // Update metadata
  const updatedMeta: InstalledAgentMetadata = {
    ...meta,
    installedVersion: agentEntry.version,
    installedAt: new Date().toISOString(),
    originalContentHash: hash,
    openPrUrl: undefined,
  }

  await putInstalledAgentMetadata(actor, updatedMeta)

  return { updated: true }
}

/** Copy a template directory of the skillset cache into the workspace, leaving the agent's own metadata alone. */
async function copyTemplateFiles(src: string, files: FileOps): Promise<void> {
  return copyHostDirIntoWorkspace(files, src, '', { exclude: [SKILLSET_METADATA_PATH], followSymlinks: true })
}

// ============================================================================
// Metadata & Status
// ============================================================================

/**
 * Read installed agent metadata from .skillset-agent-metadata.json.
 *
 * Lazy-cleanup backstop: if the provider reports this template is no longer
 * valid for the current auth (e.g. a platform template from a previous org),
 * the metadata file is removed and we return null so the agent reverts to
 * looking "local".
 */
export async function getInstalledAgentMetadata(
  agentSlug: string,
): Promise<InstalledAgentMetadata | null> {
  const actor = agentRegistry.get(agentSlug)

  let meta: InstalledAgentMetadata | null
  try {
    meta = (await actor.config.get('skillsetMetadata')) as InstalledAgentMetadata | null
  } catch (error) {
    // A metadata file that is not JSON, or does not fit its schema, reads as
    // "not installed" — the agent shows as local rather than failing.
    if (!(error instanceof ConfigDocError)) throw error
    captureException(error, { tags: { area: 'agent-template-metadata', op: 'decode' }, extra: { agentSlug } })
    return null
  }
  if (!meta) return null

  const pruned = await pruneInstalledTemplateIfInvalid(meta, actor.files, SKILLSET_METADATA_PATH)
  if (pruned) return null

  return meta
}

/** Workspace path of the onboarding skill. */
const ONBOARDING_SKILL_PATH = '.claude/skills/agent-onboarding/SKILL.md'

/**
 * Probe the onboarding skill (`.claude/skills/agent-onboarding/SKILL.md`).
 * `firstPrompt` is the optional `first_prompt` frontmatter field.
 */
export async function hasOnboardingSkill(agentSlug: string): Promise<{
  hasOnboarding: boolean
  firstPrompt?: string
}> {
  const { files } = agentRegistry.get(agentSlug)
  try {
    const stat = await files.stat(ONBOARDING_SKILL_PATH)
    if (!stat || stat.kind !== 'file') return { hasOnboarding: false }
    if (stat.size === 0) return { hasOnboarding: true }

    // Frontmatter is at the top. Do not load a 500MB skill body into the heap:
    // read only the leading bytes.
    const readLen = Math.min(stat.size, ONBOARDING_SKILL_READ_LIMIT)
    const head = await readStreamToBuffer(await files.read(ONBOARDING_SKILL_PATH, { start: 0, end: readLen - 1 }))
    const firstPrompt = onboardingFirstPromptFromValue(
      parseMarkdownWithFrontmatter(head.toString('utf8')).frontmatter.first_prompt,
    )
    return firstPrompt ? { hasOnboarding: true, firstPrompt } : { hasOnboarding: true }
  } catch {
    return { hasOnboarding: false }
  }
}

/** Flat YAML turns `first_prompt: |` into the string `|`. That is not a kickoff. */
const YAML_BLOCK_SCALAR_MARKER = /^[|>][-+]?$/

function onboardingFirstPromptFromValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_TEMPLATE_PROMPT_SIZE) return undefined
  if (YAML_BLOCK_SCALAR_MARKER.test(trimmed)) return undefined
  return trimmed
}

/**
 * Read the optional prompt handoff supplied by an installed template.
 * Empty, oversized, non-file, and unreadable candidates are treated as absent
 * so this best-effort probe can never fail an otherwise successful install.
 */
export async function getAgentTemplatePrompt(agentSlug: string): Promise<string | undefined> {
  const { files } = agentRegistry.get(agentSlug)
  for (const fileName of TEMPLATE_PROMPT_FILE_NAMES) {
    try {
      const stat = await files.stat(fileName)
      if (!stat || stat.kind !== 'file' || stat.size === 0 || stat.size > MAX_TEMPLATE_PROMPT_SIZE) continue

      // Read only after the size check, and only the bytes the check saw.
      const prompt = (await readStreamToBuffer(await files.read(fileName, { start: 0, end: stat.size - 1 })))
        .toString('utf8')
        .trim()
      if (prompt) return prompt
    } catch {
      // PROMPT.md is an optional handoff. Storage errors must not strand an
      // agent after its workspace and owner ACL have already been created.
    }
  }
  return undefined
}

/**
 * Get the template status of an agent.
 *
 * READ-ONLY: mirrors the skill path — no git ops, no metadata writes, no
 * file copies. Pending queue items are checked and surfaced optimistically,
 * but the actual transition to merged/rejected state (with file adoption) is
 * deferred to `refreshAgentTemplates`.
 */
export async function getAgentTemplateStatus(
  agentSlug: string,
  skillsets: SkillsetConfig[],
): Promise<AgentTemplateStatus> {
  const meta = await getInstalledAgentMetadata(agentSlug)
  if (!meta) {
    return { type: 'local' }
  }

  const skillsetConfig = skillsets.find((s) => s.id === meta.skillsetId)
  if (!skillsetConfig) {
    return { type: 'local' }
  }
  const metaRef = toSkillsetRefFromMeta(meta)
  const configRef = toSkillsetRefFromConfig(skillsetConfig)
  const hostingProvider = getSkillsetProvider(meta.provider)
  const info = hostingProvider.getSourceInfo(metaRef, skillsetConfig)
  const skillsetName = info.skillsetName
  const sourceLabel = info.sourceLabel
  const { files } = agentRegistry.get(agentSlug)

  // Queue status — single request, surfaces as optimistic "up_to_date" while
  // the actual file adoption waits for refreshAgentTemplates.
  let pendingTerminal = false
  if (meta.pendingQueueItemId) {
    try {
      const s = await hostingProvider.getQueueItemStatus(meta.pendingQueueItemId)
      pendingTerminal = s === 'merged' || s === 'rejected'
    } catch (error) {
      captureException(error, { tags: { area: 'agent-template-status', op: 'queue-lookup' }, extra: { agentSlug } })
    }
  }

  const currentHash = await computeWorkspaceTemplateHash(files)

  if (!pendingTerminal && (currentHash !== meta.originalContentHash || meta.openPrUrl)) {
    return { type: 'locally_modified', skillsetId: meta.skillsetId, skillsetName, sourceLabel, openPrUrl: meta.openPrUrl }
  }

  const index = await getSkillsetIndex(metaRef)
  const agentEntry = index?.agents?.find((a) => a.path === meta.agentPath)
  const versionChanged = !!(agentEntry && agentEntry.version !== meta.installedVersion)

  const repoDir = getSkillsetRepoDirForRef(configRef ?? metaRef)
  const agentDirInRepo = path.join(repoDir, meta.agentPath.replace(/\/$/, ''))
  let contentChanged = false
  if (await directoryExists(agentDirInRepo)) {
    const remoteCacheHash = await computeAgentTemplateHash(agentDirInRepo)
    contentChanged = remoteCacheHash !== meta.originalContentHash
  }

  if (!pendingTerminal && (versionChanged || contentChanged)) {
    return {
      type: 'update_available',
      skillsetId: meta.skillsetId,
      skillsetName,
      sourceLabel,
      latestVersion: versionChanged ? agentEntry!.version : undefined,
    }
  }

  return { type: 'up_to_date', skillsetId: meta.skillsetId, skillsetName, sourceLabel }
}

/**
 * Compute SHA-256 hash of all template-eligible files in a directory on this
 * machine — a template in the skillset cache.
 */
export async function computeAgentTemplateHash(hostDir: string): Promise<string> {
  return computeTemplateHash(hostTree(hostDir))
}

/** The same digest over an agent's workspace, so the two compare. */
export async function computeWorkspaceTemplateHash(files: FileOps): Promise<string> {
  return computeTemplateHash(workspaceTree(files))
}

async function computeTemplateHash(tree: TemplateTree): Promise<string> {
  const files = await walkTemplateFiles(tree)
  files.sort() // Ensure deterministic order

  const limit = pLimit(8)
  const contents = new Map<string, string>()
  await Promise.all(files.map((relativePath) => limit(async () => {
    try {
      const bytes = await tree.read(relativePath)
      if (bytes !== null) contents.set(relativePath, bytesToUtf8(bytes))
    } catch {
      // Skip unreadable files
    }
  })))

  const hash = crypto.createHash('sha256')
  for (const relativePath of files) {
    const content = contents.get(relativePath)
    if (content === undefined) continue
    hash.update(relativePath)
    hash.update(content)
  }

  return hash.digest('hex')
}

function updateAgentFrontmatterVersion(content: string, newVersion: string): string {
  const parsed = parseMarkdownWithFrontmatter<Record<string, unknown>>(content)
  return serializeMarkdownWithFrontmatter(
    { ...parsed.frontmatter, version: newVersion },
    parsed.body
  )
}

async function collectAgentFilesForPlatform(
  files: FileOps,
  agentPathInRepo: string,
  options?: { claudeMdContent?: string },
): Promise<Array<{ path: string; content: string }>> {
  const templateFiles = await walkTemplateFiles(workspaceTree(files))
  const normalizedRoot = agentPathInRepo.replace(/\/$/, '')

  return await Promise.all(templateFiles.map(async (workspacePath) => {
    const repoPath = `${normalizedRoot}/${workspacePath}`
    if (workspacePath === 'CLAUDE.md' && options?.claudeMdContent !== undefined) {
      return { path: repoPath, content: options.claudeMdContent }
    }

    const bytes = await files.getDoc(workspacePath)
    if (bytes === null) throw new WorkspaceFileError('not-found', `${workspacePath}: File not found`)
    return { path: repoPath, content: bytesToUtf8(bytes) }
  }))
}

// ============================================================================
// Discoverable Agents
// ============================================================================

/**
 * Get all agents from configured skillsets.
 * Reads from local cache only (fast). Use refreshSkillsetCaches() to update caches first.
 */
export async function getDiscoverableAgents(
  skillsets: SkillsetConfig[],
): Promise<DiscoverableAgent[]> {
  const discoverable: DiscoverableAgent[] = []

  for (const ss of skillsets) {
    const index = await getSkillsetIndex(toSkillsetRefFromConfig(ss))
    if (!index || !index.agents) continue

    for (const agent of index.agents) {
      discoverable.push({
        skillsetId: ss.id,
        skillsetName: ss.name,
        name: agent.name,
        description: agent.description,
        version: agent.version,
        path: agent.path,
        // `works_with` is snake_case in index.json; the rest pass through as-is.
        details: agent.details,
        category: agent.category,
        icon: agent.icon,
        tags: agent.tags,
        worksWith: agent.works_with,
        developer: agent.developer,
      })
    }
  }

  return discoverable.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Refresh all skillset caches (git pull). Returns when complete.
 */
export async function refreshSkillsetCaches(
  skillsets: SkillsetConfig[],
): Promise<void> {
  await Promise.all(
    skillsets.map(async (ss) => {
      const ssRef = toSkillsetRefFromConfig(ss)
      try {
        await ensureSkillsetCached(ssRef)
        await refreshSkillset(ssRef)
      } catch {
        // Skip failed skillsets
      }
    })
  )
}

// ============================================================================
// Refresh
// ============================================================================

/**
 * Refresh all skillset caches and reconcile agent template status.
 *
 * This is the only place that mutates template metadata or copies files
 * back from the cache — the read path (`getAgentTemplateStatus`) is pure.
 */
export async function refreshAgentTemplates(
  skillsets: SkillsetConfig[],
): Promise<void> {
  for (const ss of skillsets) {
    try {
      await refreshSkillset(toSkillsetRefFromConfig(ss))
    } catch (error) {
      console.warn(`Failed to refresh skillset ${ss.id}:`, error)
      captureException(error, { tags: { area: 'template-refresh', op: 'pull' }, extra: { skillsetId: ss.id } })
    }
  }

  const agents = await listAgents()

  // Coalesce queue lookups by provider — one batch per provider instead of
  // one fetch per installed template.
  const metaByAgent = new Map<string, InstalledAgentMetadata>()
  const pendingByProvider = new Map<SkillProvider, string[]>()
  for (const agent of agents) {
    const meta = await getInstalledAgentMetadata(agent.slug)
    if (!meta) continue
    metaByAgent.set(agent.slug, meta)
    if (meta.pendingQueueItemId) {
      const p = (meta.provider ?? 'github') as SkillProvider
      const list = pendingByProvider.get(p) ?? []
      list.push(meta.pendingQueueItemId)
      pendingByProvider.set(p, list)
    }
  }

  const queueStatuses = new Map<string, string | null>()
  await Promise.all(Array.from(pendingByProvider.entries()).map(async ([p, ids]) => {
    try {
      const statuses = await getSkillsetProvider(p).getQueueItemStatuses(ids)
      for (const [id, s] of statuses) queueStatuses.set(id, s)
    } catch (error) {
      captureException(error, { tags: { area: 'template-refresh', op: 'queue-batch' }, extra: { provider: p } })
    }
  }))

  for (const [slug, meta] of metaByAgent) {
    const actor = agentRegistry.get(slug)
    const repoDir = getSkillsetRepoDirForRef(toSkillsetRefFromMeta(meta))
    const agentDirInRepo = path.join(repoDir, meta.agentPath.replace(/\/$/, ''))

    // Step 1: resolve any pending platform submission.
    if (meta.pendingQueueItemId) {
      const s = queueStatuses.get(meta.pendingQueueItemId)
      if (s === 'merged' || s === 'rejected') {
        if (s === 'merged') {
          try {
            await refreshSkillset(toSkillsetRefFromMeta(meta))
          } catch (error) {
            captureException(error, { tags: { area: 'template-refresh', op: 'queue-merged-pull' }, extra: { agentSlug: slug } })
          }
          if (await directoryExists(agentDirInRepo)) {
            await copyTemplateFiles(agentDirInRepo, actor.files)
            meta.originalContentHash = await computeWorkspaceTemplateHash(actor.files)
          }
        }
        meta.pendingQueueItemId = undefined
        meta.openPrUrl = undefined
        await putInstalledAgentMetadata(actor, meta)
        continue
      }
    }

    if (!(await directoryExists(agentDirInRepo))) continue

    const currentHash = await computeWorkspaceTemplateHash(actor.files)
    const repoHash = await computeAgentTemplateHash(agentDirInRepo)

    // Local matches remote — clear any stale PR link.
    if (repoHash === currentHash) {
      if (meta.openPrUrl || currentHash !== meta.originalContentHash) {
        meta.originalContentHash = currentHash
        meta.openPrUrl = undefined
        await putInstalledAgentMetadata(actor, meta)
      }
      continue
    }

    // Remote has moved forward with a PR open — adopt remote.
    if (meta.openPrUrl
        && currentHash !== meta.originalContentHash
        && repoHash !== meta.originalContentHash) {
      await copyTemplateFiles(agentDirInRepo, actor.files)
      meta.originalContentHash = repoHash
      meta.openPrUrl = undefined

      try {
        const index = await readIndexJson(repoDir)
        const agentEntry = index.agents?.find((a: { path: string }) => a.path === meta.agentPath)
        if (agentEntry?.version) {
          meta.installedVersion = agentEntry.version
        }
      } catch (error) {
        captureException(error, { tags: { area: 'template-refresh', op: 'read-index' }, extra: { agentSlug: slug } })
      }

      await putInstalledAgentMetadata(actor, meta)
    }
  }
}

// ============================================================================
// PR / Publish - AI Suggestions
// ============================================================================

async function generateAgentPRSuggestions(
  meta: InstalledAgentMetadata,
  agentSlug: string,
): Promise<{ suggestedTitle: string; suggestedBody: string; suggestedVersion: string }> {
  const fallback = {
    suggestedTitle: `Update ${meta.agentName} agent template`,
    suggestedBody: `Updated ${meta.agentName} agent template with local modifications.`,
    suggestedVersion: meta.installedVersion,
  }

  const modifiedContent = await agentRegistry.get(agentSlug).config.get('instructions')
  if (!modifiedContent) return fallback

  let client
  try {
    client = getConfiguredLlmClient()
  } catch {
    return fallback
  }

  try {
    const model = resolveActiveProviderModel(getEffectiveModels().summarizerModel, 'summarizer')

    const text = await createSummarizerText(client, {
      model,
      messages: [
        {
          role: 'user',
          content: `You are analyzing changes to an agent template. The agent is named "${meta.agentName}" and has been locally modified. Generate a PR title, description, and new SemVer version.

Current version: ${meta.installedVersion}

Modified CLAUDE.md:
\`\`\`
${modifiedContent}
\`\`\`

Rules for the version bump:
- PATCH (x.y.Z): bug fixes, typo corrections, minor wording tweaks
- MINOR (x.Y.0): new features, added capabilities, significant improvements
- MAJOR (X.0.0): breaking changes, fundamental restructuring`,
        },
      ],
      output_config: {
        format: {
          type: 'json_schema' as const,
          schema: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Concise imperative PR title' },
              body: { type: 'string', description: 'Markdown description of what changed' },
              version: { type: 'string', description: 'New SemVer version' },
            },
            required: ['title', 'body', 'version'],
            additionalProperties: false,
          },
        },
      },
    })
    if (!text) return fallback

    const parsed = JSON.parse(text)
    return {
      suggestedTitle: parsed.title || fallback.suggestedTitle,
      suggestedBody: parsed.body || fallback.suggestedBody,
      suggestedVersion: parsed.version || fallback.suggestedVersion,
    }
  } catch {
    return fallback
  }
}

async function generateAgentPublishSuggestions(
  claudeMdContent: string,
  agentName: string,
): Promise<{ suggestedTitle: string; suggestedBody: string; suggestedVersion: string }> {
  const fallback = {
    suggestedTitle: `Add ${agentName} agent template`,
    suggestedBody: `Adds the ${agentName} agent template.`,
    suggestedVersion: '1.0.0',
  }

  let client
  try {
    client = getConfiguredLlmClient()
  } catch {
    return fallback
  }

  try {
    const model = resolveActiveProviderModel(getEffectiveModels().summarizerModel, 'summarizer')

    const text = await createSummarizerText(client, {
      model,
      messages: [
        {
          role: 'user',
          content: `You are reviewing a new agent template (CLAUDE.md) being submitted to a shared skillset repository. Generate a PR title, description, and version.

Agent name: ${agentName}

CLAUDE.md content:
\`\`\`
${claudeMdContent}
\`\`\`

Generate:
- A concise, imperative PR title (e.g. "Add research assistant agent")
- A markdown description explaining what the agent does and its key capabilities
- The version to use (default "1.0.0" for new agents)`,
        },
      ],
      output_config: {
        format: {
          type: 'json_schema' as const,
          schema: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Concise imperative PR title' },
              body: { type: 'string', description: 'Markdown description of the agent' },
              version: { type: 'string', description: 'SemVer version' },
            },
            required: ['title', 'body', 'version'],
            additionalProperties: false,
          },
        },
      },
    })
    if (!text) return fallback

    const parsed = JSON.parse(text)
    return {
      suggestedTitle: parsed.title || fallback.suggestedTitle,
      suggestedBody: parsed.body || fallback.suggestedBody,
      suggestedVersion: parsed.version || fallback.suggestedVersion,
    }
  } catch {
    return fallback
  }
}

// ============================================================================
// PR Flow
// ============================================================================

/**
 * Get PR info with AI suggestions for a locally modified agent.
 */
export async function getAgentPRInfo(
  agentSlug: string,
): Promise<{
  agentName: string
  agentPath: string
  skillsetUrl: string
  suggestedTitle: string
  suggestedBody: string
  suggestedVersion: string
}> {
  const meta = await getInstalledAgentMetadata(agentSlug)
  if (!meta) {
    throw new Error('Agent has no skillset metadata - cannot create PR')
  }

  await getSkillsetProvider(meta.provider).ensurePublishPreconditions(toSkillsetRefFromMeta(meta))

  const suggestions = await generateAgentPRSuggestions(meta, agentSlug)

  return {
    agentName: meta.agentName,
    agentPath: meta.agentPath,
    skillsetUrl: meta.skillsetUrl,
    ...suggestions,
  }
}

/**
 * Create a PR for local modifications to an agent template.
 */
export async function createAgentPR(
  agentSlug: string,
  options: { title: string; body: string; newVersion?: string },
): Promise<{ prUrl?: string; successMessage: string }> {
  const meta = await getInstalledAgentMetadata(agentSlug)
  if (!meta) {
    throw new Error('Agent has no skillset metadata - cannot create PR')
  }

  const actor = agentRegistry.get(agentSlug)
  const claudeMdContent = await actor.config.get('instructions')
  if (!claudeMdContent) {
    throw new Error('CLAUDE.md not found')
  }
  const nextClaudeMdContent = options.newVersion
    ? updateAgentFrontmatterVersion(claudeMdContent, options.newVersion)
    : claudeMdContent
  const targetName = path.basename(meta.agentPath.replace(/\/$/, ''))

  const metaRef = toSkillsetRefFromMeta(meta)
  const hostingProvider = getSkillsetProvider(meta.provider)
  const repoDir = getSkillsetRepoDirForRef(metaRef)

  const files = await collectAgentFilesForPlatform(actor.files, meta.agentPath, {
    claudeMdContent: nextClaudeMdContent,
  })

  if (options.newVersion) {
    const index = await readIndexJson(repoDir)
    if (index.agents) {
      const agentEntry = index.agents.find((a) => a.path === meta.agentPath)
      if (agentEntry) {
        agentEntry.version = options.newVersion
        files.push({ path: 'index.json', content: JSON.stringify(index, null, 2) + '\n' })
      }
    }
  }

  const result = await hostingProvider.publishUpdate({
    repoDir,
    branchPrefix: `update-agent-${agentSlug}`,
    files,
    title: options.title,
    body: options.body,
    skillsetId: meta.skillsetId,
    skillsetUrl: meta.skillsetUrl,
    skillsetName: metaRef.skillsetName,
    providerData: metaRef.providerData,
    targetName,
    targetType: 'agent',
    message: options.body,
  })

  if (result.queueItem?.id && result.status !== 'merged') {
    meta.pendingQueueItemId = result.queueItem.id
  } else if (result.status === 'merged') {
    await refreshSkillset(metaRef)
    const agentDirInRepo = path.join(repoDir, meta.agentPath.replace(/\/$/, ''))
    if (await directoryExists(agentDirInRepo)) {
      await copyTemplateFiles(agentDirInRepo, actor.files)
    } else {
      await actor.config.put('instructions', nextClaudeMdContent)
    }
    meta.originalContentHash = await computeWorkspaceTemplateHash(actor.files)
    meta.pendingQueueItemId = undefined
  }

  if (result.prUrl) {
    meta.openPrUrl = result.prUrl
  }

  await putInstalledAgentMetadata(actor, meta)
  return { prUrl: result.prUrl, successMessage: result.successMessage }
}

// ============================================================================
// Publish Flow
// ============================================================================

/**
 * Get publish info with AI suggestions for a local agent.
 */
export async function getAgentPublishInfo(
  agentSlug: string,
  skillsetConfig: SkillsetConfig,
): Promise<{
  agentName: string
  skillsetUrl: string
  skillsetName: string
  suggestedTitle: string
  suggestedBody: string
  suggestedVersion: string
}> {
  // Verify agent is local (no metadata)
  const meta = await getInstalledAgentMetadata(agentSlug)
  if (meta) {
    throw new Error('Agent already belongs to a skillset - use Open PR instead')
  }

  const claudeMdContent = await agentRegistry.get(agentSlug).config.get('instructions')
  if (!claudeMdContent) {
    throw new Error('CLAUDE.md not found')
  }

  await getSkillsetProvider(skillsetConfig.provider).ensurePublishPreconditions(toSkillsetRefFromConfig(skillsetConfig))

  const { frontmatter } = parseMarkdownWithFrontmatter<AgentFrontmatter>(claudeMdContent)
  const agentName = frontmatter.name || agentSlug

  const suggestions = await generateAgentPublishSuggestions(claudeMdContent, agentName)

  return {
    agentName,
    skillsetUrl: skillsetConfig.url,
    skillsetName: skillsetConfig.name,
    ...suggestions,
  }
}

/**
 * Publish a local agent to a skillset repository via PR.
 */
export async function publishAgentToSkillset(
  agentSlug: string,
  skillsetConfig: SkillsetConfig,
  options: { title: string; body: string; newVersion?: string },
): Promise<{ prUrl?: string; successMessage: string }> {
  const actor = agentRegistry.get(agentSlug)
  let claudeMdContent = await actor.config.get('instructions')
  if (!claudeMdContent) {
    throw new Error('CLAUDE.md not found')
  }

  if (options.newVersion) {
    claudeMdContent = updateAgentFrontmatterVersion(claudeMdContent, options.newVersion)
  }

  const { frontmatter } = parseMarkdownWithFrontmatter<AgentFrontmatter>(claudeMdContent)
  const agentName = frontmatter.name || agentSlug
  const description = frontmatter.description || ''
  const version = options.newVersion || '1.0.0'

  // Slugify the agent name for the path
  const agentDirName = agentSlug
  const agentPathInRepo = `agents/${agentDirName}/`

  const skillsetRef = toSkillsetRefFromConfig(skillsetConfig)
  const repoDir = getSkillsetRepoDirForRef(skillsetRef)
  if (!(await isCacheReady(repoDir, skillsetRef.provider))) {
    await ensureSkillsetCached(skillsetRef)
  }

  const index = await readIndexJson(repoDir)
  const agents = index.agents || []
  const conflict = agents.find((a) => a.path === agentPathInRepo)
  if (conflict) {
    throw new Error(
      `An agent already exists at "${agentPathInRepo}" in this skillset.`
    )
  }

  const hostingProvider = getSkillsetProvider(skillsetConfig.provider)

  // Prepare agent template files + updated index.json
  const files = await collectAgentFilesForPlatform(actor.files, agentPathInRepo, {
    claudeMdContent,
  })
  if (!index.agents) {
    index.agents = []
  }
  index.agents.push({ name: agentName, path: agentPathInRepo, description, version })
  files.push({ path: 'index.json', content: JSON.stringify(index, null, 2) + '\n' })

  const result = await hostingProvider.publishUpdate({
    repoDir,
    branchPrefix: `add-agent-${agentDirName}`,
    files,
    title: options.title,
    body: options.body,
    skillsetId: skillsetConfig.id,
    skillsetUrl: skillsetConfig.url,
    skillsetName: skillsetConfig.name,
    providerData: skillsetRef.providerData,
    targetName: agentDirName,
    targetType: 'agent',
    message: options.body,
  })

  const metadata: InstalledAgentMetadata = {
    skillsetId: skillsetConfig.id,
    skillsetUrl: skillsetConfig.url,
    agentName,
    agentPath: agentPathInRepo,
    installedVersion: version,
    installedAt: new Date().toISOString(),
    originalContentHash: await computeWorkspaceTemplateHash(actor.files),
    provider: skillsetConfig.provider,
    providerData: skillsetRef.providerData,
    skillsetName: skillsetConfig.name,
  }

  if (result.queueItem?.id && result.status !== 'merged') {
    metadata.pendingQueueItemId = result.queueItem.id
  } else if (result.status === 'merged') {
    await refreshSkillset(skillsetRef)
    const repoDirAfter = getSkillsetRepoDirForRef(skillsetRef)
    const agentDirInRepo = path.join(repoDirAfter, agentPathInRepo.replace(/\/$/, ''))
    if (await directoryExists(agentDirInRepo)) {
      await copyTemplateFiles(agentDirInRepo, actor.files)
    } else {
      await actor.config.put('instructions', claudeMdContent)
    }
    metadata.originalContentHash = await computeWorkspaceTemplateHash(actor.files)
  }

  if (result.prUrl) {
    metadata.openPrUrl = result.prUrl
  }

  await putInstalledAgentMetadata(actor, metadata)
  return { prUrl: result.prUrl, successMessage: result.successMessage }
}
