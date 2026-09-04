import { describe, it, expect } from 'vitest'
import { getPathName, isFolderPath, toWorkspaceRelativePath } from './workspace-path'

describe('isFolderPath', () => {
  it.each([
    ['/workspace/uploads/project/', true],
    ['/workspace/uploads/notes.txt', false],
    ['/', true],
  ])('%s → %s', (input, expected) => {
    expect(isFolderPath(input)).toBe(expected)
  })
})

describe('getPathName', () => {
  it.each([
    ['/workspace/output/report.pdf', 'report.pdf'],
    ['/workspace/uploads/my-project/', 'my-project'],
    ['/workspace/uploads/deep/nested/folder///', 'folder'],
    ['report.pdf', 'report.pdf'],
    ['/', '/'],
  ])('%s → %s', (input, expected) => {
    expect(getPathName(input)).toBe(expected)
  })
})

describe('toWorkspaceRelativePath', () => {
  it.each([
    ['/workspace/output/report.pdf', 'output/report.pdf'],
    ['/workspace/uploads/project/', 'uploads/project'],
    ['/workspace/notes.txt', 'notes.txt'],
    // already relative, or outside the workspace: left alone apart from the slash
    ['output/report.pdf', 'output/report.pdf'],
    ['/tmp/scratch.txt', '/tmp/scratch.txt'],
  ])('%s → %s', (input, expected) => {
    expect(toWorkspaceRelativePath(input)).toBe(expected)
  })
})
