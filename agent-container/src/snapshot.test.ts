import { describe, it, expect, vi } from 'vitest';
import { takeSnapshot, invalidate, buildScopeCandidates, __test } from './snapshot';

const { truncateToDepth } = __test;

const TREE = [
  '- WebArea "Title"',
  '  - banner',
  '    - link "Logo"',
  '  - main',
  '    - heading "Welcome"',
  '      - text "Hello world"',
  '    - button "Sign in" [ref=e1]',
].join('\n');

describe('truncateToDepth', () => {
  it('depth=0 keeps only the root', () => {
    expect(truncateToDepth(TREE, 0)).toBe('- WebArea "Title"');
  });

  it('depth=1 keeps root + landmarks', () => {
    expect(truncateToDepth(TREE, 1)).toBe(
      ['- WebArea "Title"', '  - banner', '  - main'].join('\n')
    );
  });

  it('depth=2 keeps three levels', () => {
    expect(truncateToDepth(TREE, 2)).toBe(
      [
        '- WebArea "Title"',
        '  - banner',
        '    - link "Logo"',
        '  - main',
        '    - heading "Welcome"',
        '    - button "Sign in" [ref=e1]',
      ].join('\n')
    );
  });

  it('depth large enough keeps everything', () => {
    expect(truncateToDepth(TREE, 99)).toBe(TREE);
  });
});

describe('buildScopeCandidates', () => {
  it('passes CSS / XPath through unchanged', () => {
    expect(buildScopeCandidates('[role=dialog]')).toEqual(['[role=dialog]']);
    expect(buildScopeCandidates('#login')).toEqual(['#login']);
    expect(buildScopeCandidates('form.login')).toEqual(['form.login']);
    expect(buildScopeCandidates('nav > ul')).toEqual(['nav > ul']);
    expect(buildScopeCandidates('//main')).toEqual(['//main']);
  });
});

describe('takeSnapshot', () => {
  it('caches navigate snapshots and returns a shallow page map', async () => {
    invalidate('s1');
    const exec = vi.fn(async (args: string[]) => ({
      stdout: TREE,
      exitCode: 0,
    }));

    const r1 = await takeSnapshot('s1', {}, null, exec);
    expect(r1).toEqual({
      ok: true,
      text: ['- WebArea "Title"', '  - banner', '  - main'].join('\n'),
    });
    expect(exec).toHaveBeenCalledTimes(1);

    const r2 = await takeSnapshot('s1', {}, null, exec);
    expect(r2).toEqual(r1);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('invalidate clears the cache', async () => {
    invalidate('s2');
    const exec = vi.fn(async () => ({ stdout: TREE, exitCode: 0 }));
    await takeSnapshot('s2', {}, null, exec);
    invalidate('s2');
    await takeSnapshot('s2', {}, null, exec);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('scope by CSS selector passes the selector through', async () => {
    invalidate('s3');
    const exec = vi.fn(async (args: string[]) => {
      const scopeArg = args[args.indexOf('-s') + 1];
      if (scopeArg === '[aria-label="Repository"]') {
        return { stdout: '- navigation "Repository" [ref=e7]', exitCode: 0 };
      }
      return { stdout: "Selector didn't match", exitCode: 1 };
    });

    const r = await takeSnapshot('s3', { scope: '[aria-label="Repository"]' }, null, exec);
    expect(r).toEqual({ ok: true, text: '- navigation "Repository" [ref=e7]' });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('scope by plain CSS selector is attempted once', async () => {
    invalidate('s4');
    const exec = vi.fn(async (args: string[]) => {
      const scopeArg = args[args.indexOf('-s') + 1];
      if (scopeArg === 'main') return { stdout: '- main', exitCode: 0 };
      return { stdout: 'no match', exitCode: 1 };
    });

    const r = await takeSnapshot('s4', { scope: 'main' }, null, exec);
    expect(r).toEqual({ ok: true, text: '- main' });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('returns error when all scope candidates fail', async () => {
    invalidate('s5');
    const exec = vi.fn(async () => ({ stdout: 'nope', exitCode: 1 }));

    const r = await takeSnapshot('s5', { scope: 'Nonexistent' }, null, exec);
    expect(r).toEqual({ ok: false, error: 'nope' });
  });

  it('navigate mode returns a shallow page map', async () => {
    invalidate('s6');
    const exec = vi.fn(async () => ({ stdout: TREE, exitCode: 0 }));
    const r = await takeSnapshot('s6', {}, null, exec);
    expect(r).toEqual({
      ok: true,
      text: ['- WebArea "Title"', '  - banner', '  - main'].join('\n'),
    });
  });

  it('scoped navigate snapshots stay shallow', async () => {
    invalidate('s7');
    const exec = vi.fn(async (args: string[]) => ({ stdout: TREE, exitCode: 0 }));
    const r = await takeSnapshot('s7', { scope: 'Repository' }, null, exec);
    expect(r).toEqual({
      ok: true,
      text: ['- WebArea "Title"', '  - banner', '  - main'].join('\n'),
    });
    expect(exec).toHaveBeenCalled();
    const calledArgs = exec.mock.calls[0]![0] as string[];
    expect(calledArgs).not.toContain('-d');
  });

  it('detailed mode requires scope', async () => {
    invalidate('s10');
    const exec = vi.fn(async () => ({ stdout: TREE, exitCode: 0 }));
    const r = await takeSnapshot('s10', { mode: 'detailed' }, null, exec);
    expect(r).toEqual({
      ok: false,
      error: 'mode "detailed" requires scope. First use the default navigation snapshot to identify a CSS/XPath selector, then retry with mode "detailed" and scope.',
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('scoped detailed mode returns the full snapshot without -d', async () => {
    invalidate('s11');
    const exec = vi.fn(async (args: string[]) => ({
      stdout: args.includes('-d') ? '(empty page)' : TREE,
      exitCode: 0,
    }));
    const r = await takeSnapshot('s11', { mode: 'detailed', scope: 'main' }, null, exec);
    expect(r).toEqual({ ok: true, text: TREE });
    expect(exec.mock.calls[0]![0]).toEqual(['snapshot', '-c', '-i', '-s', 'main']);
  });

  it('interactive=false is independent from mode', async () => {
    invalidate('s12');
    const exec = vi.fn(async (args: string[]) => ({ stdout: args.join(' '), exitCode: 0 }));
    await takeSnapshot('s12', { interactive: false }, null, exec);
    expect(exec.mock.calls[0]![0]).toEqual(['snapshot', '-c']);
  });

  it('compact=false is independent from mode', async () => {
    invalidate('s13');
    const exec = vi.fn(async (args: string[]) => ({ stdout: args.join(' '), exitCode: 0 }));
    await takeSnapshot('s13', { compact: false }, null, exec);
    expect(exec.mock.calls[0]![0]).toEqual(['snapshot', '-i']);
  });
});
