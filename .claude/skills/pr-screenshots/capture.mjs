#!/usr/bin/env node
/**
 * PR screenshot runner for the pr-screenshots skill.
 *
 * Drives the mock web dev server (E2E_MOCK=true) with Playwright's bundled
 * Chromium, seeds agents/sessions through the same /api endpoints the e2e
 * suite uses, then walks a JSON shot list and writes PNGs. Prints the
 * markdown image lines and the `gh pr create --attach` flags to paste.
 *
 * Usage:
 *   node .claude/skills/pr-screenshots/capture.mjs <shots.json>
 *
 * Shot list schema (see shots.example.json):
 *   {
 *     "baseUrl": "http://localhost:47897",
 *     "outDir": "/abs/path/to/shots",
 *     "viewport": { "width": 1280, "height": 800 },   // optional
 *     "seed": {                                        // optional
 *       "agents": [
 *         { "name": "Release Notes Writer", "sessions": ["Summarise the last sprint"] }
 *       ]
 *     },
 *     "shots": [
 *       {
 *         "name": "agent-home",
 *         "path": "/agents/{{agent:Release Notes Writer}}",
 *         "colorScheme": "both",                       // "light" | "dark" | "both" (default both)
 *         "steps": [ { "click": "Settings" }, { "waitFor": "[data-testid=...]" } ],
 *         "fullPage": false,
 *         "clip": "[data-testid=agent-home-card]"      // optional: screenshot one element
 *       }
 *     ]
 *   }
 *
 * Placeholders in `path`: {{agent:<name>}} -> slug, {{session:<name>:<i>}} -> session id.
 *
 * Steps (run in order, each waits for the app to settle):
 *   { "click": "Visible text" }          role=button/link/menuitem/tab by name, else text
 *   { "clickTestId": "wizard-next" }     [data-testid=...]
 *   { "clickSelector": "css" }
 *   { "hover": "Visible text" }
 *   { "fill": { "selector": "css", "value": "text" } }
 *   { "type": "text" }                    keyboard.type into the focused element
 *   { "press": "Enter" }
 *   { "waitFor": "css" }                  visible, 10s
 *   { "wait": 500 }                       ms
 *   { "scrollTo": "css" }
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const listPath = process.argv[2]
if (!listPath) {
  console.error('usage: capture.mjs <shots.json>')
  process.exit(2)
}

const list = JSON.parse(fs.readFileSync(listPath, 'utf8'))
const baseUrl = (list.baseUrl ?? 'http://localhost:47897').replace(/\/$/, '')
const outDir = path.resolve(list.outDir ?? path.join(path.dirname(path.resolve(listPath)), 'shots'))
const viewport = list.viewport ?? { width: 1280, height: 800 }
fs.mkdirSync(outDir, { recursive: true })

const APP_READY = '[data-testid="app-sidebar"], [data-testid="wizard-container"]'
const WIZARD = '[data-testid="wizard-container"]'

async function api(method, route, body) {
  const res = await fetch(baseUrl + route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${await res.text()}`)
  return res.json()
}

async function waitForServer() {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl + '/api/settings')
      if (res.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`mock server not reachable at ${baseUrl} — start it first (see SKILL.md)`)
}

/** Seed agents + sessions. Returns { agents: { [name]: { slug, sessions: [id] } } }. */
async function seed(spec) {
  const agents = {}
  // Same placeholder key the e2e suite uses; without it every page carries a
  // red "No API key configured" banner. The mock container never calls out.
  if (spec?.apiKey !== false) {
    await api('PUT', '/api/settings', { apiKeys: { anthropicApiKey: 'sk-ant-e2e-mock-key' } })
  }
  if (!spec?.agents?.length) return { agents }
  const existing = await api('GET', '/api/agents')
  for (const a of spec.agents) {
    let agent = existing.find((x) => x.name === a.name)
    if (!agent) agent = await api('POST', '/api/agents', { name: a.name, description: a.description })
    const sessions = []
    for (const message of a.sessions ?? []) {
      const s = await api('POST', `/api/agents/${agent.slug}/sessions`, { message })
      sessions.push(s.id)
    }
    agents[a.name] = { slug: agent.slug, sessions }
    console.log(`seeded agent "${a.name}" -> ${agent.slug}${sessions.length ? ` (+${sessions.length} sessions)` : ''}`)
  }
  // Let the mock container finish streaming its canned replies.
  if (spec.agents.some((a) => a.sessions?.length)) await new Promise((r) => setTimeout(r, 2500))
  return { agents }
}

function resolvePath(p, seeded) {
  return p
    .replace(/\{\{agent:([^}]+)\}\}/g, (_, name) => {
      const a = seeded.agents[name.trim()]
      if (!a) throw new Error(`no seeded agent named "${name}"`)
      return a.slug
    })
    .replace(/\{\{session:([^:}]+):(\d+)\}\}/g, (_, name, i) => {
      const a = seeded.agents[name.trim()]
      const id = a?.sessions[Number(i)]
      if (!id) throw new Error(`no session #${i} for agent "${name}"`)
      return id
    })
}

function byText(page, text) {
  const roles = ['button', 'link', 'menuitem', 'tab', 'option']
  return page
    .getByRole(roles[0], { name: text })
    .or(page.getByRole(roles[1], { name: text }))
    .or(page.getByRole(roles[2], { name: text }))
    .or(page.getByRole(roles[3], { name: text }))
    .or(page.getByRole(roles[4], { name: text }))
    .or(page.getByText(text, { exact: true }))
    .first()
}

async function runStep(page, step) {
  if ('click' in step) return byText(page, step.click).click()
  if ('clickTestId' in step) return page.locator(`[data-testid="${step.clickTestId}"]`).first().click()
  if ('clickSelector' in step) return page.locator(step.clickSelector).first().click()
  if ('hover' in step) return byText(page, step.hover).hover()
  if ('fill' in step) return page.locator(step.fill.selector).first().fill(step.fill.value)
  if ('type' in step) return page.keyboard.type(step.type, { delay: 20 })
  if ('press' in step) return page.keyboard.press(step.press)
  if ('waitFor' in step) return page.locator(step.waitFor).first().waitFor({ state: 'visible', timeout: 10_000 })
  if ('wait' in step) return new Promise((r) => setTimeout(r, step.wait))
  if ('scrollTo' in step) return page.locator(step.scrollTo).first().scrollIntoViewIfNeeded()
  throw new Error(`unknown step ${JSON.stringify(step)}`)
}

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {})
  // Let transitions/animations finish before the frame is captured.
  await new Promise((r) => setTimeout(r, 400))
}

async function capture(browser, shot, scheme, seeded) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(baseUrl + resolvePath(shot.path ?? '/', seeded))
    // /settings renders outside the app shell (no sidebar), so the shell
    // selectors are a bonus signal; the root mount painting is the floor.
    await page.locator('#root > *').first().waitFor({ state: 'attached', timeout: 20_000 })
    await page.locator(APP_READY).first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
    if (await page.locator(WIZARD).isVisible()) {
      throw new Error('getting-started wizard is open — the data dir was not seeded with setupCompleted (run e2e/setup-e2e-data.js first)')
    }
    await settle(page)
    for (const step of shot.steps ?? []) {
      await runStep(page, step)
      await settle(page)
    }
    const file = path.join(outDir, `${shot.name}-${scheme}.png`)
    if (shot.clip) {
      await page.locator(shot.clip).first().screenshot({ path: file })
    } else {
      await page.screenshot({ path: file, fullPage: !!shot.fullPage })
    }
    if (errors.length) console.warn(`  ! page errors during "${shot.name}" (${scheme}):\n    ${errors.join('\n    ')}`)
    return file
  } finally {
    await context.close()
  }
}

await waitForServer()
const seeded = await seed(list.seed)
const browser = await chromium.launch()
const results = []
const failures = []
try {
  for (const shot of list.shots ?? []) {
    const schemes = shot.colorScheme === 'both' || !shot.colorScheme ? ['light', 'dark'] : [shot.colorScheme]
    for (const scheme of schemes) {
      try {
        const file = await capture(browser, shot, scheme, seeded)
        const alt = `${shot.alt ?? shot.name} (${scheme})`
        results.push({ file, alt })
        console.log(`wrote ${file}`)
      } catch (e) {
        failures.push(`${shot.name} (${scheme}): ${e.message.split('\n')[0]}`)
        console.error(`FAILED ${shot.name} (${scheme}): ${e.message.split('\n')[0]}`)
      }
    }
  }
} finally {
  await browser.close()
}

console.log('\n--- markdown (paste into the PR body) ---')
for (const r of results) console.log(`![${r.alt}](${r.file})`)
console.log('\n--- gh flags ---')
console.log(results.map((r) => `--attach '${r.file}#${r.alt.replace(/'/g, '')}'`).join(' \\\n  '))
if (failures.length) {
  console.error(`\n${failures.length} shot(s) failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
