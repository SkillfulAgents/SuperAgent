import { describe, it, expect } from 'vitest';
import { computeReplay, parseStreamCursor } from './stream-replay';
import type { SDKMessage } from './types';

// Replay selection for a (re)attaching stream consumer. The contract:
// - no cursor            → live-only (empty replay). A fresh host attaching to
//                          an old session must NOT replay history (it would
//                          re-register long-dead background tasks).
// - same-epoch cursor    → exactly the messages after it (lossless resume).
// - different epoch      → everything this incarnation has: the numbering
//                          restarted with the new process, and the new
//                          epoch's history is small by construction.

const msg = (i: number) => ({ type: 'assistant', seq: i }) as unknown as SDKMessage;
const MESSAGES = [msg(0), msg(1), msg(2), msg(3)];
const EPOCH = 'epoch-a';

describe('computeReplay', () => {
  it('returns nothing without a cursor (live-only attach)', () => {
    expect(computeReplay(MESSAGES, EPOCH, null, null)).toEqual([]);
  });

  it('returns exactly the messages after a same-epoch cursor', () => {
    expect(computeReplay(MESSAGES, EPOCH, EPOCH, 1)).toEqual([msg(2), msg(3)]);
  });

  it('returns everything after a same-epoch cursor of -1 (attach from the very start)', () => {
    expect(computeReplay(MESSAGES, EPOCH, EPOCH, -1)).toEqual(MESSAGES);
  });

  it('returns nothing when the same-epoch cursor is already caught up', () => {
    expect(computeReplay(MESSAGES, EPOCH, EPOCH, 3)).toEqual([]);
  });

  it('returns the full new-epoch history on an epoch mismatch (renumbered stream)', () => {
    expect(computeReplay(MESSAGES, EPOCH, 'epoch-old', 999)).toEqual(MESSAGES);
  });

  it('returns a copy, never the live array', () => {
    const out = computeReplay(MESSAGES, EPOCH, 'epoch-old', 0);
    expect(out).not.toBe(MESSAGES);
  });

  it('handles an empty history for every cursor kind', () => {
    expect(computeReplay([], EPOCH, null, null)).toEqual([]);
    expect(computeReplay([], EPOCH, EPOCH, -1)).toEqual([]);
    expect(computeReplay([], EPOCH, 'epoch-old', 5)).toEqual([]);
  });

  it('returns nothing when the cursor claims to be ahead of the history', () => {
    expect(computeReplay(MESSAGES, EPOCH, EPOCH, 999)).toEqual([]);
  });

  it('clamps a below-range cursor to a full replay instead of slicing the tail', () => {
    expect(computeReplay(MESSAGES, EPOCH, EPOCH, -5)).toEqual(MESSAGES);
  });

  it('replays from the start when asked without an epoch (fresh-session first attach)', () => {
    // A host subscribing to a session it JUST created has no epoch yet but
    // must not miss the first turn's events emitted before it attached.
    expect(computeReplay(MESSAGES, EPOCH, null, -1)).toEqual(MESSAGES);
  });

  it('stays live-only for an epochless cursor at any other position', () => {
    expect(computeReplay(MESSAGES, EPOCH, null, 1)).toEqual([]);
  });
});

describe('parseStreamCursor', () => {
  const parse = (qs: string) => parseStreamCursor(new URLSearchParams(qs));

  it('returns nulls when the params are absent', () => {
    expect(parse('')).toEqual({ epoch: null, sinceSeq: null });
  });

  it('parses a well-formed cursor', () => {
    expect(parse('epoch=e1&since_seq=5')).toEqual({ epoch: 'e1', sinceSeq: 5 });
    expect(parse('epoch=e1&since_seq=-1')).toEqual({ epoch: 'e1', sinceSeq: -1 });
  });

  it('treats an empty since_seq as no cursor (Number("") is 0, not a position)', () => {
    expect(parse('epoch=e1&since_seq=')).toEqual({ epoch: 'e1', sinceSeq: null });
  });

  it('rejects non-integer since_seq values', () => {
    expect(parse('since_seq=abc')).toEqual({ epoch: null, sinceSeq: null });
    expect(parse('since_seq=1.5')).toEqual({ epoch: null, sinceSeq: null });
  });
});
