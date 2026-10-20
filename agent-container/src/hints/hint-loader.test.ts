import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect } from 'vitest'
import { loadHints, parseHint } from './hint-loader'

const file = (frontmatter: string, body = 'Body text') => `---\n${frontmatter}\n---\n${body}\n`
const valid = 'name: no-sleep\ndescription: Avoid sleeps\ntriggers:\n  - event: PreToolUse\n    match: Bash(sleep *)'

describe('parseHint', () => {
  it('reads frontmatter and trims the body', () => {
    expect(parseHint('no-sleep.md', file(valid, '\nUse schedule_resume instead.\n'))).toEqual({
      name: 'no-sleep',
      description: 'Avoid sleeps',
      content: 'Use schedule_resume instead.',
      triggers: [{ event: 'PreToolUse', match: 'Bash(sleep *)' }],
    })
  })

  it('requires the file name to equal the hint name', () => {
    expect(() => parseHint('other.md', file(valid))).toThrow('must be named "no-sleep.md"')
  })

  it('rejects an unknown event and an empty body', () => {
    expect(() => parseHint('no-sleep.md', file(valid.replace('PreToolUse', 'Stop')))).toThrow()
    expect(() => parseHint('no-sleep.md', file(valid, '   '))).toThrow('empty body')
  })
})

describe('loadHints', () => {
  it('rejects the same hint name in two topic folders', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hints-'))
    for (const topic of ['one', 'two']) {
      fs.mkdirSync(path.join(dir, topic))
      fs.writeFileSync(path.join(dir, topic, 'dup.md'), file(valid.replace('no-sleep', 'dup')))
    }
    expect(() => loadHints(dir)).toThrow('Duplicate hint name "dup"')
  })
})
