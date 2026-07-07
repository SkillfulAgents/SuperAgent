import { describe, it, expect } from 'vitest';
import { computeReplay } from './stream-replay';
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
});
