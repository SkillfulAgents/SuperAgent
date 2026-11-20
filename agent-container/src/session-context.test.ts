import { describe, expect, it } from 'vitest';
import { mergeSessionContext } from './session-context';

describe('mergeSessionContext', () => {
  it('takes what a message says and keeps what it leaves out', () => {
    const stored = { session_trigger: 'user', channel: 'ui', sender: { id: 'u-dana', name: 'Dana', type: 'human' } };
    expect(mergeSessionContext(stored, { sender: { id: 'u-ben', name: 'Ben', type: 'human' } })).toEqual({
      session_trigger: 'user',
      channel: 'ui',
      sender: { id: 'u-ben', name: 'Ben', type: 'human' },
    });
    expect(mergeSessionContext(stored, undefined)).toEqual(stored);
  });

  it('drops a stored context that no longer parses', () => {
    expect(mergeSessionContext({ session_trigger: 42 }, { channel: 'ui', sender: { type: 'human' } })).toEqual({ channel: 'ui', sender: { type: 'human' } });
  });
});
