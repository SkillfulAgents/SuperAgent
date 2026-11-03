import { describe, it, expect } from 'vitest'
import { editedContent, GithubConflictFileHook } from './github-conflict-hook'
import { fileHooks } from './index'

const hook = new GithubConflictFileHook()
const marked = "<<<<<<< Agent's version\nmine\n=======\ntheirs\n>>>>>>> GitHub 1a2b3c4d5e6f (remove these markers to sync this file)\n"

describe('GithubConflictFileHook', () => {
  it('tells the agent about a conflict in what it read or edited, and says nothing otherwise', () => {
    expect(hook.onRead('/mounts/repo/a.md', { type: 'text', file: { content: `intro\n${marked}` } }).additionalContext).toContain('Resolve it now')
    expect(hook.onEdit('/mounts/repo/a.md', `intro edited\n  ${marked}`).warning).toContain('tell the user')
    expect(hook.onRead('/mounts/repo/a.md', { type: 'text', file: { content: 'intro\n>>>>>>> not a GitHub label\n' } })).toEqual({})
    expect(hook.onRead('/mounts/repo/a.md', undefined)).toEqual({})
    expect(hook.onEdit('/mounts/repo/a.md', 'clean\n')).toEqual({})
    expect(hook.onWrite('/mounts/repo/a.md', marked).warning).toContain('Resolve it now')
  })

  it('runs before the index hook, which warns on every edit of an indexed drive', () => {
    expect(fileHooks.findIndex(h => h instanceof GithubConflictFileHook)).toBeLessThan(fileHooks.findIndex(h => h.constructor.name === 'MountIndexFileHook'))
  })

  it('sees the edited file from the Edit reply, without reading it', () => {
    const reply = { originalFile: `x\n${marked}y $& x\n`, oldString: 'x', newString: '$&!', replaceAll: false }
    expect(editedContent(reply)).toBe(`$&!\n${marked}y $& x\n`)
    expect(editedContent({ ...reply, replaceAll: true })).toBe(`$&!\n${marked}y $& $&!\n`)
    expect(editedContent({ ...reply, originalFile: null })).toBeNull()
    expect(hook.onEditReply('/mounts/repo/a.md', reply)?.warning).toContain('Resolve it now')
    expect(hook.onEditReply('/mounts/repo/a.md', { ...reply, originalFile: null })).toBeNull()
  })

  it('only looks under /mounts', () => {
    expect([hook.matches('/mounts/repo/a.md'), hook.matches('/workspace/a.md')]).toEqual([true, false])
  })
})
