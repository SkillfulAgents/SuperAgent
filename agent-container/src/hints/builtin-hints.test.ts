import { describe, it, expect } from 'vitest'
import { builtinHints } from './index'
import { compileTrigger } from './hint-matchers'
import type { HintEventInput } from './hint-schema'

const compiled = builtinHints.map((hint) => ({ name: hint.name, triggers: hint.triggers.map(compileTrigger) }))
const matching = (input: HintEventInput) => compiled.filter(({ triggers }) => triggers.some((m) => m(input))).map(({ name }) => name).sort()

// Every row lists the exact hints a call triggers. A new hint that also fires on another hint's example
// fails here, so its author decides whether both should fire.
const CASES: Array<[string, HintEventInput, string[]]> = []

describe('built-in hints: which hints each call triggers', () => {
  it.each(CASES)('%s', (_label, input, expected) => {
    expect(matching(input)).toEqual(expected)
  })

  it('every built-in hint has at least one example here', () => {
    const covered = new Set(CASES.flatMap(([, , names]) => names))
    expect(builtinHints.map((h) => h.name).filter((name) => !covered.has(name))).toEqual([])
  })
})
