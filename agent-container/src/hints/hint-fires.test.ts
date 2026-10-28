import { describe, it, expect } from 'vitest'
import { eventsFromTranscript, matchingEvents } from './hint-fires'
import { parseHint } from './hint-loader'

const line = (entry: unknown) => JSON.stringify(entry)
const bash = (id: string, command: string) =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })

const transcript = [
  line({ type: 'user', message: { role: 'user', content: 'Publish the release notes' } }),
  line({ type: 'user', isMeta: true, message: { role: 'user', content: 'system reminder' } }),
  bash('t1', 'cd /workspace && ./publish.sh notes.md'),
  bash('t2', 'sleep 55; cat /tmp/out'),
  bash('t2', 'sleep 55; cat /tmp/out'),
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: '' }] } }),
  'not json',
].join('\n')

const hint = parseHint(
  'wait.md',
  '---\nname: wait\ndescription: d\ntriggers:\n  - event: PreToolUse\n    tool: Bash\n    input:\n      command: sleep *\n---\nBody',
)

describe('hint-fires', () => {
  it('reads real prompts and each tool call once, as Pre and Post events', () => {
    const events = eventsFromTranscript(transcript)
    expect(events.filter((e) => e.event === 'UserPromptSubmit')).toEqual([{ event: 'UserPromptSubmit', prompt: 'Publish the release notes' }])
    expect(events.filter((e) => e.event === 'PreToolUse')).toHaveLength(2)
    expect(events.filter((e) => e.event === 'PostToolUse')).toHaveLength(2)
  })

  it('matches with the same rules as the hook', () => {
    const matched = matchingEvents(hint, eventsFromTranscript(transcript))
    expect(matched).toEqual([{ event: 'PreToolUse', toolName: 'Bash', toolInput: { command: 'sleep 55; cat /tmp/out' } }])
  })
})
