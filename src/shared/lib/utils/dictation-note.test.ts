import { describe, expect, it } from 'vitest'
import { appendDictationNote, parseDictationNote } from './dictation-note'

describe('dictation note', () => {
  it('tells the agent the message was dictated, after everything else in it', () => {
    const sent = appendDictationNote('meet at to\n\n[Attached files:]\n- /workspace/uploads/a.md')
    expect(sent).toMatch(/^meet at to\n\n\[Attached files:\]\n- \/workspace\/uploads\/a\.md\n\n\[Voice dictated: [^\n]*speech-to-text[^\n]*\]$/)
  })

  it('lifts the note back off', () => {
    expect(parseDictationNote(appendDictationNote('meet at to'))).toEqual({ cleanText: 'meet at to', dictated: true })
    expect(parseDictationNote(appendDictationNote(''))).toEqual({ cleanText: '', dictated: true })
    expect(parseDictationNote(`${appendDictationNote('meet at to')}\n`)).toEqual({ cleanText: 'meet at to', dictated: true })
  })

  it('leaves a message without the note, or quoting one mid-text, as it is', () => {
    expect(parseDictationNote('meet at two')).toEqual({ cleanText: 'meet at two', dictated: false })
    const quoted = `${appendDictationNote('look at this')}\n\nwhat does it mean?`
    expect(parseDictationNote(quoted)).toEqual({ cleanText: quoted, dictated: false })
    expect(parseDictationNote('see [Voice dictated: x]')).toEqual({ cleanText: 'see [Voice dictated: x]', dictated: false })
  })
})
