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
  if (cursorEpoch === null) {
    // An explicit epochless `since_seq=-1` is the from-start request a host
    // makes when attaching to a session it JUST created (it has no epoch yet,
    // but must not miss first-turn events emitted before the attach). Any
    // other epochless attach stays live-only.
    return sinceSeq === -1 ? [...messages] : [];
  }
  if (cursorEpoch === currentEpoch) {
    if (sinceSeq === null) return [];
    // Clamp below -1: a raw-dial negative like -5 would slice(-4) and replay
    // the TAIL — out of contract. Anything under -1 means "from the start".
    return messages.slice(Math.max(sinceSeq + 1, 0));
  }
  return [...messages];
}

// Parse the resume cursor off the /stream upgrade URL. Missing, empty, or
// non-integer values mean "no cursor" — `Number('')` is 0, so an explicit
// empty-string guard keeps `?since_seq=` from silently reading as position 0.
export function parseStreamCursor(params: URLSearchParams): {
  epoch: string | null;
  sinceSeq: number | null;
} {
  const epoch = params.get('epoch');
  const raw = params.get('since_seq');
  const n = raw === null || raw.trim() === '' ? NaN : Number(raw);
  return { epoch, sinceSeq: Number.isInteger(n) ? n : null };
}
