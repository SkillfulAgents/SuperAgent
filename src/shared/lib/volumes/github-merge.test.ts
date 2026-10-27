import { expect, it } from 'vitest'
import { markerLabel, mergePath, planPush } from './github-merge'

const commit = 'a'.repeat(40)
const bytes = (text: string | null) => text === null ? null : Buffer.from(text)
const merge = (base: string | null, local: string | null, remote: string | null) => {
  const merged = mergePath(bytes(base), bytes(local), bytes(remote), commit)
  return { content: merged.content?.toString() ?? null, conflict: merged.conflict, ...(merged.label ? { label: merged.label } : {}) }
}

it.each([
  ['the same change on both sides', 'a', 'b', 'b', 'b'],
  ['only the agent changed it', 'a', 'b', 'a', 'b'],
  ['only GitHub changed it', 'a', 'a', 'b', 'b'],
  ['different lines changed', 'one\nmid\ntwo\n', 'ONE\nmid\ntwo\n', 'one\nmid\nTWO\n', 'ONE\nmid\nTWO\n'],
  ['both added the same new file', null, 'new', 'new', 'new'],
])('merges cleanly when %s', (_case, base, local, remote, content) => {
  expect(merge(base, local, remote)).toEqual({ content, conflict: undefined })
})

it('holds an edit against a delete on either side, keeping the edited content', () => {
  expect(merge('a', null, 'b')).toEqual({ content: 'b', conflict: 'edited on GitHub, deleted here' })
  expect(merge('a', 'b', null)).toEqual({ content: 'b', conflict: 'deleted on GitHub, edited here' })
})

it('marks overlapping text with a label that says how to resolve it, and keeps the agent side of binary', () => {
  expect(merge('one\n', 'agent\n', 'github\n')).toEqual({
    content: `<<<<<<< Agent's version\nagent\n=======\ngithub\n${markerLabel(commit)}\n`, conflict: 'conflict markers to resolve', label: markerLabel(commit),
  })
  expect(markerLabel(commit)).toBe('>>>>>>> GitHub aaaaaaaaaaaa (remove these markers to sync this file)')
  expect(merge('one\ntwo\n', 'one\n', 'one\nTWO\n').content).toBe(`one\n<<<<<<< Agent's version\n=======\nTWO\n${markerLabel(commit)}\n`)
  expect(mergePath(Buffer.from([0, 1]), Buffer.from([0, 2]), Buffer.from([0, 3]), commit)).toEqual({ content: Buffer.from([0, 2]), conflict: 'changed on GitHub too' })
})

it('holds what it is told to, workflows and oversized moves with both sides of the move, and splits the rest under the limit', () => {
  const change = (path: string, size: number, group?: string) => ({ path, contents: Buffer.alloc(size, 'x'), mode: '100644', group })
  const plan = planPush([
    change('a.txt', 400_000), change('b.txt', 400_000),
    { path: 'held.txt', contents: null, mode: '100644', held: 'changed on GitHub too' },
    change('ci.yml', 10, 'move'), { path: '.github/workflows/ci.yml', contents: Buffer.from('x'), mode: '100644', group: 'move' },
    change('huge.bin', 800_000),
    { path: 'docs/markers.md', contents: Buffer.from(`An example:\n${markerLabel(commit)}\n`), mode: '100644' },
  ])
  expect(plan.batches.map(batch => batch.map(entry => entry.path))).toEqual([['a.txt'], ['b.txt', 'docs/markers.md']])
  expect(Object.fromEntries(plan.held)).toEqual({
    'held.txt': 'changed on GitHub too', 'ci.yml': 'under .github/workflows', '.github/workflows/ci.yml': 'under .github/workflows', 'huge.bin': 'over the size limit',
  })
})
