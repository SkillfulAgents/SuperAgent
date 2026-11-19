import { describe, expect, it } from 'vitest';
import { restoreSourceTimestamps } from './fork-timestamps';

const jsonl = (...entries: unknown[]) => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
const forkedFrom = (messageUuid: string) => ({ sessionId: 'source', messageUuid });

describe('restoreSourceTimestamps', () => {
  it('gives every copied line its source time and keeps every other line verbatim', () => {
    const source = jsonl(
      { type: 'user', uuid: 'u1', timestamp: '2026-08-12T21:50:07.457Z' },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-08-12T21:50:19.829Z', message: { content: [] } },
    );
    const user = { type: 'user', uuid: 'f1', timestamp: '2026-09-29T01:30:00.000Z', forkedFrom: forkedFrom('u1') };
    const orphan = { type: 'user', uuid: 'f2', timestamp: '2026-09-29T01:31:00.000Z', forkedFrom: forkedFrom('gone') };
    const assistant = { type: 'assistant', uuid: 'f3', timestamp: '2026-09-29T01:32:23.192Z', message: { content: [] }, forkedFrom: forkedFrom('a1') };
    const title = { type: 'custom-title', customTitle: 'x (fork)', uuid: 'f4', timestamp: '2026-09-29T01:32:23.192Z' };
    const fork = jsonl(user, orphan, assistant, title) + '{partial';

    const actual = restoreSourceTimestamps(source, fork);

    expect(actual).toBe(jsonl(
      { ...user, timestamp: '2026-08-12T21:50:07.457Z' },
      orphan,
      { ...assistant, timestamp: '2026-08-12T21:50:19.829Z' },
      title,
    ) + '{partial');
    expect(restoreSourceTimestamps(source, actual)).toBe(actual);
  });
});
