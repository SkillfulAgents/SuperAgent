/**
 * A viewer's wire for a session (`LiveSessions.follow`): the snapshot a new
 * viewer starts from, the frames a reconnecting one missed, and the order of
 * the two against events that arrive while the snapshot is being prepared.
 *
 * The sessions are real (`attachLiveSessionsHarness`), fed frame by frame
 * through a stream client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/services/session-service', () => ({
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
  finalizeAutomationStatus: vi.fn(() => Promise.resolve('updated')),
  readAgentSlashCommands: vi.fn(() => Promise.resolve([])),
  storeAgentSlashCommands: vi.fn(() => Promise.resolve()),
}))
vi.mock('@shared/lib/services/session-summary-cache', () => ({
  recordSessionActivity: vi.fn(),
  recordProvisionalSessionActivity: (_store: unknown, _id: string, at: number) => ({ recordedAtMs: at, previous: null }),
  revertSessionActivity: vi.fn(),
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  getAgentCapabilitySettings: () => ({ subagents: 'allow', workflows: 'review' }),
  getModelCatalogSettings: () => ({}),
}))

import {
  getSessionMetadata,
  readAgentSlashCommands,
  storeAgentSlashCommands,
  updateSessionMetadata,
} from '@shared/lib/services/session-service'
import type { SessionMetadata } from '@shared/lib/types/agent'
import { attachLiveSessionsHarness, createStreamClient, type StreamClient } from '../testing/live-sessions-harness'
import type { SessionEvent, WireFrame } from './session-channel'

const AGENT = 'agent'
const SESSION = 'session-1'
const live = attachLiveSessionsHarness()
const sessions = () => live.sessions(AGENT)

/** A viewer's wire: every frame it was handed, in order. */
function viewer() {
  const frames: WireFrame[] = []
  const events = () => frames.map((frame) => JSON.parse(frame.data) as SessionEvent)
  return {
    frames,
    events,
    onFrame: (frame: WireFrame) => frames.push(frame),
    types: () => events().map((event) => event.type),
    lastId: () => [...frames].reverse().find((frame) => frame.id)?.id,
  }
}

let client: StreamClient
const turnStarts = () => {
  client.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' })
  client.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } })
}
const streams = (text: string) =>
  client.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })

beforeEach(async () => {
  client = createStreamClient()
  await sessions().subscribe(SESSION, client, SESSION)
  // The subscribe read the metadata for its stream policy.
  vi.mocked(getSessionMetadata).mockClear()
})

afterEach(() => {
  live.reset()
  vi.mocked(getSessionMetadata).mockReset().mockResolvedValue(null)
  vi.mocked(updateSessionMetadata).mockClear()
  vi.mocked(readAgentSlashCommands).mockClear()
  vi.mocked(storeAgentSlashCommands).mockClear()
})

describe('LiveSessions.follow', () => {
  describe('a new viewer', () => {
    it('starts from the connected snapshot, as of the last event, then hears every event', async () => {
      const before = viewer()
      await sessions().follow(SESSION, undefined, before.onFrame)
      turnStarts()

      const v = viewer()
      await sessions().follow(SESSION, undefined, v.onFrame)
      streams('hi')

      expect(v.types()).toEqual(['connected', 'stream_delta'])
      expect(v.events()[0]).toEqual({
        type: 'connected',
        isActive: true,
        turnOutcome: null,
        isWaitingBackground: false,
        backgroundTasks: [],
        activeSubagents: [],
      })
      // The snapshot stands for everything the earlier viewer heard so far.
      expect(v.frames[0].id).toBe(before.frames.at(-2)!.id)
      expect(v.frames[1]).toEqual(before.frames.at(-1))
    })

    it('keeps the snapshot\'s keys in the order the wire always had', async () => {
      const v = viewer()
      await sessions().follow(SESSION, undefined, v.onFrame)
      expect(Object.keys(JSON.parse(v.frames[0].data))).toEqual([
        'type', 'isActive', 'turnOutcome', 'isWaitingBackground', 'backgroundTasks', 'activeSubagents',
      ])
    })

    it('includes the session\'s live slash commands', async () => {
      sessions().setSlashCommands(SESSION, [{ name: 'review', description: 'Review it', argumentHint: '' }])
      const v = viewer()
      await sessions().follow(SESSION, undefined, v.onFrame)

      expect(v.events()[0].slashCommands).toEqual([{ name: 'review', description: 'Review it', argumentHint: '' }])
      expect(getSessionMetadata).not.toHaveBeenCalled()
    })

    it('falls back to the commands the agent kept, without reading the session entry', async () => {
      vi.mocked(readAgentSlashCommands).mockResolvedValueOnce([{ name: 'review', description: 'Review it', argumentHint: '' }])
      const v = viewer()
      await sessions().follow(SESSION, undefined, v.onFrame)

      expect(v.events()[0].slashCommands).toEqual([{ name: 'review', description: 'Review it', argumentHint: '' }])
      expect(getSessionMetadata).not.toHaveBeenCalled()
      expect(storeAgentSlashCommands).not.toHaveBeenCalled()
    })

    it('repairs legacy command names and keeps the repaired list for the agent once', async () => {
      vi.mocked(readAgentSlashCommands).mockResolvedValueOnce([{ name: 'Code Review', description: 'Review it', argumentHint: '' }])
      const v = viewer()
      await sessions().follow(SESSION, undefined, v.onFrame)

      expect(v.events()[0].slashCommands).toEqual([{ name: 'code-review', description: 'Review it', argumentHint: '' }])
      expect(storeAgentSlashCommands).toHaveBeenCalledWith(expect.anything(), [
        { name: 'code-review', description: 'Review it', argumentHint: '' },
      ])
      // The live state has them now: the next viewer reads nothing.
      vi.mocked(readAgentSlashCommands).mockClear()
      await sessions().follow(SESSION, undefined, viewer().onFrame)
      expect(readAgentSlashCommands).not.toHaveBeenCalled()
    })

    it('leaves slash commands off the wire when the session has none anywhere', async () => {
      const v = viewer()
      await sessions().follow(SESSION, undefined, v.onFrame)
      expect(JSON.parse(v.frames[0].data)).not.toHaveProperty('slashCommands')
    })

    it('is told the app the agent has grabbed, with its icon, after the snapshot and without an id', async () => {
      live.host.answer('computerUseAppIcon', 'ICON')
      live.agents.get(AGENT).computerUse.setGrabbed('Safari')
      const v = viewer()
      await sessions().follow(SESSION, undefined, v.onFrame)

      expect(v.frames[1]).toEqual({
        id: undefined,
        data: '{"type":"computer_use_grab_changed","app":"Safari","appIcon":"ICON"}',
      })
      expect(v.lastId()).toBe(v.frames[0].id)
    })

    it('hears live events while the icon is read, then the grab, and not a stale one', async () => {
      let answerIcon!: (icon: string | null) => void
      live.host.answer('computerUseAppIcon', () => new Promise<string | null>((resolve) => {
        answerIcon = resolve
      }))
      live.agents.get(AGENT).computerUse.setGrabbed('Safari')
      const v = viewer()
      const attached = sessions().follow(SESSION, undefined, v.onFrame)
      await vi.waitFor(() => expect(answerIcon).toBeDefined())
      turnStarts()
      answerIcon('ICON')
      await attached

      expect(v.types()).toEqual(['connected', 'session_active', 'stream_start', 'computer_use_grab_changed'])

      // A grab that changed during the read went out on its own; the stale one is dropped.
      const w = viewer()
      const second = sessions().follow(SESSION, undefined, w.onFrame)
      await vi.waitFor(() => expect(live.host.calls.filter(([name]) => name === 'computerUseAppIcon')).toHaveLength(2))
      live.agents.get(AGENT).computerUse.setGrabbed('Notes')
      answerIcon('ICON')
      await second
      expect(w.types()).not.toContain('computer_use_grab_changed')
    })

    it('leaves nothing attached when telling the viewer about the grab fails', async () => {
      live.host.answer('computerUseAppIcon', 'ICON')
      live.agents.get(AGENT).computerUse.setGrabbed('Safari')
      const frames: string[] = []
      const onFrame = vi.fn((frame: WireFrame) => {
        if (JSON.parse(frame.data).type === 'computer_use_grab_changed') throw new Error('write failed')
        frames.push(frame.data)
      })

      await expect(sessions().follow(SESSION, undefined, onFrame)).rejects.toThrow('write failed')
      turnStarts()

      expect(frames).toHaveLength(1)
    })

    it('is told the grabbed app without an icon when the host has none to give', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      live.host.answer('computerUseAppIcon', () => Promise.reject(new Error('no icon service')))
      live.agents.get(AGENT).computerUse.setGrabbed('Safari')
      const v = viewer()
      await sessions().follow(SESSION, undefined, v.onFrame)

      expect(v.events()[1]).toEqual({ type: 'computer_use_grab_changed', app: 'Safari' })
    })

    it('misses nothing that happens while its snapshot is being prepared, and hears it only once', async () => {
      const other = viewer()
      await sessions().follow(SESSION, undefined, other.onFrame)
      let release!: (meta: SessionMetadata | null) => void
      vi.mocked(getSessionMetadata).mockReturnValueOnce(new Promise((resolve) => {
        release = resolve
      }))

      const v = viewer()
      const attached = sessions().follow(SESSION, undefined, v.onFrame)
      turnStarts()
      release(null)
      await attached
      streams('after')

      // The turn that started meanwhile is in the snapshot (active), not
      // replayed after it; the snapshot stands for exactly those events.
      expect(v.types()).toEqual(['connected', 'stream_delta'])
      expect(v.events()[0].isActive).toBe(true)
      expect(v.frames[0].id).toBe(other.frames.at(-2)!.id)
    })
  })

  describe('a viewer that comes back', () => {
    it('is given exactly the frames it missed, and no snapshot', async () => {
      const first = viewer()
      const stop = await sessions().follow(SESSION, undefined, first.onFrame)
      turnStarts()
      streams('one ')
      const resumeAfter = first.lastId()
      stop()
      streams('two ')
      streams('three')

      const again = viewer()
      await sessions().follow(SESSION, resumeAfter, again.onFrame)
      streams('!')

      expect(again.events().map((event) => event.text)).toEqual(['two ', 'three', '!'])
      // Together the two connections heard every frame once, in order.
      const ids = [...first.frames, ...again.frames].map((frame) => frame.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('starts over from a snapshot when it was last connected to another process', async () => {
      const v = viewer()
      await sessions().follow(SESSION, 'gone:12', v.onFrame)
      expect(v.types()).toEqual(['connected'])
    })

    it('starts over from a snapshot once the agent has been released', async () => {
      const first = viewer()
      const stop = await sessions().follow(SESSION, undefined, first.onFrame)
      turnStarts()
      stop()
      live.reset()

      const v = viewer()
      await live.sessions(AGENT).follow(SESSION, first.lastId(), v.onFrame)
      expect(v.types()).toEqual(['connected'])
    })
  })

  it('gives internal listeners the bare events', async () => {
    const heard: unknown[] = []
    sessions().listen(SESSION, (event) => heard.push(event))
    turnStarts()
    expect(heard).toContainEqual({ type: 'stream_start' })
  })
})
