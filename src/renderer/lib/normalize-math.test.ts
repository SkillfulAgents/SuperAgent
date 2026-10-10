import { describe, expect, it } from 'vitest'
import { normalizeMath } from './normalize-math'

describe('normalizeMath', () => {
  it('escapes prices so they never open inline math', () => {
    expect(normalizeMath('It costs $5 and $10.50 per seat.')).toBe('It costs \\$5 and \\$10.50 per seat.')
    expect(normalizeMath('Pay $5-$10. Use $HOME later.')).toBe('Pay \\$5-\\$10. Use $HOME later.')
  })

  it('keeps math that starts with a digit', () => {
    const text = '- $2T(n/2)$: two recursive calls on halves of size $n/2$.'
    expect(normalizeMath(text)).toBe(text)
  })

  it('keeps $...$ and $$...$$ math as written', () => {
    const text = 'Area is $\\pi r^2$, and $2^n$ grows.\n\n$$\ne^{i\\pi} + 1 = 0\n$$'
    expect(normalizeMath(text)).toBe(text)
  })

  it('rewrites \\(...\\) and \\[...\\] to dollar delimiters', () => {
    expect(normalizeMath('Inline \\(x^2\\) here.\n\n\\[\n\\frac{a}{b}\n\\]'))
      .toBe('Inline $x^2$ here.\n\n$$\n\\frac{a}{b}\n$$')
  })

  it('leaves code spans and fences untouched', () => {
    const text = 'Run `echo $5` first.\n\n```sh\nprice=$5\necho \\(x\\)\n```\n\nThen pay $5.'
    expect(normalizeMath(text)).toBe('Run `echo $5` first.\n\n```sh\nprice=$5\necho \\(x\\)\n```\n\nThen pay \\$5.')
  })
})
