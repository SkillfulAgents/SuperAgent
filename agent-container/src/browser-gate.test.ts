import { describe, expect, it } from 'vitest'
import { browserAlone, browserCommand } from './browser-gate'

/** A piece of work that runs until released, recording when it starts and ends. */
function work(log: string[], name: string) {
  let release = () => {}
  const done = new Promise<void>((resolve) => { release = resolve })
  return {
    run: async () => {
      log.push(`${name}:start`)
      await done
      log.push(`${name}:end`)
    },
    release,
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('the browser gate', () => {
  it('runs commands side by side, and an operation only once none is running', async () => {
    const log: string[] = []
    const first = work(log, 'command-1')
    const second = work(log, 'command-2')
    const operation = work(log, 'operation')
    const commands = [browserCommand(first.run), browserCommand(second.run)]
    const alone = browserAlone(operation.run)
    await tick()
    expect(log).toEqual(['command-1:start', 'command-2:start'])

    first.release()
    await tick()
    expect(log).not.toContain('operation:start')
    second.release()
    await tick()
    expect(log.at(-1)).toBe('operation:start')
    operation.release()
    await Promise.all([...commands, alone])
  })

  it('holds back a command that starts while an operation waits, so a busy browser cannot keep it waiting', async () => {
    const log: string[] = []
    const first = work(log, 'command-1')
    const later = work(log, 'command-2')
    const operation = work(log, 'operation')
    const running = browserCommand(first.run)
    await tick()
    const alone = browserAlone(operation.run)
    await tick()
    const held = browserCommand(later.run)
    await tick()
    expect(log).toEqual(['command-1:start'])

    first.release()
    await tick()
    expect(log).toEqual(['command-1:start', 'command-1:end', 'operation:start'])
    operation.release()
    await tick()
    expect(log.slice(3)).toEqual(['operation:end', 'command-2:start'])
    later.release()
    await Promise.all([running, alone, held])
  })

  it('holds a command back while an operation runs, and runs operations one at a time', async () => {
    const log: string[] = []
    const first = work(log, 'operation-1')
    const second = work(log, 'operation-2')
    const command = work(log, 'command')
    const operations = [browserAlone(first.run), browserAlone(second.run)]
    await tick()
    const held = browserCommand(command.run)
    await tick()
    expect(log).toEqual(['operation-1:start'])

    first.release()
    await tick()
    expect(log).toEqual(['operation-1:start', 'operation-1:end', 'operation-2:start'])
    second.release()
    await tick()
    expect(log.slice(3)).toEqual(['operation-2:end', 'command:start'])
    command.release()
    await Promise.all([...operations, held])
  })

  it('lets a failed operation go, and passes its error on', async () => {
    await expect(browserAlone(async () => { throw new Error('the browser went away') })).rejects.toThrow('the browser went away')
    expect(await browserCommand(async () => 'ran')).toBe('ran')
  })
})
