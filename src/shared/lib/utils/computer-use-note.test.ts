import { describe, expect, it } from 'vitest'
import { appendComputerUseNote, parseComputerUseNote } from './computer-use-note'
import { appendDictationNote } from './dictation-note'
import { appendAttachedFiles } from './attached-files'
import { parseUserMessageParts } from './user-message-parts'

describe('computer-use note', () => {
  it('names the screenshot and round-trips', () => {
    const sent = appendComputerUseNote('Book this flight', 'Screenshot 2026-11-02 at 14.03.22.png')
    expect(sent).toContain('allowed you to use any app on it without asking')
    expect(sent).toContain('"Screenshot 2026-11-02 at 14.03.22.png" is their screen as they sent this')
    expect(parseComputerUseNote(sent)).toEqual({ cleanText: 'Book this flight', computerUse: true })
  })

  it('leaves the screenshot out when there is none', () => {
    const sent = appendComputerUseNote('Book this flight')
    expect(sent).not.toContain('screen as they sent this')
    expect(parseComputerUseNote(sent).cleanText).toBe('Book this flight')
  })

  it('keeps a name from ending the note early', () => {
    const sent = appendComputerUseNote('hi', 'a]b\nc.png')
    expect(parseComputerUseNote(sent)).toEqual({ cleanText: 'hi', computerUse: true })
  })

  it('stands alone on an empty message', () => {
    expect(parseComputerUseNote(appendComputerUseNote('')).cleanText).toBe('')
  })

  it('leaves a message without the note alone', () => {
    expect(parseComputerUseNote('[Computer use: in the middle] of a line')).toEqual({
      cleanText: '[Computer use: in the middle] of a line',
      computerUse: false,
    })
  })

  it('is lifted off with the dictation note and the attached files', () => {
    const composed = appendDictationNote(appendAttachedFiles('Book this flight', ['uploads/Screenshot.png']))
    const parts = parseUserMessageParts(appendComputerUseNote(composed, 'Screenshot.png'))
    expect(parts.text).toBe('Book this flight')
    expect(parts.attachedFiles).toEqual(['uploads/Screenshot.png'])
  })
})
