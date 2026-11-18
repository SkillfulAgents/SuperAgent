import { describe, expect, it } from 'vitest'
import { folderNameError, volumeFolderNameSchema } from './volume-folders-schema'

describe('new folder and drive names', () => {
  it('follows the drive name rule on a trimmed name, in the field and on the server', () => {
    expect(folderNameError('  ')).toBe('Enter a name')
    expect(folderNameError('a/b')).toBe('Use a single folder name')
    expect(folderNameError(' .. ')).toBe('Use a single folder name')
    expect(folderNameError('x'.repeat(256))).toBe('Use 255 characters or fewer')
    expect(folderNameError('Q3 notes')).toBeNull()
    expect(volumeFolderNameSchema.parse('  Scratch ')).toBe('Scratch')
    expect(volumeFolderNameSchema.safeParse('a/b').success).toBe(false)
  })
})
