import path from 'path'
import { ipcMain, nativeTheme, WebContentsView, type BrowserWindow, type IpcMainEvent, type Result } from 'electron'

// Its own view, not page DOM: page modals trap focus, and find would match the query input.

const BAR_WIDTH = 480
const BAR_HEIGHT = 40
const TOP_OFFSET = 52
const RIGHT_OFFSET = 16

interface FindBar {
  window: BrowserWindow
  view: WebContentsView
  cleanup: () => void
}

const bars = new Map<BrowserWindow, FindBar>()

export function openFindBar(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  const existing = bars.get(window)
  if (existing) {
    existing.view.webContents.focus()
    existing.view.webContents.send('find-bar:focus')
    return
  }

  const target = window.webContents
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/find-bar.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  view.setBackgroundColor('#00000000')

  const applyBounds = () => {
    const { width } = window.getContentBounds()
    const barWidth = Math.min(BAR_WIDTH, width - RIGHT_OFFSET * 2)
    view.setBounds({ x: width - barWidth - RIGHT_OFFSET, y: TOP_OFFSET, width: barWidth, height: BAR_HEIGHT })
  }
  applyBounds()
  window.contentView.addChildView(view)

  const onFound = (_event: Electron.Event, result: Result) => {
    if (!result.finalUpdate || view.webContents.isDestroyed()) return
    view.webContents.send('find-bar:result', { active: result.activeMatchOrdinal, total: result.matches })
  }
  // The page under the bar is gone, so its matches are too.
  const onNavigate = () => closeFindBar(window)
  // Fires for every frame; a dashboard iframe changing its hash leaves the app page in place.
  const onNavigateInPage = (_event: Electron.Event, _url: string, isMainFrame: boolean) => {
    if (isMainFrame) closeFindBar(window)
  }
  const onClosed = () => closeFindBar(window)

  window.on('resize', applyBounds)
  window.on('closed', onClosed)
  target.on('found-in-page', onFound)
  target.on('did-navigate', onNavigate)
  target.on('did-navigate-in-page', onNavigateInPage)

  bars.set(window, {
    window,
    view,
    cleanup: () => {
      window.off('resize', applyBounds)
      window.off('closed', onClosed)
      if (!target.isDestroyed()) {
        target.off('found-in-page', onFound)
        target.off('did-navigate', onNavigate)
        target.off('did-navigate-in-page', onNavigateInPage)
      }
    },
  })

  void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(findBarDocument(nativeTheme.shouldUseDarkColors))}`)
  view.webContents.once('did-finish-load', () => view.webContents.focus())
}

export function closeFindBar(window: BrowserWindow): void {
  const bar = bars.get(window)
  if (!bar) return
  bars.delete(window)
  bar.cleanup()
  if (!window.isDestroyed()) {
    window.webContents.stopFindInPage('clearSelection')
    window.contentView.removeChildView(bar.view)
    window.webContents.focus()
  }
  bar.view.webContents.close()
}

function barFor(event: IpcMainEvent): FindBar | undefined {
  for (const bar of bars.values()) {
    if (bar.view.webContents === event.sender) return bar
  }
  return undefined
}

export function registerFindBarIpc(): void {
  ipcMain.on('find-bar:find', (event, args: { text: string; forward: boolean; newSearch: boolean }) => {
    const bar = barFor(event)
    if (!bar || bar.window.isDestroyed()) return
    const target = bar.window.webContents
    if (!args.text) {
      target.stopFindInPage('clearSelection')
      event.sender.send('find-bar:result', { active: 0, total: 0 })
      return
    }
    target.findInPage(args.text, { forward: args.forward, findNext: args.newSearch })
  })
  ipcMain.on('find-bar:close', (event) => {
    const bar = barFor(event)
    if (bar) closeFindBar(bar.window)
  })
}

function findBarDocument(dark: boolean): string {
  const c = dark
    ? { bg: 'hsl(0 0% 10%)', fg: 'hsl(0 0% 98%)', muted: 'hsl(0 0% 63.9%)', border: 'hsl(0 0% 19%)', hover: 'hsl(0 0% 19% / 0.5)', ring: 'hsl(0 0% 45%)' }
    : { bg: 'hsl(0 0% 100%)', fg: 'hsl(0 0% 3.9%)', muted: 'hsl(0 0% 45.1%)', border: 'hsl(0 0% 89.8%)', hover: 'hsl(0 0% 96.1%)', ring: 'hsl(0 0% 63.9%)' }
  return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  body { font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: ${c.fg}; }
  .bar { box-sizing: border-box; height: 100%; display: flex; align-items: center; gap: 6px; padding: 0 6px;
    background: ${c.bg}; border: 1px solid ${c.border}; border-radius: 8px; }
  .field { flex: 1; min-width: 0; display: flex; align-items: center; height: 26px; border: 1px solid ${c.border}; border-radius: 6px; }
  .field:focus-within { box-shadow: 0 0 0 1px ${c.ring}; }
  input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; padding: 0 8px; }
  input::placeholder { color: ${c.muted}; }
  .count { color: ${c.muted}; font-size: 11px; padding: 0 4px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .nav { display: flex; height: 100%; border-left: 1px solid ${c.border}; }
  button { border: 0; background: transparent; color: ${c.muted}; font: inherit; cursor: default; display: flex; align-items: center; justify-content: center; }
  .nav button { width: 24px; height: 100%; }
  button:hover:not(:disabled) { color: ${c.fg}; background: ${c.hover}; }
  button:disabled { opacity: 0.4; }
  .done { height: 26px; padding: 0 8px; border-radius: 6px; font-size: 11px; color: ${c.fg}; }
</style>
<div class="bar">
  <div class="field">
    <input id="q" placeholder="Find in page" autofocus spellcheck="false">
    <span class="count" id="count"></span>
    <div class="nav">
      <button id="prev" aria-label="Previous match" disabled><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m18 15-6-6-6 6"/></svg></button>
      <button id="next" aria-label="Next match" disabled><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg></button>
    </div>
  </div>
  <button class="done" id="done">Done</button>
</div>
<script>
  const q = document.getElementById('q')
  const count = document.getElementById('count')
  const prev = document.getElementById('prev')
  const next = document.getElementById('next')
  const go = (forward, newSearch) => window.findBar.find(q.value, forward, newSearch)
  q.addEventListener('input', () => go(true, true))
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (q.value) go(!e.shiftKey, false) }
    else if (e.key === 'Escape') { e.preventDefault(); window.findBar.close() }
  })
  prev.addEventListener('click', () => go(false, false))
  next.addEventListener('click', () => go(true, false))
  document.getElementById('done').addEventListener('click', () => window.findBar.close())
  window.findBar.onFocus(() => { q.focus(); q.select() })
  window.findBar.onResult(({ active, total }) => {
    count.textContent = !q.value ? '' : total === 0 ? 'No matches' : active + ' of ' + total
    prev.disabled = next.disabled = total === 0
  })
</script>`
}
