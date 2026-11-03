import { describe, expect, it } from 'vitest';
import {
  isUnsupportedCommand,
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

  it('leaves out an alias that a skill uses as its name, because the CLI runs the skill', () => {
    const commands = [...CLI_COMMANDS, { name: 'reset', description: 'Reset the weekly board (project)', argumentHint: '' }];
    const unsupported = unsupportedBuiltinCommands(commands);
    expect([...unsupported].sort()).toEqual(['clear', 'context', 'model', 'new']);
    expect(isUnsupportedCommand('/reset weekly', unsupported)).toBe(false);
  });

  it('reads a skill listed under its display title from the names system/init runs', () => {
    // CLI 2.1.303 lists .claude/skills/reset (name: Reset Board) as "Reset Board"
    // with no aliases; only system/init shows the "reset" that /reset runs.
    const commands = [...CLI_COMMANDS, { name: 'Reset Board', description: 'Reset the weekly board (project)', argumentHint: '' }];
    const runnable = ['order-canvas-print', 'weekly-report', 'reset', 'clear', 'compact', 'model', 'context'];
    expect([...unsupportedBuiltinCommands(commands, runnable)].sort()).toEqual(['clear', 'context', 'model', 'new']);
  });

  it('blocks an alias again once system/init stops listing the skill that took it', () => {
    const commands = [...CLI_COMMANDS, { name: 'reset', description: 'Reset the weekly board (project)', argumentHint: '' }];
    const runnable = ['order-canvas-print', 'weekly-report', 'clear', 'compact', 'model', 'context'];
    expect(unsupportedBuiltinCommands(commands, runnable).has('reset')).toBe(true);
  });

  it('still blocks /clear and its aliases when the command list could not be read', () => {
    expect([...unsupportedBuiltinCommands(undefined)].sort()).toEqual(['clear', 'new', 'reset']);
    expect([...unsupportedBuiltinCommands(undefined, ['reset'])].sort()).toEqual(['clear', 'new']);
  });
});

describe('isUnsupportedCommand', () => {
  const unsupported = unsupportedBuiltinCommands(CLI_COMMANDS);

  it.each(['/clear', '/clear my notes', '/new', '/reset', '/model opus', '/context'])('matches %j', (text) => {
    expect(isUnsupportedCommand(text, unsupported)).toBe(true);
  });

  it.each(['/compact', '/order-canvas-print', '/weekly-report', '/Clear', ' /clear', 'please /clear', 'hello'])(
    'does not match %j',
    (text) => {
      expect(isUnsupportedCommand(text, unsupported)).toBe(false);
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
