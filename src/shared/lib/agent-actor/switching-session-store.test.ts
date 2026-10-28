import { describe, expect, it } from 'vitest'
import { createSwitchingSessionStore } from './switching-session-store'
import { createInMemorySessionStore } from './testing/in-memory-session-store'

const text = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text()

describe('switching session store', () => {
  it('reads from the container while the agent runs and from storage while it sleeps', async () => {
    const container = createInMemorySessionStore('sales-agent')
    const blobs = createInMemorySessionStore('sales-agent')
    await container.files.write('notes.md', new TextEncoder().encode('live copy'))
    await blobs.files.write('notes.md', new TextEncoder().encode('stored copy'))
    let running = true
    const store = createSwitchingSessionStore({ slug: 'sales-agent', key: 'org-1/sales-agent', running: container, sleeping: blobs, isRunning: () => running })
    // A handle taken once follows the agent, as the actor's `files` group does.
    const { files } = store

    expect(await text(await files.read('notes.md'))).toBe('live copy')
    running = false
    expect(await text(await files.read('notes.md'))).toBe('stored copy')

    await store.config.put('instructions', '---\nname: Sales\n---\nFollow up on leads.')
    expect(await blobs.config.get('instructions')).not.toBeNull()
    expect(await container.config.get('instructions')).toBeNull()
  })

  it('refuses two sides whose transcripts are in different directories', () => {
    const container = createInMemorySessionStore('sales-agent')
    const blobs = { ...createInMemorySessionStore('sales-agent'), transcriptsDir: '.claude/projects/-mnt-workspace' }
    expect(() => createSwitchingSessionStore({ slug: 'sales-agent', key: 'k', running: container, sleeping: blobs, isRunning: () => true })).toThrow('same directory')
  })
})
