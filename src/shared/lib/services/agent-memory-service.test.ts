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
      saveAgentMemory(files, 'style.md', original + 'First', doc.revision),
      saveAgentMemory(files, 'style.md', original + 'Second', doc.revision),
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect((await readAgentMemory(files, 'style.md')).content).toBe(original + 'First')
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
  describe('frontmatter validation on save', () => {
    it.each([
      ['missing frontmatter', 'plain Markdown', 'enclosed by ---'],
      ['missing closing delimiter', '---\nname: Example', 'enclosed by ---'],
      ['malformed YAML', '---\nname: [broken\n---\nBody', 'invalid YAML'],
      ['duplicate keys', original.replace('name: Writing style', 'name: First\nname: Second'), 'invalid YAML'],
      ['empty YAML', '---\n\n---\nBody', 'named fields'],
      ['list root', '---\n- name\n- description\n---\nBody', 'named fields'],
      ['scalar root', '---\nhello\n---\nBody', 'named fields'],
      ['missing name', original.replace('name: Writing style\n', ''), '"name"'],
      ['blank name', original.replace('name: Writing style', 'name: "  "'), '"name"'],
      ['numeric name', original.replace('name: Writing style', 'name: 123'), '"name"'],
      ['missing description', original.replace('description: Keep answers concise\n', ''), '"description"'],
      ['blank description', original.replace('description: Keep answers concise', 'description: "  "'), '"description"'],
      ['non-text description', original.replace('description: Keep answers concise', 'description: false'), '"description"'],
      ['missing metadata', original.replace('metadata:\n  type: feedback\n', ''), '"metadata.type"'],
      ['null metadata', original.replace('metadata:\n  type: feedback', 'metadata: null'), '"metadata.type"'],
      ['list metadata', original.replace('metadata:\n  type: feedback', 'metadata: [feedback]'), '"metadata.type"'],
      ['unknown type', original.replace('type: feedback', 'type: typo'), '"metadata.type"'],
      ['top-level type only', original.replace('metadata:\n  type: feedback', 'type: feedback'), '"metadata.type"'],
    ])('rejects %s without writing', async (_label, content, message) => {
      const files = new InMemoryFileOps()
      await files.putDoc(`${root}/style.md`, original)
      const current = await readAgentMemory(files, 'style.md')
      const write = vi.spyOn(files, 'putDoc')
      await expect(saveAgentMemory(files, 'style.md', content, current.revision)).rejects.toMatchObject({ status: 422, message: expect.stringContaining(message) })
      expect(write).not.toHaveBeenCalled()
      expect((await readAgentMemory(files, 'style.md')).content).toBe(original)
    })

    it.each(['user', 'feedback', 'project', 'reference'])('accepts %s and preserves comments, extra fields, BOM, and CRLF', async type => {
      const files = new InMemoryFileOps()
      await files.putDoc(`${root}/style.md`, original)
      const current = await readAgentMemory(files, 'style.md')
      const content = '\uFEFF' + original.replace('type: feedback', `type: ${type}\n  source: conversation # keep this\nextra: true`).replace(/\n/g, '\r\n')
      await saveAgentMemory(files, 'style.md', content, current.revision)
      expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(await files.getDoc(`${root}/style.md`) ?? undefined)).toBe(content)
      expect((await readAgentMemory(files, 'style.md')).type).toBe(type)
    })

    it('lets users repair existing malformed files and retry after validation failure', async () => {
      const files = new InMemoryFileOps()
      await files.putDoc(`${root}/broken.md`, '---\nname: [broken\n---\nBody')
      const current = await readAgentMemory(files, 'broken.md')
      await expect(saveAgentMemory(files, 'broken.md', 'still broken', current.revision)).rejects.toMatchObject({ status: 422 })
      expect((await saveAgentMemory(files, 'broken.md', original, current.revision)).content).toBe(original)
    })

    it('exempts only the root memory index', async () => {
      const files = new InMemoryFileOps()
      for (const relative of ['MEMORY.md', 'nested/MEMORY.md']) {
        await files.putDoc(`${root}/${relative}`, original)
        const current = await readAgentMemory(files, relative)
        const save = saveAgentMemory(files, relative, '- [Style](style.md)', current.revision)
        if (relative === 'MEMORY.md') expect((await save).content).toBe('- [Style](style.md)')
        else await expect(save).rejects.toMatchObject({ status: 422 })
      }
    })
  })

})
