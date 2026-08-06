import { describe, expect, it } from 'vitest';
import { mergeCanonicalSlashCommands } from './slash-commands';

describe('mergeCanonicalSlashCommands', () => {
  it('keeps executable slugs and attaches rich skill details', () => {
    expect(mergeCanonicalSlashCommands(
      ['compact', 'order-canvas-print'],
      [
        { name: 'compact', description: 'Free up context', argumentHint: '<instructions>' },
        { name: 'Order Canvas Print', description: 'Order a framed canvas', argumentHint: '<image>' },
      ],
    )).toEqual([
      { name: 'compact', description: 'Free up context', argumentHint: '<instructions>' },
      { name: 'order-canvas-print', description: 'Order a framed canvas', argumentHint: '<image>' },
    ]);
  });

  it('keeps every canonical command and leaves unmatched details empty', () => {
    expect(mergeCanonicalSlashCommands(
      ['review', 'new-command'],
      [{ name: 'review', description: 'Review a PR', argumentHint: '[number]' }],
    )).toEqual([
      { name: 'review', description: 'Review a PR', argumentHint: '[number]' },
      { name: 'new-command', description: '', argumentHint: '' },
    ]);
  });

  it('falls back to rich commands when an older init has no canonical list', () => {
    const commands = [{ name: 'review', description: 'Review a PR', argumentHint: '[number]' }];
    expect(mergeCanonicalSlashCommands([], commands)).toEqual(commands);
  });
});
