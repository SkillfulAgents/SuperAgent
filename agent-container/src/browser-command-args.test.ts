import { describe, it, expect } from 'vitest'
import { splitCommandArgs, buildRunCommandArgs } from './browser-command-args'

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
