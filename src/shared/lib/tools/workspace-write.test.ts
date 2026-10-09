import { describe, it, expect } from 'vitest'
import { workspaceWriteOf } from './workspace-write'

describe('workspaceWriteOf', () => {
  it.each([
    ['Edit', { file_path: '/workspace/notes.md', old_string: 'a', new_string: 'b' }, '/workspace/notes.md'],
    ['Write', { file_path: '/workspace/out/report.md', content: '#' }, '/workspace/out/report.md'],
    ['MultiEdit', { file_path: '/workspace/plan.md', edits: [] }, '/workspace/plan.md'],
    ['NotebookEdit', { notebook_path: '/workspace/a.ipynb', new_source: '' }, '/workspace/a.ipynb'],
    ['Edit', { file_path: '/workspace/./out//notes.md' }, '/workspace/out/notes.md'],
    ['Write', { file_path: 'out/notes.md' }, '/workspace/out/notes.md'],
  ])('%s names the file it wrote', (tool, input, expected) => {
    expect(workspaceWriteOf(tool, JSON.stringify(input))).toBe(expected)
  })

  it.each(['Bash', 'Task', 'Agent', 'Workflow', 'Skill'])('%s can write anything', (tool) => {
    expect(workspaceWriteOf(tool, '')).toBe('any')
  })

  it.each([
    ['Read', JSON.stringify({ file_path: '/workspace/notes.md' })],
    ['mcp__user-input__deliver_file', JSON.stringify({ filePath: '/workspace/notes.md' })],
    ['Edit', JSON.stringify({ file_path: '/mounts/Gamut/notes.md' })],
    ['Edit', JSON.stringify({ file_path: '/workspaceX/notes.md' })],
    ['Edit', JSON.stringify({ file_path: '/workspace/../etc/passwd' })],
    ['Edit', JSON.stringify({ file_path: '/workspace' })],
    ['Edit', JSON.stringify({})],
    ['Edit', 'null'],
    ['Edit', '{"file_path": "/workspace/no'],
  ])('%s %s writes nothing a preview shows', (tool, rawInput) => {
    expect(workspaceWriteOf(tool, rawInput)).toBeNull()
  })
})
