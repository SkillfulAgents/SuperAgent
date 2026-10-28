import { describe, expect, it } from 'vitest'
import { runRule } from './sandbox'

const run = (code: string, input: unknown = {}) => runRule(code, input)

describe('runRule', () => {
  it('allows only on a literal true', async () => {
    expect((await run('() => true')).result).toBe('true')
    expect((await run('() => false')).result).toBe('false')
    expect(await run('() => 1')).toEqual({ result: 'non_boolean', detail: 'number' })
    expect(await run('() => "true"')).toEqual({ result: 'non_boolean', detail: 'string' })
    expect(await run('() => null')).toEqual({ result: 'non_boolean', detail: 'null' })
    expect(await run('async () => true')).toEqual({ result: 'non_boolean', detail: 'promise' })
  })

  it('passes the input and helpers', async () => {
    expect((await run('(req) => req.amount === 5', { amount: 5 })).result).toBe('true')
    expect((await run('(req, h) => h.toNumber("12.5") === 12.5')).result).toBe('true')
  })

  it('reports throws, syntax errors and non-functions', async () => {
    expect(await run('() => { throw new Error("boom") }')).toEqual({ result: 'threw', detail: 'Error: boom' })
    expect((await run('(req) => req.missing.deep')).result).toBe('threw')
    expect((await run('() => {')).result).toBe('invalid_code')
    expect(await run('42')).toEqual({ result: 'invalid_code', detail: 'rule is not a function' })
    expect((await run('(() => { throw new Error("at definition") })()')).result).toBe('invalid_code')
  })

  it('times out runaway code', async () => {
    expect(await run('() => { while (true) {} }')).toEqual({ result: 'timeout' })
    expect(await run('(() => { while (true) {} })()')).toEqual({ result: 'timeout' })
    // Catastrophic backtracking driven by agent-controlled input.
    const evil = { s: 'a'.repeat(40) + '!' }
    expect(await run('(req) => /^(a+)+$/.test(req.s)', evil)).toEqual({ result: 'timeout' })
  })

  it('does not run a thrown object\'s getters outside the timeout', async () => {
    const outcome = await run('() => { throw { get message() { while (true) {} } } }')
    expect(outcome.result).toBe('timeout')
  })

  it('freezes the input and keeps no state between runs', async () => {
    expect((await run('(req) => { req.x = 1; return req.x === 1 }', { x: 0 })).result).toBe('threw')
    expect((await run('() => { globalThis.count = (globalThis.count || 0) + 1; return globalThis.count === 1 }')).result).toBe('true')
    expect((await run('() => { globalThis.count = (globalThis.count || 0) + 1; return globalThis.count === 1 }')).result).toBe('true')
  })

  it('treats __proto__ keys as plain data', async () => {
    const input = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}')
    expect((await run('(req) => ({}).polluted === undefined && req.a === 1', input)).result).toBe('true')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('survives a rule that exhausts its memory, and keeps answering', async () => {
    // Filling the sandbox's heap aborts the sandbox process, never the app.
    // A long time limit, so the allocation (not the clock) is what stops it.
    // Flat double arrays hit the limit in ~100 ms; one huge array (dictionary
    // mode) spent seconds in GC first and outlasted the limit on a loaded runner.
    const outcome = await runRule('() => { const chunks = []; for (;;) chunks.push(new Array(1e5).fill(0.5)) }', {}, { timeoutMs: 5_000 })
    expect(outcome).toEqual({ result: 'threw', detail: 'the rule crashed or ran out of memory' })
    expect((await run('() => true')).result).toBe('true')
  }, 20_000)

  it('runs rules off the main thread', async () => {
    let ticks = 0
    const timer = setInterval(() => ticks++, 5)
    const outcomes = await Promise.all([run('() => { for (;;) {} }'), run('() => { for (;;) {} }'), run('() => { for (;;) {} }')])
    clearInterval(timer)
    expect(outcomes.map((o) => o.result)).toEqual(['timeout', 'timeout', 'timeout'])
    expect(ticks).toBeGreaterThan(5)
  })

  it('gives rules no route to the host realm', async () => {
    expect((await run('() => typeof process === "undefined" && typeof require === "undefined"')).result).toBe('true')
    expect((await run('(req, h) => { try { h.toNumber.constructor("return process")(); return false } catch (e) { return true } }')).result).toBe('true')
    expect((await run('() => { try { eval("1"); return false } catch (e) { return true } }')).result).toBe('true')
  })
})
