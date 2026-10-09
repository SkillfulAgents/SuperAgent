import { forkEntrySchema } from './transcript-entry-schema';

/**
 * The SDK's forkSession stamps the fork's last copied line with the fork time.
 * Give each copied line its source line's timestamp back. Lines that are not
 * copies, or whose source line is gone, stay verbatim.
 */
export function restoreSourceTimestamps(source: string, fork: string): string {
  const sourceTimestamps = new Map<string, string>();
  for (const line of source.split('\n')) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { continue; }
    const entry = forkEntrySchema.safeParse(raw);
    if (entry.success) sourceTimestamps.set(entry.data.uuid, entry.data.timestamp);
  }

  return fork.split('\n').map(line => {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return line; }
    const entry = forkEntrySchema.safeParse(raw);
    if (!entry.success || !entry.data.forkedFrom || typeof raw !== 'object' || raw === null) return line;
    const timestamp = sourceTimestamps.get(entry.data.forkedFrom.messageUuid);
    if (!timestamp || timestamp === entry.data.timestamp) return line;
    return JSON.stringify({ ...raw, timestamp });
  }).join('\n');
}
