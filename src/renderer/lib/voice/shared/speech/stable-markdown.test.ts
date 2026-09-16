import { describe, expect, it } from 'vitest'
import { stableMarkdownPrefix } from './stable-markdown'
import { markdownToSpokenWords } from './spoken-words'

describe('stableMarkdownPrefix', () => {
  it('cuts after the last finished sentence of a paragraph', () => {
    expect(stableMarkdownPrefix('Hello there. How are')).toBe('Hello there. ')
    expect(stableMarkdownPrefix('Really? Yes! And')).toBe('Really? Yes! ')
  })

  it('holds back a paragraph with no finished sentence yet', () => {
    expect(stableMarkdownPrefix('Hello there how')).toBe('')
    expect(stableMarkdownPrefix('First.\n\nHello there how')).toBe('First.\n\n')
  })

  it('does not treat a period without trailing whitespace as a sentence end (it may still grow)', () => {
    expect(stableMarkdownPrefix('Version 1.')).toBe('')
    expect(stableMarkdownPrefix('See e.g. the')).toBe('See e.g. ')
  })

  it('cuts at a line break inside a list', () => {
    expect(stableMarkdownPrefix('- one\n- two\n- thr')).toBe('- one\n- two\n')
  })

  it('cuts at the last blank line when the open block is a table', () => {
    const md = 'Intro.\n\n| a | b |\n| - | - |\n| 1 |'
    expect(stableMarkdownPrefix(md)).toBe('Intro.\n\n')
  })

  it('holds back an open HTML block', () => {
    expect(stableMarkdownPrefix('Intro.\n\n<div>\nsome. text')).toBe('Intro.\n\n')
  })

  it('cuts inside an open code fence (its words are silent either way)', () => {
    expect(stableMarkdownPrefix('Run this:\n\n```sh\necho hi\n')).toBe('Run this:\n\n```sh\necho hi\n')
  })

  it('never speaks a word the finished reply would not', () => {
    // Every prefix the cut allows parses to a prefix of the final word list.
    const reply =
      'Sure thing. Here is the **short version**: run it, then check the logs.\n\n' +
      '- First, `npm test`. It should pass.\n- Then push.\n\n' +
      '| col | val |\n| --- | --- |\n| a | 1 |\n\n' +
      'That is e.g. all. Anything else?'
    const finalWords = markdownToSpokenWords(reply).map((w) => w.text)
    for (let i = 0; i <= reply.length; i++) {
      const stable = stableMarkdownPrefix(reply.slice(0, i))
      const words = markdownToSpokenWords(stable).map((w) => w.text)
      expect(finalWords.slice(0, words.length)).toEqual(words)
    }
  })
})
