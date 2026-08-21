import { describe, it, expect } from 'vitest'
import { prepareEvalScript, scanTopLevel, finalizeEvalOutput, evalErrorHint } from './eval-script'

describe('prepareEvalScript', () => {
  it('auto-invokes a bare arrow function (the {} trap)', () => {
    expect(prepareEvalScript('() => { return 1; }')).toEqual({ script: '(() => { return 1; })()', wrapped: true })
  })

  it('auto-invokes a parenthesized arrow function', () => {
    expect(prepareEvalScript('(() => { return document.title; })')).toEqual({
      script: '((() => { return document.title; }))()',
      wrapped: true,
    })
  })

  it('auto-invokes async arrows and function expressions', () => {
    expect(prepareEvalScript('async () => await fetch("/x")').wrapped).toBe(true)
    expect(prepareEvalScript('function() { return 1 }').wrapped).toBe(true)
    expect(prepareEvalScript('x => x * 2').wrapped).toBe(true)
  })

  it('strips trailing semicolons before wrapping', () => {
    expect(prepareEvalScript('() => 1;')).toEqual({ script: '(() => 1)()', wrapped: true })
  })

  it('leaves invoked IIFEs untouched', () => {
    const iife = '(() => { return 1; })()'
    expect(prepareEvalScript(iife)).toEqual({ script: iife, wrapped: false })
    const withArgs = '((x) => x + 1)(41)'
    expect(prepareEvalScript(withArgs)).toEqual({ script: withArgs, wrapped: false })
    const nestedArg = '((x) => x)(f(2))'
    expect(prepareEvalScript(nestedArg)).toEqual({ script: nestedArg, wrapped: false })
  })

  it('leaves plain expressions untouched', () => {
    for (const expr of [
      'document.title',
      '(a || b).method()',
      "JSON.stringify([...document.querySelectorAll('iframe')].map((f, i) => ({ i })))",
      "[...document.querySelectorAll('a')].map(x => x.href)",
      '1 + 2',
    ]) {
      expect(prepareEvalScript(expr)).toEqual({ script: expr, wrapped: false })
    }
  })

  it('wraps a top-level return in a fresh async scope (fixes "Illegal return")', () => {
    expect(prepareEvalScript('const t = document.title; return t;')).toEqual({
      script: '(async () => {\nconst t = document.title; return t\n})()',
      wrapped: true,
    })
  })

  it('wraps top-level const/let so it cannot collide across calls ("already declared")', () => {
    expect(prepareEvalScript('const x = 1; foo(x)').wrapped).toBe(true)
    expect(prepareEvalScript('let y = 2; y').wrapped).toBe(true)
    expect(prepareEvalScript('const x = 1; foo(x)').script).toContain('(async () => {')
  })

  it('does NOT wrap an expression whose return/decl live inside a nested function (depth>0)', () => {
    // the inner return must not be mistaken for a top-level statement, or the
    // array value would be lost to an undefined function body
    const expr = '[...document.querySelectorAll("a")].map(a => { return a.href })'
    expect(prepareEvalScript(expr)).toEqual({ script: expr, wrapped: false })
    const filt = 'rows.filter(r => { const v = r.value; return v > 0 })'
    expect(prepareEvalScript(filt)).toEqual({ script: filt, wrapped: false })
  })

  it('wraps a plain top-level await expression while preserving its value', () => {
    expect(prepareEvalScript('await fetch("/x").then(r => r.json())')).toEqual({
      script: '(async () => (await fetch("/x").then(r => r.json())))()',
      wrapped: true,
    })
  })

  it('wraps multiple top-level statements', () => {
    expect(prepareEvalScript('document.querySelector("#a").remove(); document.querySelector("#b").click()').wrapped).toBe(true)
  })

  it('does not treat keywords inside strings as statements', () => {
    expect(prepareEvalScript('document.querySelector("[data-x=\'return\']")')).toEqual({
      script: 'document.querySelector("[data-x=\'return\']")',
      wrapped: false,
    })
  })

  it('handles empty / whitespace input', () => {
    expect(prepareEvalScript('   ')).toEqual({ script: '   ', wrapped: false })
  })
})

describe('scanTopLevel', () => {
  it('detects top-level statement keywords', () => {
    expect(scanTopLevel('return 5').isStatementBody).toBe(true)
    expect(scanTopLevel('const x = 1').isStatementBody).toBe(true)
    expect(scanTopLevel('if (a) b()').isStatementBody).toBe(true)
  })
  it('ignores keywords nested in functions, strings, and member access', () => {
    expect(scanTopLevel('xs.map(x => { return x })').isStatementBody).toBe(false)
    expect(scanTopLevel('el.return').isStatementBody).toBe(false)
    expect(scanTopLevel('f("const y")').isStatementBody).toBe(false)
    expect(scanTopLevel('returnValue + 1').isStatementBody).toBe(false) // not the keyword
  })
  it('reports top-level await', () => {
    expect(scanTopLevel('await x()').hasAwait).toBe(true)
    expect(scanTopLevel('xs.map(async x => await f(x))').hasAwait).toBe(false)
  })
})

describe('finalizeEvalOutput', () => {
  it('passes short output through unchanged', () => {
    expect(finalizeEvalOutput('hello')).toBe('hello')
  })

  it('truncates long output with an actionable notice', () => {
    const long = 'x'.repeat(10_000)
    const out = finalizeEvalOutput(long)
    expect(out.length).toBeLessThan(8_300)
    expect(out).toContain('truncated — result was 10000 chars')
    expect(out).toContain('JSON.stringify')
  })
})

describe('evalErrorHint', () => {
  it('adds the top-frame hint for null-property errors', () => {
    const hinted = evalErrorHint("✗ Evaluation error: TypeError: Cannot read properties of null (reading 'click')")
    expect(hinted).toContain('TOP frame only')
    expect(hinted).toContain('browser_type')
  })

  it('adds the quoting hint for invalid-selector errors', () => {
    const hinted = evalErrorHint("✗ Evaluation error: SyntaxError: 'iframe[title=Payment frame]' is not a valid selector.")
    expect(hinted).toContain('must be quoted')
  })

  it('passes other errors through unchanged', () => {
    expect(evalErrorHint('✗ Evaluation error: ReferenceError: foo is not defined')).toBe(
      '✗ Evaluation error: ReferenceError: foo is not defined'
    )
  })
})
