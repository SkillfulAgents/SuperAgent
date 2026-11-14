/**
 * Measures what a screen costs while nobody touches it: the renderer's and the
 * GPU process's CPU, with the window in use and with it in the background.
 * The check behind docs/animations.md: run it on every screen an animation
 * appears on before shipping one.
 *
 *   npx electron scripts/measure-animation-cpu.cjs <url> [<url> ...] [--seconds 8] [--settle 4] [--size 1440x900]
 *
 * A URL is any page: a screen of the mock web app (`E2E_MOCK=true PORT=47897
 * npm run dev:web`, then http://localhost:47897/agents/<slug>), or a file://
 * harness that mounts one component. Each is loaded in a real window on this
 * machine's GPU and display, since headless Chromium rasterizes in software
 * and measures something else.
 *
 * Reads, per URL and per state:
 * - renderer / gpu: share of one core over the sample (Activity Monitor's scale).
 * - frames: animation frames the page ran a second (requestAnimationFrame
 *   callbacks), and looping CSS / Web Animations still running.
 *
 * "in use" is emulated focus, so the window never takes the keyboard. An idle
 * screen should read near zero in the background, and in use only what its
 * visible motion is worth.
 */
const { app, BrowserWindow } = require('electron')
const os = require('os')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  if (at < 0) return fallback
  const [value] = args.splice(at, 2).slice(1)
  return value
}
const seconds = Number(flag('seconds', 8))
const settle = Number(flag('settle', 4))
const [width, height] = flag('size', '1440x900').split('x').map(Number)
const urls = args.filter((arg) => !arg.startsWith('--'))
if (urls.length === 0) {
  console.error('usage: npx electron scripts/measure-animation-cpu.cjs <url> [<url> ...] [--seconds 8] [--settle 4] [--size 1440x900]')
  process.exit(2)
}

// A window another one happens to cover completely is "hidden" to its page, which is the
// case that already costs nothing. The background state measured here is the other one:
// shown, and not in use. So the window counts as shown wherever it ends up on the desktop.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,MacWebContentsOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

const cores = os.cpus().length
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Counts the page's own frame callbacks without adding a loop that would cost frames itself.
const PROBE = `(() => {
  if (window.__animationProbe) return
  const probe = window.__animationProbe = { frames: 0 }
  const request = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (callback) => request((now) => { probe.frames++; callback(now) })
})()`

const READ = `(() => {
  const looping = (document.getAnimations?.() ?? []).filter((animation) =>
    animation.playState === 'running' && animation.playbackRate !== 0 &&
    animation.effect?.getComputedTiming().iterations === Infinity)
  const frames = window.__animationProbe.frames
  window.__animationProbe.frames = 0
  return { frames, looping: looping.length, focused: document.hasFocus(), hidden: document.hidden }
})()`

async function measure(win, label) {
  await sleep(settle * 1000)
  app.getAppMetrics()
  await win.webContents.executeJavaScript(READ)
  await sleep(seconds * 1000)
  const metrics = app.getAppMetrics()
  const page = await win.webContents.executeJavaScript(READ)
  const cpu = (type) =>
    metrics.filter((metric) => metric.type === type).reduce((sum, metric) => sum + metric.cpu.percentCPUUsage * cores, 0)
  const renderer = cpu('Tab')
  const gpu = cpu('GPU')
  console.log(
    `  ${label.padEnd(14)} renderer ${renderer.toFixed(1).padStart(5)}%   gpu ${gpu.toFixed(1).padStart(5)}%   ` +
      `frames/s ${(page.frames / seconds).toFixed(0).padStart(3)}   looping animations ${page.looping}` +
      (page.hidden ? '   (document hidden!)' : ''),
  )
  return { renderer, gpu, framesPerSecond: page.frames / seconds, looping: page.looping }
}

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  for (const url of urls) {
    console.log(url)
    const win = new BrowserWindow({ width, height, show: false })
    win.webContents.on('dom-ready', () => void win.webContents.executeJavaScript(PROBE).catch(() => {}))
    try {
      await win.loadURL(url)
    } catch (error) {
      console.log(`  could not load: ${error.message}`)
      win.destroy()
      continue
    }
    // Shown without taking focus: the background state is the real one.
    win.showInactive()
    await measure(win, 'background')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    // The page hears of it as it would of a click into the window.
    await win.webContents.executeJavaScript(`window.dispatchEvent(new Event('focus'))`)
    await measure(win, 'in use')
    win.destroy()
    await sleep(300)
  }
  app.quit()
})
