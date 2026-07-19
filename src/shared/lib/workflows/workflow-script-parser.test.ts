/* eslint-disable no-template-curly-in-string -- these strings embed workflow-script SOURCE (literal `${expr}`), not interpolation */
import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { readFileSync } from 'fs'
import { parseWorkflowScript } from './workflow-script-parser'

const FIXTURE_SCRIPT = path.join(
  __dirname,
  '..',
  'container',
  '__fixtures__',
  'local-workflow-capture-probe',
  'd63a9cbc-2f5e-44dd-8017-231ac99bef35',
  'workflows',
  'scripts',
  'capture-probe-wf_818f758a-c17.js'
)

describe('parseWorkflowScript — real capture-probe fixture', () => {
  const parsed = parseWorkflowScript(readFileSync(FIXTURE_SCRIPT, 'utf8'))

  it('extracts meta name/description/phases', () => {
    expect(parsed.name).toBe('capture-probe')
    expect(parsed.description).toBe('Minimal probe to exercise workflow machinery')
    expect(parsed.phases).toEqual([
      { title: 'Scan', detail: '2 parallel agents returning single words' },
      { title: 'Summarize', detail: '1 agent concatenating results' },
    ])
  })

  it('finds all three agent calls with label/phase/parallel', () => {
    expect(parsed.agentCalls).toHaveLength(3)

    const [alpha, beta, concat] = parsed.agentCalls
    expect(alpha.labelTemplate).toBe('word-alpha')
    expect(alpha.phase).toBe('Scan')
    expect(alpha.sourcePhase).toBe('Scan')
    expect(alpha.inParallel).toBe(true)
    expect(alpha.holeExprs).toEqual([])

    expect(beta.labelTemplate).toBe('word-beta')
    expect(beta.inParallel).toBe(true)

    expect(concat.labelTemplate).toBe('concat')
    expect(concat.phase).toBe('Summarize')
    expect(concat.inParallel).toBe(false)
    expect(concat.holeExprs).toEqual(['a', 'b'])
  })

  it('builds prompt regexes that match the resolved transcript prompts', () => {
    const [alpha, , concat] = parsed.agentCalls
    expect(new RegExp(alpha.promptRegexSource).test('Return ONLY the single word: alpha')).toBe(true)
    expect(new RegExp(alpha.promptRegexSource).test('Return ONLY the single word: beta')).toBe(false)

    // The concat prompt is a template with `${a}`/`${b}`; on disk those are resolved.
    const concatRe = new RegExp(concat.promptRegexSource)
    const m = concatRe.exec(
      'Concatenate these two words with a hyphen and return ONLY that: "alpha" and "beta". Expected output: alpha-beta'
    )
    expect(m).not.toBeNull()
    expect(m?.slice(1)).toEqual(['alpha', 'beta'])
  })
})

describe('parseWorkflowScript — synthetic edge cases', () => {
  it('handles parallel(map(...)) with templated label sharing the prompt var', () => {
    const src = [
      "export const meta = { name: 'planets', description: 'd', phases: [{ title: 'Gather' }] }",
      "phase('Gather')",
      'const facts = await parallel(planets.map((p) => () => agent(`Tell me a fun fact about ${p}. Keep it short.`, { label: `fact:${p}` })))',
    ].join('\n')
    const parsed = parseWorkflowScript(src)
    expect(parsed.name).toBe('planets')
    expect(parsed.agentCalls).toHaveLength(1)
    const call = parsed.agentCalls[0]
    expect(call.inParallel).toBe(true)
    expect(call.sourcePhase).toBe('Gather')
    expect(call.labelTemplate).toBe('fact:${p}')
    expect(call.holeExprs).toEqual(['p'])
    const m = new RegExp(call.promptRegexSource).exec('Tell me a fun fact about Mars. Keep it short.')
    expect(m?.slice(1)).toEqual(['Mars'])
  })

  it('tolerates nested backticks, parens, and a string inside ${expr}', () => {
    const src =
      'const x = await agent(`Run \\`npm test\\` and report (with details). Value: ${cfg.get("a")}`, { label: \'runner\', phase: \'P\' })'
    const parsed = parseWorkflowScript(src)
    expect(parsed.agentCalls).toHaveLength(1)
    const call = parsed.agentCalls[0]
    expect(call.labelTemplate).toBe('runner')
    expect(call.phase).toBe('P')
    expect(call.holeExprs).toEqual(['cfg.get("a")'])
    expect(new RegExp(call.promptRegexSource).test('Run `npm test` and report (with details). Value: 42')).toBe(
      true
    )
  })

  it('tags agent() calls inside args.<key>.map fan-outs with fanOutArgsKey', () => {
    const src = [
      "export const meta = { name: 'v', description: 'd', phases: [{ title: 'Analyze' }] }",
      "phase('Analyze')",
      'const analyses = (await parallel(args.videos.map(v => () => agent(`analyze ${v.id}`, { label: `analyze:${v.id}` })))).filter(Boolean)',
      "const plan = await agent('merge everything', { label: 'plan:merge' })",
    ].join('\n')
    const parsed = parseWorkflowScript(src)
    expect(parsed.agentCalls).toHaveLength(2)
    expect(parsed.agentCalls[0].fanOutArgsKey).toBe('videos')
    expect(parsed.agentCalls[1].fanOutArgsKey).toBeNull()
  })

  it('tags agent() calls inside pipeline(args.<key>, ...) stages', () => {
    const src = [
      "export const meta = { name: 'p', description: 'd', phases: [] }",
      "const out = await pipeline(args.items, x => agent(`do ${x}`, { label: `do:${x}` }), r => agent(`check ${r}`, { label: 'check' }))",
      "const done = await agent('wrap up', { label: 'wrap' })",
    ].join('\n')
    const parsed = parseWorkflowScript(src)
    expect(parsed.agentCalls).toHaveLength(3)
    expect(parsed.agentCalls[0].fanOutArgsKey).toBe('items')
    expect(parsed.agentCalls[1].fanOutArgsKey).toBe('items')
    expect(parsed.agentCalls[2].fanOutArgsKey).toBeNull()
  })

  it('does not size fan-outs over non-args or filtered collections', () => {
    const src = [
      "export const meta = { name: 'n', description: 'd', phases: [] }",
      // Runtime collection — length unknowable.
      'const a = await parallel(plan.techniques.map(t => () => agent(`build ${t}`, {})))',
      // Filtered args — args.videos.length would OVER-estimate; must stay untagged.
      'const b = await parallel(args.videos.filter(v => v.ok).map(v => () => agent(`redo ${v}`, {})))',
    ].join('\n')
    const parsed = parseWorkflowScript(src)
    expect(parsed.agentCalls).toHaveLength(2)
    expect(parsed.agentCalls[0].fanOutArgsKey).toBeNull()
    expect(parsed.agentCalls[1].fanOutArgsKey).toBeNull()
  })

  it('does not match `agent` inside an identifier or string', () => {
    const src = [
      "export const meta = { name: 'x', description: 'y', phases: [] }",
      "const myagent = 1 // not a call",
      "const note = 'call agent() later'",
      "await agent('real prompt', { label: 'r' })",
    ].join('\n')
    const parsed = parseWorkflowScript(src)
    expect(parsed.agentCalls).toHaveLength(1)
    expect(parsed.agentCalls[0].labelTemplate).toBe('r')
  })
})
