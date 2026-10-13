import { createHash } from 'node:crypto'

export interface MemoryEntry { id: string; path: string; bytes?: Uint8Array; version: number }
/** Provider test data. The adapter cannot access this tree except through the
 * fake provider's wire API; assertions can independently inspect it. */
export class MemoryVolumeTree {
  readonly entries = new Map<string, MemoryEntry>()
  private next = 0
  constructor(private readonly caseInsensitive = false) { this.mkdir('') }
  private key(path: string) { return this.caseInsensitive ? path.toLowerCase() : path }
  get(path: string) { return this.entries.get(this.key(path)) }
  byId(id: string) { return [...this.entries.values()].find(entry => entry.id === id) }
  put(path: string, bytes: Uint8Array): MemoryEntry {
    const old = this.get(path)
    const entry = { id: old?.id ?? `id_${++this.next}`, path, bytes: bytes.slice(), version: (old?.version ?? 0) + 1 }
    this.entries.set(this.key(path), entry)
    return entry
  }
  mkdir(path: string): MemoryEntry {
    const entry = { id: `id_${++this.next}`, path, version: 1 }
    this.entries.set(this.key(path), entry)
    return entry
  }
  children(path: string) {
    return [...this.entries.values()].filter(entry => entry.path !== '' && entry.path.slice(0, entry.path.lastIndexOf('/') + 1) === (path ? `${path}/` : ''))
  }
  remove(path: string): void {
    for (const key of this.entries.keys()) if (key === this.key(path) || key.startsWith(`${this.key(path)}/`)) this.entries.delete(key)
  }
  move(from: string, to: string): MemoryEntry {
    const source = this.get(from)!
    const descendants = [...this.entries.values()].filter(entry => this.key(entry.path).startsWith(`${this.key(from)}/`))
    this.remove(from)
    for (const entry of [source, ...descendants]) {
      const moved = { ...entry, path: to + entry.path.slice(from.length) }
      this.entries.set(this.key(moved.path), moved)
    }
    return this.get(to)!
  }
  md5(entry: MemoryEntry) { return createHash('md5').update(entry.bytes ?? new Uint8Array()).digest('hex') }
}
