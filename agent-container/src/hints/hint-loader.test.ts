import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect } from 'vitest'
import { loadHints, parseHint } from './hint-loader'

const file = (frontmatter: string, body = 'Body text') => `---\n${frontmatter}\n---\n${body}\n`
const valid = 'name: no-sleep\ndescription: Avoid sleeps\ntriggers:\n  - event: PreToolUse\n    tool: Bash\n    input:\n      command: sleep *'

describe('parseHint', () => {
  it('reads frontmatter and trims the body', () => {
    expect(parseHint('no-sleep.md', file(valid, '\nUse schedule_resume instead.\n'))).toEqual({
      name: 'no-sleep',
      description: 'Avoid sleeps',
      content: 'Use schedule_resume instead.',
      triggers: [{ event: 'PreToolUse', tool: 'Bash', input: { command: 'sleep *' } }],
      repeat: 'turn',
    })
  })

  it('requires the file name to equal the hint name', () => {
    expect(() => parseHint('other.md', file(valid))).toThrow('must be named "no-sleep.md"')
  })

  it('rejects an unknown event, a misspelled key, a prompt on a tool event and an empty body', () => {
    expect(() => parseHint('no-sleep.md', file(valid.replace('PreToolUse', 'Stop')))).toThrow()
    expect(() => parseHint('no-sleep.md', file(valid.replace('    input:', '    inputs:')))).toThrow()
    expect(() => parseHint('no-sleep.md', file(valid.replace('    tool: Bash', '    prompt: deploy')))).toThrow()
    expect(() => parseHint('no-sleep.md', file(valid, '   '))).toThrow('empty body')
  })

  it('reads requires and rejects an unknown value', () => {
    expect(parseHint('no-sleep.md', file(`${valid}\nrequires: platform`)).requires).toBe('platform')
    expect(() => parseHint('no-sleep.md', file(`${valid}\nrequires: desktop`))).toThrow()
  })

  it('reads deny and allows it only on PreToolUse triggers', () => {
    expect(parseHint('no-sleep.md', file(`${valid}\ndeny: true`)).deny).toBe(true)
    expect(() => parseHint('no-sleep.md', file(`${valid}\ndeny: once`))).toThrow()
    expect(() => parseHint('no-sleep.md', file(`${valid.replace('PreToolUse', 'PostToolUse')}\ndeny: true`))).toThrow('only have PreToolUse triggers')
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
