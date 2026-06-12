import { describe, it, expect } from 'vitest'
import { prepareEvalScript, finalizeEvalOutput, evalErrorHint } from './eval-script'

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
