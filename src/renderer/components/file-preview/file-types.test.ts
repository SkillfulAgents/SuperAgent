import { describe, expect, it } from 'vitest'
import { isCopyableTextFile } from './file-types'

describe('isCopyableTextFile', () => {
  it.each(['notes.md', 'data.csv', 'config.json', 'index.html', 'icon.svg', 'Dockerfile'])(
    'allows copying %s',
    fileName => expect(isCopyableTextFile(fileName)).toBe(true),
  )

  it.each(['photo.png', 'clip.mp4', 'document.pdf', 'archive.zip'])(
    'does not allow copying %s',
    fileName => expect(isCopyableTextFile(fileName)).toBe(false),
  )
})
