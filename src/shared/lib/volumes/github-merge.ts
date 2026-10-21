import { diff3Merge } from 'node-diff3'

/** Raw bytes per commit: createCommitOnBranch accepted about 730 KB of file content in one request. */
export const GITHUB_PUSH_BYTES = 700_000

/** The label tells an agent reading the file how to resolve it, and marks the file as never pushed. */
export const markerLabel = (commit: string) => `>>>>>>> GitHub ${commit.slice(0, 12)} (remove these markers to sync this file)`
const MARKER = /^\s*>>>>>>> GitHub [0-9a-f]{7,40} /m

function equal(a: Buffer | null, b: Buffer | null): boolean {
  return a === null ? b === null : b !== null && a.equals(b)
}

function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true } catch { return false }
}

/** Three-way merge of one path, where null is a deleted file. */
export function mergePath(base: Buffer | null, local: Buffer | null, remote: Buffer | null, commit: string): {
  content: Buffer | null; conflict?: string
} {
  if (equal(local, remote) || equal(remote, base)) return { content: local }
  if (equal(local, base)) return { content: remote }
  if (local === null) return { content: remote, conflict: 'edited on GitHub, deleted here' }
  if (remote === null) return { content: local, conflict: 'deleted on GitHub, edited here' }
  if (![base ?? Buffer.alloc(0), local, remote].every(isText)) return { content: local, conflict: 'changed on GitHub too' }
  const lines = (value: Buffer) => value.toString('utf8').match(/[^\n]*\n|[^\n]+$/g) ?? []
  const end = (value: string[]) => value.length ? value.join('').replace(/\n?$/, '\n') : ''
  let conflict = false
  const text = diff3Merge(lines(local), lines(base ?? Buffer.alloc(0)), lines(remote)).map(part => {
    if (!part.conflict) return part.ok?.join('') ?? ''
    conflict = true
    return `<<<<<<< Agent's version\n${end(part.conflict.a)}=======\n${end(part.conflict.b)}${markerLabel(commit)}\n`
  }).join('')
  return { content: Buffer.from(text), ...(conflict ? { conflict: 'conflict markers to resolve' } : {}) }
}

export interface PushChange {
  path: string
  contents: Buffer | null
  mode: string
  group?: string
  held?: string
}

function holdReason(change: PushChange): string | null {
  if (change.held) return change.held
  if (change.contents && MARKER.test(change.contents.toString('utf8'))) return 'conflict markers to resolve'
  if (change.path === '.github/workflows' || change.path.startsWith('.github/workflows/')) return 'under .github/workflows'
  return null
}

/** Splits changes into commits under the request limit. A move's two sides travel together, and a hold on either side holds both. */
export function planPush(changes: PushChange[]): { batches: PushChange[][]; held: Map<string, string> } {
  const groups = Map.groupBy(changes, change => change.group ?? change.path)
  const batches: PushChange[][] = [[]]
  const held = new Map<string, string>()
  let size = 0
  for (const group of groups.values()) {
    const bytes = group.reduce((sum, change) => sum + (change.contents?.length ?? 0) + change.path.length + 100, 0)
    const reason = group.map(holdReason).find(reason => reason !== null) ?? (bytes > GITHUB_PUSH_BYTES ? 'over the size limit' : null)
    if (reason) { for (const change of group) held.set(change.path, reason); continue }
    if (size + bytes > GITHUB_PUSH_BYTES && size > 0) { batches.push([]); size = 0 }
    batches.at(-1)!.push(...group)
    size += bytes
  }
  return { batches: batches.filter(batch => batch.length), held }
}
