import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionChannel, type SessionEvent, type WireFrame } from './session-channel'

afterEach(() => {
  vi.restoreAllMocks()
})

const types = (frames: WireFrame[] | null) => frames?.map((frame) => (JSON.parse(frame.data) as SessionEvent).type) ?? null

/** A channel keeping frames for replay, with `count` events t1..tN already emitted. */
function keptChannel(count: number, limits?: { maxFrames: number; maxBytes: number }) {
  const channel = new SessionChannel(limits, 'e')
  channel.keepForReplay(true)
  for (let i = 1; i <= count; i++) channel.emit({ type: `t${i}` })
  return channel
}

describe('SessionChannel', () => {
  describe('listeners', () => {
    it('hear every event, in order, before emit returns', () => {
      const channel = new SessionChannel()
      const first: SessionEvent[] = []
      const second: SessionEvent[] = []
      channel.listen((event) => first.push(event))
      channel.listen((event) => second.push(event))

      channel.emit({ type: 'stream_start' })
      channel.emit({ type: 'stream_delta', text: 'hi' })

      expect(first).toEqual([{ type: 'stream_start' }, { type: 'stream_delta', text: 'hi' }])
      expect(second).toEqual(first)
    })

    it('hear an event that cannot go on the wire', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const channel = new SessionChannel()
      const heard: SessionEvent[] = []
      const frames: WireFrame[] = []
      channel.listen((event) => heard.push(event))
      channel.follow((frame) => frames.push(frame))
      const circular: Record<string, unknown> = { type: 'bad' }
      circular.self = circular

      channel.emit(circular as SessionEvent)

      expect(heard.map((e) => e.type)).toEqual(['bad'])
      expect(frames).toEqual([])
    })

    it('stop hearing once they unsubscribe, and the others carry on', () => {
      const channel = new SessionChannel()
      const gone: string[] = []
      const kept: string[] = []
      const off = channel.listen((event) => gone.push(event.type))
      channel.listen((event) => kept.push(event.type))

      channel.emit({ type: 'a' })
      off()
      off()
      channel.emit({ type: 'b' })

      expect(gone).toEqual(['a'])
      expect(kept).toEqual(['a', 'b'])
    })

    it('are kept apart from a throwing one, and so is the emitter', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const channel = new SessionChannel()
      const kept: string[] = []
      channel.listen(() => {
        throw new Error('boom')
      })
      channel.follow(() => {
        throw new Error('boom')
      })
      channel.listen((event) => kept.push(event.type))

      expect(() => channel.emit({ type: 'a' })).not.toThrow()
      expect(kept).toEqual(['a'])
    })
  })

  describe('followers', () => {
    it('get each event as a numbered frame, serialized once for all of them', () => {
      const channel = new SessionChannel(undefined, 'ep0ch')
      const a: WireFrame[] = []
      const b: WireFrame[] = []
      channel.follow((frame) => a.push(frame))
      channel.follow((frame) => b.push(frame))

      channel.emit({ type: 'a' })
      channel.emit({ type: 'b', n: 1 })

      expect(a).toEqual([
        { id: 'ep0ch:1', data: '{"type":"a"}' },
        { id: 'ep0ch:2', data: '{"type":"b","n":1}' },
      ])
      expect(b).toEqual(a)
      expect(channel.lastId).toBe('ep0ch:2')
    })

    it('never see a number spent on an event that could not be serialized', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const channel = new SessionChannel(undefined, 'e')
      const frames: WireFrame[] = []
      channel.follow((frame) => frames.push(frame))
      const circular: Record<string, unknown> = { type: 'bad' }
      circular.self = circular

      channel.emit(circular as SessionEvent)
      channel.emit({ type: 'good' })

      expect(frames.map((frame) => frame.id)).toEqual(['e:1'])
    })

    it('are counted apart from listeners', () => {
      const channel = new SessionChannel()
      const off = channel.follow(() => {})
      channel.listen(() => {})
      expect(channel.followerCount).toBe(1)
      expect(channel.listenerCount).toBe(2)
      off()
      expect(channel.followerCount).toBe(0)
      expect(channel.listenerCount).toBe(1)
    })
  })

  it('mints a different epoch for every channel', () => {
    expect(new SessionChannel().epoch).not.toBe(new SessionChannel().epoch)
    expect(new SessionChannel(undefined, 'x').lastId).toBe('x:0')
  })

  describe('framesAfter', () => {
    it('gives the frames after the named one, in order', () => {
      expect(types(keptChannel(4).framesAfter('e:2'))).toEqual(['t3', 't4'])
    })

    it('gives nothing to replay after the last frame', () => {
      expect(keptChannel(3).framesAfter('e:3')).toEqual([])
    })

    it('gives every frame after the start of the epoch', () => {
      expect(types(keptChannel(2).framesAfter('e:0'))).toEqual(['t1', 't2'])
    })

    it('keeps nothing until asked to, so it can only say nothing was missed', () => {
      const channel = new SessionChannel(undefined, 'e')
      channel.emit({ type: 'unkept' })
      expect(channel.framesAfter('e:0')).toBeNull()
      expect(channel.framesAfter('e:1')).toEqual([])
    })

    it('drops what it kept once it stops keeping', () => {
      const channel = keptChannel(3)
      channel.keepForReplay(false)
      expect(channel.framesAfter('e:1')).toBeNull()
      expect(channel.framesAfter('e:3')).toEqual([])
    })

    it('cannot replay another channel\'s frames', () => {
      expect(keptChannel(3).framesAfter('other:1')).toBeNull()
    })

    it('cannot replay from an id it has not reached', () => {
      expect(keptChannel(3).framesAfter('e:7')).toBeNull()
    })

    it.each(['', 'e', 'e:', ':1', 'e:x', 'e:-1', 'e:1.5'])('cannot replay from a malformed id %j', (id) => {
      expect(keptChannel(3).framesAfter(id)).toBeNull()
    })

    it('keeps at most maxFrames, and cannot replay from before them', () => {
      const channel = keptChannel(5, { maxFrames: 3, maxBytes: Infinity })
      expect(types(channel.framesAfter('e:2'))).toEqual(['t3', 't4', 't5'])
      expect(channel.framesAfter('e:1')).toBeNull()
    })

    it('keeps at most maxBytes of serialized events', () => {
      // Each '{"type":"tN"}' is 13 bytes: 30 bytes hold the last two.
      const channel = keptChannel(4, { maxFrames: 100, maxBytes: 30 })
      expect(types(channel.framesAfter('e:2'))).toEqual(['t3', 't4'])
      expect(channel.framesAfter('e:1')).toBeNull()
    })

    it('keeps nothing of an event larger than the whole budget', () => {
      const channel = new SessionChannel({ maxFrames: 100, maxBytes: 20 }, 'e')
      channel.keepForReplay(true)
      channel.emit({ type: 'small' })
      channel.emit({ type: 'large', text: 'x'.repeat(100) })

      expect(channel.framesAfter('e:2')).toEqual([])
      expect(channel.framesAfter('e:1')).toBeNull()
    })

    it('replays a run of one tool\'s streaming input as its last frame, which carries the whole input', () => {
      const channel = new SessionChannel(undefined, 'e')
      channel.keepForReplay(true)
      channel.emit({ type: 'tool_use_start', toolId: 't1' })
      channel.emit({ type: 'tool_use_streaming', toolId: 't1', partialInput: '{"a' })
      channel.emit({ type: 'tool_use_streaming', toolId: 't1', partialInput: '{"a":1' })
      channel.emit({ type: 'tool_use_streaming', toolId: 't1', partialInput: '{"a":1}' })
      channel.emit({ type: 'tool_use_ready', toolId: 't1' })

      const replay = channel.framesAfter('e:0')!

      expect(replay.map((frame) => frame.id)).toEqual(['e:1', 'e:4', 'e:5'])
      expect(JSON.parse(replay[1].data)).toEqual({ type: 'tool_use_streaming', toolId: 't1', partialInput: '{"a":1}' })
    })

    it('replays a run of a subagent tool\'s streaming input as its last frame too', () => {
      const channel = new SessionChannel(undefined, 'e')
      channel.keepForReplay(true)
      channel.emit({ type: 'subagent_tool_use_streaming', parentToolId: 'p1', toolId: 't1', partialInput: 'a' })
      channel.emit({ type: 'subagent_tool_use_streaming', parentToolId: 'p1', toolId: 't1', partialInput: 'ab' })
      channel.emit({ type: 'subagent_tool_use_streaming', parentToolId: 'p2', toolId: 't1', partialInput: 'x' })

      expect(channel.framesAfter('e:0')!.map((frame) => frame.id)).toEqual(['e:2', 'e:3'])
    })

    it('keeps every streaming frame that another event separates, and every other tool\'s', () => {
      const channel = new SessionChannel(undefined, 'e')
      channel.keepForReplay(true)
      channel.emit({ type: 'tool_use_streaming', toolId: 't1', partialInput: 'a' })
      channel.emit({ type: 'tool_use_streaming', toolId: 't2', partialInput: 'b' })
      channel.emit({ type: 'tool_use_streaming', toolId: 't1', partialInput: 'aa' })
      channel.emit({ type: 'stream_delta', text: 'x' })
      channel.emit({ type: 'tool_use_streaming', toolId: 't1', partialInput: 'aaa' })

      expect(channel.framesAfter('e:0')!.map((frame) => frame.id)).toEqual(['e:1', 'e:2', 'e:3', 'e:4', 'e:5'])
    })
  })
})
