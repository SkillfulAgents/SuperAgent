import type { SDKMessage } from './types';

// Replay selection for a (re)attaching stream consumer.
// - No cursor: live-only. A fresh host attaching to an old session must not
//   replay history — it would re-process the whole transcript and re-register
//   long-dead background tasks.
// - Same-epoch cursor: exactly the messages after it (lossless resume across
//   a reconnect gap; seq is the messages[] index, stamped at store time).
// - Different epoch: the numbering restarted with this process incarnation,
//   so the cursor is meaningless — send everything this incarnation has
//   (small by construction: the epoch just started).
export function computeReplay(
  messages: SDKMessage[],
  currentEpoch: string,
  cursorEpoch: string | null,
  sinceSeq: number | null
): SDKMessage[] {
  if (cursorEpoch === null) return [];
  if (cursorEpoch === currentEpoch) {
    return sinceSeq === null ? [] : messages.slice(sinceSeq + 1);
  }
  return [...messages];
}
