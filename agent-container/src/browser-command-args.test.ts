import { describe, it, expect } from 'vitest'
import { splitCommandArgs, buildRunCommandArgs, resolveRunCommandArgs } from './browser-command-args'

describe('splitCommandArgs', () => {
  it('splits simple commands on whitespace', () => {
    expect(splitCommandArgs('click @e1')).toEqual(['click', '@e1'])
  })

  it('handles multiple spaces between args', () => {
    expect(splitCommandArgs('get   text   @e1')).toEqual(['get', 'text', '@e1'])
  })

  it('handles tabs as separators', () => {
    expect(splitCommandArgs("get\ttext\t@e1")).toEqual(['get', 'text', '@e1'])
  })

  it('strips double quotes and groups content', () => {
    expect(splitCommandArgs('get text "hello world"')).toEqual(['get', 'text', 'hello world'])
  })

  it('strips single quotes and groups content', () => {
    expect(splitCommandArgs("fill @e2 'hello world'")).toEqual(['fill', '@e2', 'hello world'])
  })

  it('handles single arg with no spaces', () => {
    expect(splitCommandArgs('reload')).toEqual(['reload'])
  })

  it('handles empty string', () => {
    expect(splitCommandArgs('')).toEqual([])
  })

  it('handles whitespace-only string', () => {
    expect(splitCommandArgs('   ')).toEqual([])
  })

  it('preserves double quotes inside single quotes', () => {
    expect(splitCommandArgs(`fill @e1 'say "hello"'`)).toEqual(['fill', '@e1', 'say "hello"'])
  })

  it('preserves single quotes inside double quotes', () => {
    expect(splitCommandArgs(`fill @e1 "it's fine"`)).toEqual(['fill', '@e1', "it's fine"])
  })

  it('handles adjacent quoted and unquoted text', () => {
    // splitCommandArgs treats quotes as delimiters that don't produce separators,
    // so content before/after quotes in the same "word" merges together
    expect(splitCommandArgs('get url')).toEqual(['get', 'url'])
  })

  it('handles leading/trailing whitespace', () => {
    expect(splitCommandArgs('  click @e1  ')).toEqual(['click', '@e1'])
  })

  // Regression guards for browser-tools audit F2: the old tokenizer treated any
  // quote as a group toggle and always stripped it, which corrupted live data.

  it('keeps an unpaired apostrophe as a literal (shipped "isnt" to live listings)', () => {
    expect(splitCommandArgs("type @e28 when chat isn't enough")).toEqual([
      'type', '@e28', 'when', 'chat', "isn't", 'enough',
    ])
  })

  it('preserves quotes interior to a token (CSS attribute selectors)', () => {
    expect(splitCommandArgs('frame iframe[title="Secure payment input frame"]')).toEqual([
      'frame', 'iframe[title="Secure payment input frame"]',
    ])
  })

  it('preserves single-quoted attribute values inside a token', () => {
    expect(splitCommandArgs("wait div[data-test='submit area']")).toEqual([
      'wait', "div[data-test='submit area']",
    ])
  })

  it('still strips whole-token quotes after a flag', () => {
    expect(splitCommandArgs('find role button click --name "View demo"')).toEqual([
      'find', 'role', 'button', 'click', '--name', 'View demo',
    ])
  })

  it('supports backslash-escaped quotes', () => {
    expect(splitCommandArgs('fill @e1 "say \\"hi\\" now"')).toEqual(['fill', '@e1', 'say "hi" now'])
    expect(splitCommandArgs("type @e1 don\\'t")).toEqual(['type', '@e1', "don't"])
  })

  it('paired apostrophes in prose group but never lose characters', () => {
    // Two apostrophes pair up and group the span between them; the quote marks
    // are kept (interior), so rejoining with spaces reproduces the original text.
    const args = splitCommandArgs("type @e1 it's Gamut's turn")
    expect(args.slice(0, 2)).toEqual(['type', '@e1'])
    expect(args.slice(2).join(' ')).toBe("it's Gamut's turn")
  })
})

describe('buildRunCommandArgs', () => {
  describe('non-eval commands (uses splitCommandArgs)', () => {
    it('splits simple commands normally', () => {
      expect(buildRunCommandArgs('click @e1')).toEqual(['click', '@e1'])
    })

    it('splits get commands normally', () => {
      expect(buildRunCommandArgs('get text @e1')).toEqual(['get', 'text', '@e1'])
    })

    it('splits fill with quoted value', () => {
      expect(buildRunCommandArgs('fill @e2 "hello world"')).toEqual(['fill', '@e2', 'hello world'])
    })

    it('returns empty array for empty command', () => {
      expect(buildRunCommandArgs('')).toEqual([])
    })

    it('returns empty array for whitespace-only', () => {
      expect(buildRunCommandArgs('   ')).toEqual([])
    })

    it('handles back/forward/reload', () => {
      expect(buildRunCommandArgs('back')).toEqual(['back'])
      expect(buildRunCommandArgs('forward')).toEqual(['forward'])
      expect(buildRunCommandArgs('reload')).toEqual(['reload'])
    })

    it('handles wait with CSS selector', () => {
      expect(buildRunCommandArgs('wait "#loading"')).toEqual(['wait', '#loading'])
    })

    it('handles type command with text', () => {
      expect(buildRunCommandArgs('type @e1 hello')).toEqual(['type', '@e1', 'hello'])
    })
  })

  describe('eval commands (preserves raw JS expression)', () => {
    it('preserves single-quoted strings in querySelector', () => {
      const cmd = `eval document.querySelector('input[placeholder*="looking"]').click()`
      const args = buildRunCommandArgs(cmd)
      expect(args).toEqual([
        'eval',
        `document.querySelector('input[placeholder*="looking"]').click()`,
      ])
    })

    it('preserves double-quoted strings in querySelector', () => {
      const cmd = `eval document.querySelector("input[placeholder*='looking for']").click()`
      const args = buildRunCommandArgs(cmd)
      expect(args).toEqual([
        'eval',
        `document.querySelector("input[placeholder*='looking for']").click()`,
      ])
    })

    it('preserves quoted string assignment', () => {
      const cmd = `eval document.activeElement.value = 'Sigal Shaked Datawizz'`
      const args = buildRunCommandArgs(cmd)
      expect(args).toEqual([
        'eval',
        `document.activeElement.value = 'Sigal Shaked Datawizz'`,
      ])
    })

    it('preserves nested quotes in complex expressions', () => {
      const cmd = `eval document.querySelector('input[placeholder*="looking"]') && document.querySelector('input[placeholder*="looking"]').click()`
      const args = buildRunCommandArgs(cmd)
      expect(args).toEqual([
        'eval',
        `document.querySelector('input[placeholder*="looking"]') && document.querySelector('input[placeholder*="looking"]').click()`,
      ])
    })

    it('preserves template literals', () => {
      const cmd = 'eval `hello ${1 + 2} world`'
      const args = buildRunCommandArgs(cmd)
      expect(args).toEqual(['eval', '`hello ${1 + 2} world`'])
    })

    it('preserves JSON strings', () => {
      const cmd = `eval JSON.parse('{"key": "value"}')`
      const args = buildRunCommandArgs(cmd)
      expect(args).toEqual(['eval', `JSON.parse('{"key": "value"}')`])
    })

    it('preserves arrow functions with string args', () => {
      const cmd = `eval document.querySelectorAll('a').forEach(el => el.textContent = 'clicked')`
      const args = buildRunCommandArgs(cmd)
      expect(args).toEqual([
        'eval',
        `document.querySelectorAll('a').forEach(el => el.textContent = 'clicked')`,
      ])
    })

    it('preserves regex literals', () => {
      const cmd = `eval /test pattern/.test('test pattern here')`
      const args = buildRunCommandArgs(cmd)
      expect(args).toEqual(['eval', `/test pattern/.test('test pattern here')`])
    })

    it('handles simple eval without quotes', () => {
      const cmd = 'eval document.title'
      const args = buildRunCommandArgs(cmd)
      expect(args).toEqual(['eval', 'document.title'])
    })

    it('handles eval with no expression', () => {
      expect(buildRunCommandArgs('eval')).toEqual(['eval'])
    })

    it('handles eval with only whitespace after', () => {
      expect(buildRunCommandArgs('eval   ')).toEqual(['eval'])
    })

    // Verify tab new commands pass through without rewrite (0.12.0 workaround removed)
    it('passes tab new commands through as-is', () => {
      expect(buildRunCommandArgs('tab new https://example.com')).toEqual(['tab', 'new', 'https://example.com'])
      expect(buildRunCommandArgs('tab new')).toEqual(['tab', 'new'])
    })

    it('passes other tab commands through unchanged', () => {
      expect(buildRunCommandArgs('tab')).toEqual(['tab'])
      expect(buildRunCommandArgs('tab 2')).toEqual(['tab', '2'])
      expect(buildRunCommandArgs('tab close')).toEqual(['tab', 'close'])
    })

    it('handles eval with extra leading whitespace before expression', () => {
      const cmd = 'eval   document.title'
      const args = buildRunCommandArgs(cmd)
      expect(args).toEqual(['eval', 'document.title'])
    })

    it('preserves multiline-style expressions (newlines in string)', () => {
      const cmd = `eval (function() { var x = 'hello'; return x; })()`
      const args = buildRunCommandArgs(cmd)
      expect(args).toEqual([
        'eval',
        `(function() { var x = 'hello'; return x; })()`,
      ])
    })

    it('preserves Promise-based expressions', () => {
      const cmd = `eval new Promise(r => setTimeout(r, 1000)).then(() => 'done')`
      const args = buildRunCommandArgs(cmd)
      expect(args).toEqual([
        'eval',
        `new Promise(r => setTimeout(r, 1000)).then(() => 'done')`,
      ])
    })

    it('preserves window.location assignment', () => {
      const cmd = `eval window.location.href = 'https://example.com'`
      const args = buildRunCommandArgs(cmd)
      expect(args).toEqual([
        'eval',
        `window.location.href = 'https://example.com'`,
      ])
    })
  })
})

describe('resolveRunCommandArgs', () => {
  it('passes a pre-tokenized args array through verbatim — no tokenization, no escaping', () => {
    expect(resolveRunCommandArgs({ args: ['type', '@e1', "chat isn't enough"] })).toEqual({
      args: ['type', '@e1', "chat isn't enough"],
    })
    expect(resolveRunCommandArgs({ args: ['frame', 'iframe[title="Secure payment input frame"]'] })).toEqual({
      args: ['frame', 'iframe[title="Secure payment input frame"]'],
    })
    expect(resolveRunCommandArgs({ args: ['eval', "document.title + ' done'"] })).toEqual({
      args: ['eval', "document.title + ' done'"],
    })
  })

  it('tokenizes the command string form via buildRunCommandArgs', () => {
    expect(resolveRunCommandArgs({ command: 'fill @e2 "hello world"' })).toEqual({
      args: ['fill', '@e2', 'hello world'],
    })
  })

  it('rejects providing both command and args', () => {
    const r = resolveRunCommandArgs({ command: 'get url', args: ['get', 'url'] })
    expect(r.error).toMatch(/not both/)
  })

  it('rejects providing neither', () => {
    expect(resolveRunCommandArgs({}).error).toBeDefined()
    expect(resolveRunCommandArgs({ command: '   ' }).error).toBeDefined()
  })

  it('rejects malformed args arrays', () => {
    expect(resolveRunCommandArgs({ args: [] }).error).toMatch(/non-empty array/)
    expect(resolveRunCommandArgs({ args: ['get', 42] as unknown as string[] }).error).toMatch(/array of strings/)
    expect(resolveRunCommandArgs({ args: 'get url' as unknown as string[] }).error).toMatch(/array of strings/)
    expect(resolveRunCommandArgs({ args: ['', 'url'] }).error).toMatch(/command verb/)
  })
})
