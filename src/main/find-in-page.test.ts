import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (event: { sender: unknown }, args?: unknown) => void

const { createdViews, ipcListeners, FakeContents, Emitter } = vi.hoisted(() => {
  class Emitter {
    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
    on(event: string, cb: (...args: unknown[]) => void) { (this.listeners[event] ??= []).push(cb); return this }
    once(event: string, cb: (...args: unknown[]) => void) { return this.on(event, cb) }
    off(event: string, cb: (...args: unknown[]) => void) {
      this.listeners[event] = (this.listeners[event] ?? []).filter((l) => l !== cb)
      return this
    }
    emit(event: string, ...args: unknown[]) { for (const l of this.listeners[event] ?? []) l(...args) }
  }
  class FakeContents extends Emitter {
    findInPage = vi.fn()
    stopFindInPage = vi.fn()
    send = vi.fn()
    focus = vi.fn()
    close = vi.fn()
    loadURL = vi.fn(async () => undefined)
    isDestroyed = vi.fn(() => false)
  }
  return {
    Emitter,
    FakeContents,
    createdViews: [] as Array<{ setBounds: ReturnType<typeof vi.fn>; webContents: InstanceType<typeof FakeContents> }>,
    ipcListeners: {} as Record<string, Listener>,
  }
})

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn((channel: string, cb: Listener) => { ipcListeners[channel] = cb }) },
  nativeTheme: { shouldUseDarkColors: false },
  WebContentsView: vi.fn(function () {
    const view = { setBackgroundColor: vi.fn(), setBounds: vi.fn(), webContents: new FakeContents() }
    createdViews.push(view)
    return view
  }),
}))

import { openFindBar, registerFindBarIpc } from './find-in-page'

class FakeWindow extends Emitter {
  webContents = new FakeContents()
  contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
  isDestroyed = vi.fn(() => false)
  getContentBounds = vi.fn(() => ({ x: 0, y: 0, width: 1200, height: 800 }))
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the fakes stand in for Electron types */
function open() {
  const window = new FakeWindow()
  openFindBar(window as any)
  const bar = createdViews[createdViews.length - 1]
  return { window, bar }
}

const fromBar = (bar: { webContents: InstanceType<typeof FakeContents> }, channel: string, args?: unknown) =>
  ipcListeners[channel]({ sender: bar.webContents }, args)

beforeAll(() => registerFindBarIpc())
beforeEach(() => { createdViews.length = 0 })

describe('find bar', () => {
  it('searches the window page as the user types, then steps through matches', () => {
    const { window, bar } = open()

    fromBar(bar, 'find-bar:find', { text: 'memory', forward: true, newSearch: true })
    fromBar(bar, 'find-bar:find', { text: 'memory', forward: false, newSearch: false })

    expect(window.webContents.findInPage.mock.calls).toEqual([
      ['memory', { forward: true, findNext: true }],
      ['memory', { forward: false, findNext: false }],
    ])
  })

  it('clears highlights when the query is emptied', () => {
    const { window, bar } = open()

    fromBar(bar, 'find-bar:find', { text: '', forward: true, newSearch: true })

    expect(window.webContents.findInPage).not.toHaveBeenCalled()
    expect(window.webContents.stopFindInPage).toHaveBeenCalledWith('clearSelection')
    expect(bar.webContents.send).toHaveBeenCalledWith('find-bar:result', { active: 0, total: 0 })
  })

  it('reports only the final match count to the bar', () => {
    const { window, bar } = open()

    window.webContents.emit('found-in-page', {}, { finalUpdate: false, activeMatchOrdinal: 1, matches: 2 })
    window.webContents.emit('found-in-page', {}, { finalUpdate: true, activeMatchOrdinal: 1, matches: 3 })

    expect(bar.webContents.send.mock.calls).toEqual([['find-bar:result', { active: 1, total: 3 }]])
  })

  it('closes and clears highlights when the page navigates', () => {
    const { window, bar } = open()

    window.webContents.emit('did-navigate-in-page')

    expect(window.webContents.stopFindInPage).toHaveBeenCalledWith('clearSelection')
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(bar)
    expect(bar.webContents.close).toHaveBeenCalled()

    window.webContents.emit('found-in-page', {}, { finalUpdate: true, activeMatchOrdinal: 1, matches: 1 })
    expect(bar.webContents.send).not.toHaveBeenCalled()
  })

  it('refocuses the open bar instead of stacking a second one', () => {
    const { window, bar } = open()

    openFindBar(window as any)

    expect(createdViews).toHaveLength(1)
    expect(bar.webContents.send).toHaveBeenCalledWith('find-bar:focus')
  })

  it('closes from the bar and hands focus back to the page', () => {
    const { window, bar } = open()

    fromBar(bar, 'find-bar:close')

    expect(window.contentView.removeChildView).toHaveBeenCalledWith(bar)
    expect(window.webContents.focus).toHaveBeenCalled()
  })
})
