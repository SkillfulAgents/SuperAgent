import { describe, it, expect } from 'vitest'
import { askUserQuestionDef } from './ask-user-question'

const arrayQuestions = [
  { question: 'Which database should we use?', header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
  { question: 'Deploy now?', header: 'Deploy' },
]

describe('askUserQuestionDef.parseInput', () => {
  it('passes through an array of questions', () => {
    expect(askUserQuestionDef.parseInput({ questions: arrayQuestions })).toEqual({ questions: arrayQuestions })
  })

  // Regression: some models emit `questions` as a JSON-encoded string rather than
  // an array. Left uncoerced, this crashed the whole message thread when the
  // collapsed tool header called getSummary (string[0].question -> undefined.length).
  it('coerces a JSON-stringified questions array back into an array', () => {
    const result = askUserQuestionDef.parseInput({ questions: JSON.stringify(arrayQuestions) })
    expect(result.questions).toEqual(arrayQuestions)
  })

  it('returns undefined questions for an unparseable string', () => {
    expect(askUserQuestionDef.parseInput({ questions: 'not json' }).questions).toBeUndefined()
  })

  it('returns undefined questions when the string parses to a non-array', () => {
    expect(askUserQuestionDef.parseInput({ questions: '{"question":"x"}' }).questions).toBeUndefined()
  })

  it('returns empty object for non-object input', () => {
    expect(askUserQuestionDef.parseInput(null)).toEqual({})
    expect(askUserQuestionDef.parseInput('string')).toEqual({})
  })
})

describe('askUserQuestionDef.getSummary', () => {
  it('summarizes a single question', () => {
    expect(askUserQuestionDef.getSummary({ questions: [{ question: 'Deploy now?' }] })).toBe('Deploy now?')
  })

  it('appends a (+ N more) suffix for multiple questions', () => {
    expect(askUserQuestionDef.getSummary({ questions: arrayQuestions })).toBe('Which database should we use? (+ 1 more)')
  })

  it('does not throw and summarizes when questions arrives as a JSON string', () => {
    expect(askUserQuestionDef.getSummary({ questions: JSON.stringify(arrayQuestions) })).toBe(
      'Which database should we use? (+ 1 more)'
    )
  })

  it('returns null for missing or empty questions', () => {
    expect(askUserQuestionDef.getSummary({})).toBeNull()
    expect(askUserQuestionDef.getSummary({ questions: [] })).toBeNull()
    expect(askUserQuestionDef.getSummary({ questions: 'garbage' })).toBeNull()
  })
})
