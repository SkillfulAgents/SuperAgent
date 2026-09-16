import { createHash } from 'node:crypto'
import { load, JSON_SCHEMA } from 'js-yaml'
import type { FileOps } from '@shared/lib/agent-actor/types'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import type { AgentMemoryDocument, AgentMemoryEntry } from '@shared/lib/types/memory'

export const AGENT_MEMORY_DIR = '.claude/projects/-workspace/memory'
export const MAX_MEMORY_BYTES = 1024 * 1024

export class MemoryError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413) {
    super(message)
  }
}

function memoryPath(relative: string): string {
  if (!relative || relative.includes('\\') || relative.includes('\0') ||
      relative.split('/').some(part => !part || part === '.' || part === '..') ||
      !relative.toLowerCase().endsWith('.md')) {
    throw new MemoryError('Invalid memory path', 400)
  }
  return `${AGENT_MEMORY_DIR}/${relative}`
}

// Resolve through the actor too: reject redirects to other workspace content.
// All paths remain logical workspace paths; no host filesystem access.
async function resolveMemoryPath(files: FileOps, target: string): Promise<string | null> {
  const resolved = await files.resolve(target)
  if (resolved !== null && resolved !== target) throw new MemoryError('Invalid memory path', 400)
  return resolved
}

function describeMemory(relative: string, content: string): Omit<AgentMemoryDocument, 'revision'> {
  const isIndex = relative === 'MEMORY.md'
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  let metadata: Record<string, unknown> = {}
  let body = content
  if (match) {
    try {
      const parsed = load(match[1], { schema: JSON_SCHEMA })
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>
        body = content.slice(match[0].length)
      }
    } catch {
      // Malformed frontmatter remains readable and editable as raw text.
    }
  }
  const nested = metadata.metadata as Record<string, unknown> | undefined
  const type = nested?.type ?? metadata.type
  return {
    path: relative,
    title: isIndex ? 'Memory index' : typeof metadata.name === 'string' ? metadata.name : relative,
    description: isIndex ? 'The index the agent uses to find its memories.' : typeof metadata.description === 'string' ? metadata.description : '',
    ...(typeof type === 'string' ? { type } : {}),
    isIndex, content, body,
  }
}

export async function readAgentMemory(files: FileOps, relative: string): Promise<AgentMemoryDocument> {
  const target = await resolveMemoryPath(files, memoryPath(relative))
  if (!target) throw new MemoryError('Memory not found', 404)
  const stat = await files.stat(target)
  if (!stat || stat.kind !== 'file') throw new MemoryError('Memory not found', 404)
  if (stat.size > MAX_MEMORY_BYTES) throw new MemoryError('This memory is too large to edit (maximum 1 MB).', 413)
  // A bounded handle read supports empty files and short reads across stores.
  const handle = await files.open(target)
  let bytes: Uint8Array
  try {
    bytes = await handle.readAt(0, MAX_MEMORY_BYTES + 1)
  } finally {
    await handle.close()
  }
  if (bytes.byteLength > MAX_MEMORY_BYTES) throw new MemoryError('This memory is too large to edit (maximum 1 MB).', 413)
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new MemoryError('This memory is not a UTF-8 text file.', 400)
  }
  return { ...describeMemory(relative, content), revision: createHash('sha256').update(bytes).digest('hex') }
}

export async function listAgentMemories(files: FileOps): Promise<AgentMemoryEntry[]> {
  const root = await resolveMemoryPath(files, AGENT_MEMORY_DIR)
  if (!root) return []
  const result: AgentMemoryEntry[] = []
  async function visit(dir: string): Promise<void> {
    for (const entry of await files.list(dir)) {
      if (entry.kind === 'directory') {
        if (await resolveMemoryPath(files, entry.path)) await visit(entry.path)
      } else if (entry.name.toLowerCase().endsWith('.md')) {
        const relative = entry.path.slice(AGENT_MEMORY_DIR.length + 1)
        try {
          const doc = await readAgentMemory(files, relative)
          result.push({ path: doc.path, title: doc.title, description: doc.description, type: doc.type, isIndex: doc.isIndex })
        } catch (error) {
          if ((error instanceof MemoryError && error.status === 404) ||
              (error instanceof WorkspaceFileError && error.code === 'not-found')) continue
          if (error instanceof MemoryError && error.status === 413) {
            result.push({ path: relative, title: relative, description: error.message, isIndex: relative === 'MEMORY.md' })
          } else throw error
        }
      }
    }
  }
  await visit(root)
  return result.sort((a, b) => Number(b.isIndex) - Number(a.isIndex) || a.title.localeCompare(b.title))
}

// Serialize API saves per actor file store. FileOps has no compare-and-swap:
// external writers can still race the final revision check/atomic putDoc.
const pendingSaves = new WeakMap<FileOps, Promise<unknown>>()

export async function saveAgentMemory(files: FileOps, relative: string, content: string, revision: string): Promise<AgentMemoryDocument> {
  if (Buffer.byteLength(content, 'utf8') > MAX_MEMORY_BYTES) throw new MemoryError('This memory is too large to save (maximum 1 MB).', 413)
  const previous = pendingSaves.get(files) ?? Promise.resolve()
  const save = previous.catch(() => {}).then(async () => {
    const current = await readAgentMemory(files, relative)
    if (current.revision !== revision) throw new MemoryError('This memory changed since you opened it. Your draft has been kept. Reload the latest version before saving.', 409)
    if (!await resolveMemoryPath(files, memoryPath(relative))) throw new MemoryError('Memory not found', 404)
    await files.putDoc(memoryPath(relative), content)
    return { ...describeMemory(relative, content), revision: createHash('sha256').update(content).digest('hex') }
  })
  pendingSaves.set(files, save)
  try {
    return await save
  } finally {
    if (pendingSaves.get(files) === save) pendingSaves.delete(files)
  }
}
