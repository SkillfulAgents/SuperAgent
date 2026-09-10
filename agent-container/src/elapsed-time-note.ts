import { readFileTail } from './file-tail';
import { promptDate } from './prompt-date';
import { transcriptEntrySchema } from './transcript-entry-schema';

// Same gap the transcript draws a time flag for. Keep in sync with
// SESSION_GAP_MINUTES in src/renderer/components/messages/session-time-flag.tsx.
export const ELAPSED_NOTE_MIN_MS = 15 * 60_000;

// Same window as bin/list-sessions.py; a single tool-result entry can run past 64KB.
const TAIL_WINDOW_BYTES = 256 * 1024;

/**
 * Newest timestamp among user and assistant entries, as the max over the
 * window rather than the last line: a resume re-appends history with the
 * original stamps. Other entry types are ignored because queue-operation
 * lines already carry the current prompt's enqueue time when the hook runs.
 */
export function lastTranscriptActivity(tail: string): Date | null {
  let latest: number | null = null;
  for (const line of tail.split('\n')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = transcriptEntrySchema.safeParse(parsed);
    if (!entry.success) continue;
    if (entry.data.type !== 'user' && entry.data.type !== 'assistant') continue;
    const at = new Date(entry.data.timestamp).getTime();
    if (!Number.isNaN(at) && (latest === null || at > latest)) latest = at;
  }
  return latest === null ? null : new Date(latest);
}

/** `23m`, `2h 13m`, `1 day 22h`, `12 days`. */
export function formatElapsed(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days >= 7) return `${days} days`;
  if (days >= 1) return `${days} ${days === 1 ? 'day' : 'days'}${hours ? ` ${hours}h` : ''}`;
  if (hours >= 1) return `${hours}h${minutes ? ` ${minutes}m` : ''}`;
  return `${totalMinutes}m`;
}

function describeMoment(at: Date, timeZone: string): string {
  const { weekday, date, time } = promptDate(at, timeZone);
  return `${weekday}, ${date} ${time}`;
}

export function buildElapsedNote(previous: Date, now: Date, timeZone: string): string {
  return (
    `The previous message was ${describeMoment(previous, timeZone)}. ` +
    `It is now ${describeMoment(now, timeZone)} (${timeZone}), ${formatElapsed(now.getTime() - previous.getTime())} later.`
  );
}

/** Null under the threshold, and for a new session: its file is not written until after the prompt hooks run. */
export async function elapsedTimeNote(
  transcriptPath: string,
  now: Date = new Date(),
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Promise<string | null> {
  const tail = await readFileTail(transcriptPath, TAIL_WINDOW_BYTES);
  if (!tail) return null;
  const previous = lastTranscriptActivity(tail.toString('utf-8'));
  if (!previous || now.getTime() - previous.getTime() < ELAPSED_NOTE_MIN_MS) return null;
  return buildElapsedNote(previous, now, timeZone);
}
