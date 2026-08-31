import { describe, expect, it } from 'vitest'
import { isCopyableTextFile, looksBinary } from './file-types'

describe('isCopyableTextFile', () => {
  it.each(['notes.md', 'data.csv', 'config.json', 'index.html', 'icon.svg', 'Dockerfile'])(
    'allows copying %s',
    fileName => expect(isCopyableTextFile(fileName)).toBe(true),
  )

  it.each(['LICENSE', 'Procfile', '.env.production', 'main.zig', 'query.hcl'])(
    'allows copying %s, which no extension list would have covered',
    fileName => expect(isCopyableTextFile(fileName)).toBe(true),
  )

  it.each(['photo.png', 'clip.mp4', 'song.mp3', 'document.pdf', 'archive.zip', 'app.wasm', 'data.sqlite'])(
    'does not allow copying %s',
    fileName => expect(isCopyableTextFile(fileName)).toBe(false),
  )
})

describe('looksBinary', () => {
  it.each([
    ['plain text', 'hello world'],
    ['an empty file', ''],
    ['text with the odd decoding artefact', `caf�${'e'.repeat(200)}`],
  ])('treats %s as text', (_label, text) => expect(looksBinary(text)).toBe(false))

  it('flags a NUL byte, the way git does', () => {
    expect(looksBinary('ELF\u0000\u0001\u0002')).toBe(true)
  })

  it('flags content that decoded mostly to replacement characters', () => {
    expect(looksBinary('�'.repeat(50))).toBe(true)
  })

  it('only sniffs the head, so a NUL past the sample window is not decisive', () => {
    expect(looksBinary(`${'a'.repeat(8000)}\u0000`)).toBe(false)
  })
})
