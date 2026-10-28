import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron's globalShortcut so we can assert register/unregister calls
// without a live main process. `vi.hoisted` keeps the spies reachable from the
// hoisted mock factory.
const { register, unregister, unregisterAll } = vi.hoisted(() => ({
  register: vi.fn(),
  unregister: vi.fn(),
  unregisterAll: vi.fn(),
}))

vi.mock('electron', () => ({
  globalShortcut: { register, unregister, unregisterAll },
}))

import {
  registerGlobalDispatchShortcut,
  unregisterGlobalDispatchShortcut,
} from './global-dispatch-shortcut'

describe('registerGlobalDispatchShortcut', () => {
  const onTrigger = vi.fn()

  beforeEach(() => {
    // Reset the module's remembered binding, then clear spy history so each test
    // starts from a clean slate.
    unregisterGlobalDispatchShortcut()
    vi.clearAllMocks()
    register.mockReturnValue(true) // register() succeeds by default
  })

  it('registers a valid accelerator with the trigger callback', () => {
    const result = registerGlobalDispatchShortcut('CommandOrControl+Shift+Space', onTrigger)

    expect(result).toEqual({ success: true })
    expect(register).toHaveBeenCalledWith('CommandOrControl+Shift+Space', onTrigger)
  })

  it('treats an empty string as "disabled" — no registration', () => {
    const result = registerGlobalDispatchShortcut('', onTrigger)

    expect(result).toEqual({ success: true })
    expect(register).not.toHaveBeenCalled()
  })

  it('falls back to the default when the accelerator is undefined', () => {
    const result = registerGlobalDispatchShortcut(undefined, onTrigger)

    expect(result.success).toBe(true)
    expect(register).toHaveBeenCalledWith('CommandOrControl+Shift+Space', onTrigger)
  })

  it('rejects a garbage accelerator without registering', () => {
    const result = registerGlobalDispatchShortcut('not a shortcut', onTrigger)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/valid/i)
    expect(register).not.toHaveBeenCalled()
  })

  it('reports a conflict when register() returns false', () => {
    register.mockReturnValue(false)

    const result = registerGlobalDispatchShortcut('Control+Alt+K', onTrigger)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already in use/i)
  })

  it('catches a thrown registration error and surfaces its message', () => {
    register.mockImplementation(() => {
      throw new Error('boom')
    })

    const result = registerGlobalDispatchShortcut('Control+Alt+K', onTrigger)

    expect(result).toEqual({ success: false, error: 'boom' })
  })

  it('unregisters the previous binding before registering a new one', () => {
    registerGlobalDispatchShortcut('Control+Alt+K', onTrigger)
    expect(unregister).not.toHaveBeenCalled() // nothing bound before

    registerGlobalDispatchShortcut('Control+Alt+J', onTrigger)

    expect(unregister).toHaveBeenCalledWith('Control+Alt+K') // old one released
    expect(register).toHaveBeenLastCalledWith('Control+Alt+J', onTrigger)
  })

  it('does not re-unregister after being disabled (state cleared)', () => {
    registerGlobalDispatchShortcut('Control+Alt+K', onTrigger)
    registerGlobalDispatchShortcut('', onTrigger) // disable → releases the old one
    expect(unregister).toHaveBeenCalledTimes(1)

    registerGlobalDispatchShortcut('Control+Alt+J', onTrigger) // nothing to release now
    expect(unregister).toHaveBeenCalledTimes(1)
  })
})

describe('unregisterGlobalDispatchShortcut', () => {
  beforeEach(() => {
    unregisterGlobalDispatchShortcut()
    vi.clearAllMocks()
    register.mockReturnValue(true)
  })

  it('releases the current binding', () => {
    registerGlobalDispatchShortcut('Control+Alt+K', vi.fn())
    unregisterGlobalDispatchShortcut()

    expect(unregister).toHaveBeenCalledWith('Control+Alt+K')
  })

  it('is a no-op when nothing is bound', () => {
    unregisterGlobalDispatchShortcut()
    expect(unregister).not.toHaveBeenCalled()
  })
})
