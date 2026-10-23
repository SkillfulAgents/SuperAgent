import { describe, expect, it } from 'vitest';
import {
  makeUnsupportedCommandInert,
  mergeCanonicalSlashCommands,
  unsupportedBuiltinCommands,
} from './slash-commands';

// Shaped like the SDK 0.3.303 initialize response.
const CLI_COMMANDS = [
  { name: 'Order Canvas Print', description: 'Order a print (project)', argumentHint: '', aliases: ['order-canvas-print'] },
  { name: 'weekly-report', description: 'Weekly report (project)', argumentHint: '' },
  { name: 'clear', description: 'Start a new session with empty context', argumentHint: '[name]', aliases: ['reset', 'new'], builtin: true },
  { name: 'compact', description: 'Free up context', argumentHint: '<instructions>', builtin: true },
  { name: 'model', description: 'Set the AI model', argumentHint: '<model>', builtin: true },
  { name: 'context', description: 'Show current context usage', argumentHint: '', builtin: true },
];

describe('unsupportedBuiltinCommands', () => {
  it('lists unsupported built-ins with their aliases, and leaves skills, custom commands and supported built-ins out', () => {
    expect([...unsupportedBuiltinCommands(CLI_COMMANDS)].sort()).toEqual(['clear', 'context', 'model', 'new', 'reset']);
  });
});

describe('makeUnsupportedCommandInert', () => {
  const unsupported = unsupportedBuiltinCommands(CLI_COMMANDS);

  it.each(['/clear', '/clear my notes', '/new', '/reset', '/model opus', '/context'])('turns %j into plain text', (text) => {
    expect(makeUnsupportedCommandInert(text, unsupported)).toBe(` ${text}`);
  });

  it.each(['/compact', '/order-canvas-print', '/weekly-report', '/Clear', 'please /clear', 'hello'])(
    'leaves %j unchanged',
    (text) => {
      expect(makeUnsupportedCommandInert(text, unsupported)).toBe(text);
    },
  );
});

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
