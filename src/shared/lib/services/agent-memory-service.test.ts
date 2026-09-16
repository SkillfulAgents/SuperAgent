import { describe, it, expect, vi } from 'vitest'
import { InMemoryFileOps } from '@shared/lib/agent-actor/testing/in-memory-file-ops'
import { AGENT_MEMORY_DIR as root, MAX_MEMORY_BYTES, listAgentMemories, readAgentMemory, saveAgentMemory } from './agent-memory-service'

const original = '---\nname: Writing style\ndescription: Keep answers concise\nmetadata:\n  type: feedback\n---\n\nUse short paragraphs.\n'

describe('agent memories through FileOps', () => {
  it('returns an empty list without creating a missing memory directory', async () => {
    const files = new InMemoryFileOps()
    expect(await listAgentMemories(files)).toEqual([])
    expect(await files.stat(root)).toBeNull()
  })

  it('lists the index first and discovers nested, unindexed memories with metadata', async () => {
    const files = new InMemoryFileOps()
    await files.putDoc(`${root}/nested/style.md`, original)
    await files.putDoc(`${root}/MEMORY.md`, '- [Style](nested/style.md)')
    await files.putDoc(`${root}/scratch.txt`, 'not a memory')
    const entries = await listAgentMemories(files)
    expect(entries).toEqual([
      expect.objectContaining({ path: 'MEMORY.md', isIndex: true }),
      expect.objectContaining({ path: 'nested/style.md', title: 'Writing style', description: 'Keep answers concise', type: 'feedback' }),
    ])
    expect(entries[1]).not.toHaveProperty('content')
  })

  it('reads malformed frontmatter without losing any text', async () => {
    const files = new InMemoryFileOps()
    const content = '---\nname: [broken\n---\nRepair me'
    await files.putDoc(`${root}/broken.md`, content)
    expect(await readAgentMemory(files, 'broken.md')).toMatchObject({ title: 'broken.md', content, body: content })
  })

  it('saves full Markdown and leaves the index untouched', async () => {
    const files = new InMemoryFileOps()
    await files.putDoc(`${root}/style.md`, original)
    await files.putDoc(`${root}/MEMORY.md`, 'index')
    const doc = await readAgentMemory(files, 'style.md')
    const updated = original.replace('short paragraphs', 'brief explanations')
    const saved = await saveAgentMemory(files, 'style.md', updated, doc.revision)
    expect(saved.content).toBe(updated)
    expect(saved.revision).not.toBe(doc.revision)
    expect((await readAgentMemory(files, 'style.md')).content).toBe(updated)
    expect((await readAgentMemory(files, 'MEMORY.md')).content).toBe('index')
  })

  it('rejects stale saves and preserves the agent change', async () => {
    const files = new InMemoryFileOps()
    await files.putDoc(`${root}/style.md`, original)
    const doc = await readAgentMemory(files, 'style.md')
    await files.putDoc(`${root}/style.md`, 'Agent changed this')
    await expect(saveAgentMemory(files, 'style.md', 'user draft', doc.revision)).rejects.toMatchObject({ status: 409 })
    expect((await readAgentMemory(files, 'style.md')).content).toBe('Agent changed this')
  })

  it('serializes competing API saves so only one stale revision can win', async () => {
    const files = new InMemoryFileOps()
    await files.putDoc(`${root}/style.md`, original)
    const doc = await readAgentMemory(files, 'style.md')
    const results = await Promise.allSettled([
      saveAgentMemory(files, 'style.md', 'First', doc.revision),
      saveAgentMemory(files, 'style.md', 'Second', doc.revision),
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect((await readAgentMemory(files, 'style.md')).content).toBe('First')
  })

  it.each(['../secrets.md', '/absolute.md', 'nested/../../escape.md', 'nested/../style.md', 'a\\b.md', 'a\0.md', 'a.txt'])('rejects invalid path %s before I/O', async relative => {
    const files = new InMemoryFileOps()
    const resolve = vi.spyOn(files, 'resolve')
    await expect(readAgentMemory(files, relative)).rejects.toMatchObject({ status: 400 })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('rejects symlink redirects through the actor resolver', async () => {
    const files = new InMemoryFileOps()
    await files.putDoc('private.md', 'private')
    vi.spyOn(files, 'resolve').mockResolvedValue('private.md')
    const read = vi.spyOn(files, 'read')
    await expect(readAgentMemory(files, 'link.md')).rejects.toMatchObject({ status: 400 })
    await expect(listAgentMemories(files)).rejects.toMatchObject({ status: 400 })
    expect(read).not.toHaveBeenCalled()
  })

  it('does not recreate a deleted memory on save', async () => {
    const files = new InMemoryFileOps()
    await files.putDoc(`${root}/style.md`, original)
    const doc = await readAgentMemory(files, 'style.md')
    await files.delete(`${root}/style.md`)
    await expect(saveAgentMemory(files, 'style.md', 'draft', doc.revision)).rejects.toMatchObject({ status: 404 })
    expect(await files.stat(`${root}/style.md`)).toBeNull()
  })

  it('lists oversized files but refuses to read or overwrite them', async () => {
    const files = new InMemoryFileOps()
    await files.putDoc(`${root}/big.md`, 'x'.repeat(MAX_MEMORY_BYTES + 1))
    expect(await listAgentMemories(files)).toEqual([expect.objectContaining({ path: 'big.md' })])
    await expect(readAgentMemory(files, 'big.md')).rejects.toMatchObject({ status: 413 })
    await expect(saveAgentMemory(files, 'big.md', 'é'.repeat(MAX_MEMORY_BYTES), 'unused')).rejects.toMatchObject({ status: 413 })
  })
})
