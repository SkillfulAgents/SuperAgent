import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { buildSkillZip } from '../helpers/skill-zip'
import DOMPurify from 'dompurify'

// Monaco owns this DOM and provides no app test IDs for its rendered lines.
/* eslint-disable local-rules/no-brittle-playwright-selectors */

test.describe('Local skill code editor', () => {
  test.setTimeout(120_000)
  let temporaryDirectory: string
  let skillName: string
  let editorRequests: string[]
  let pageErrors: string[]
  let diagnostics: string[]

  async function openFiles(page: Page) {
    const row = page.getByTestId('installed-skill-row').filter({ hasText: skillName })
    await row.hover()
    await row.getByRole('button', { name: `Actions for ${skillName}` }).click()
    await page.getByRole('button', { name: 'View Files', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: `Files — ${skillName}` })
    await expect(dialog.locator('.monaco-editor')).toBeVisible({ timeout: 30_000 })
    return dialog
  }

  test.beforeEach(async ({ page, baseURL }) => {
    editorRequests = []
    pageErrors = []
    diagnostics = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') diagnostics.push(`console: ${message.text()}`)
    })
    page.on('requestfailed', (request) => diagnostics.push(`request: ${request.url()} ${request.failure()?.errorText}`))
    page.on('response', (response) => {
      if (response.status() >= 400) diagnostics.push(`response: ${response.status()} ${response.url()}`)
    })
    await page.addInitScript(() => performance.setResourceTimingBufferSize(10_000))
    // The editor and all language workers must work without a public CDN.
    await page.route('**/*', (route) => {
      if (route.request().url().startsWith(baseURL!)) return route.continue()
      if (/monaco|jsdelivr|cdnjs|unpkg/.test(route.request().url())) editorRequests.push(route.request().url())
      return route.abort()
    })
    const app = new AppPage(page)
    await app.goto()
    await app.waitForAgentsLoaded()
    await new AgentPage(page).clickCreateAgent()
    await expect(page.getByTestId('agent-breadcrumb')).toHaveText('Untitled')

    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-code-editor-'))
    skillName = `editor-${Date.now()}`
    const file = await buildSkillZip(path.join(temporaryDirectory, 'editor.skill'), {
      name: skillName,
      extraFiles: {
        'config.json': '{ "enabled": true }',
        'helper.ts': 'const count: number = "wrong";\n',
        'style.css': '.example { color: red; }\n',
        'index.html': '<div class="example">Hello</div>\n',
      },
    })
    await page.getByTestId('import-skill-button').click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('input[type="file"]').setInputFiles(file)
    await dialog.locator('button[type="submit"]').click()
    await expect(dialog).toBeHidden({ timeout: 15_000 })
  })

  test.afterEach(async ({ page }, testInfo) => {
    if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('browser-diagnostics', {
        body: [`page: ${page.url()}`, ...pageErrors, ...diagnostics].join('\n'),
        contentType: 'text/plain',
      })
    }
    expect(pageErrors).toEqual([])
  })

  test('edits, saves, and reopens locally in light and dark themes', async ({ page }, testInfo) => {
    let dialog = await openFiles(page)
    await dialog.getByRole('button', { name: 'config.json', exact: true }).click()
    await expect(dialog.locator('.view-lines')).toContainText('enabled')
    const save = page.waitForResponse((response) =>
      response.request().method() === 'PUT' && response.url().includes('/files/content'),
    )
    // Edit an existing token through the editor instead of simulating a bulk
    // paste as individual keystrokes (which invokes bracket auto-completion).
    await dialog.locator('.view-lines').getByText('true', { exact: true }).dblclick()
    const content = '{ "enabled": false }'
    await page.keyboard.type('false')
    const saved = await save
    expect(saved.ok()).toBe(true)
    expect(saved.request().postDataJSON()).toMatchObject({ path: 'config.json', content })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // A fresh page loads the saved content from the server, not the old model.
    await page.reload()
    dialog = await openFiles(page)
    await dialog.getByRole('button', { name: 'config.json', exact: true }).click()
    await expect(dialog.locator('.view-lines')).toContainText('false')
    for (const dark of [false, true]) {
      await page.evaluate((value) => document.documentElement.classList.toggle('dark', value), dark)
      await expect(dialog.locator('.monaco-editor')).toHaveClass(new RegExp(dark ? 'vs-dark' : '\\bvs\\b'))
      const bounds = await dialog.locator('.monaco-editor').boundingBox()
      expect(bounds?.width).toBeGreaterThan(300)
      expect(bounds?.height).toBeGreaterThan(300)
      await dialog.screenshot({ path: testInfo.outputPath(`editor-${dark ? 'dark' : 'light'}.png`) })
    }
    expect(editorRequests).toEqual([])
  })

  test('runs local language workers and sanitizes editor HTML', async ({ page }) => {
    const dialog = await openFiles(page)
    const workerUrls: string[] = []
    page.on('worker', (worker) => workerUrls.push(worker.url()))
    for (const name of ['config.json', 'helper.ts', 'style.css', 'index.html']) {
      await dialog.getByRole('button', { name, exact: true }).click()
      await expect(dialog.locator('.view-lines')).not.toBeEmpty()
    }

    const checks = await page.evaluate(async () => {
      const moduleUrl = performance.getEntriesByType('resource')
        .map((entry) => entry.name).find((name) => /\/monaco-editor\.js\?/.test(name))
      if (!moduleUrl) throw new Error('The local Monaco module did not load')
      const monaco = await import(moduleUrl) as typeof import('monaco-editor')
      const json = monaco.editor.createModel('{ "enabled": true }', 'json')
      const typescript = monaco.editor.createModel('const count: number = "wrong";', 'typescript')
      const css = monaco.editor.createModel('.example { color: red; }', 'css')
      const html = monaco.editor.createModel('<html><body><div>Hello</div></body></html>', 'html')
      const host = document.createElement('div')
      document.body.appendChild(host)
      const formatter = monaco.editor.create(host, { model: css })
      try {
        const jsonWorker = await (await monaco.json.getWorker())(json.uri)
        const tsWorker = await (await monaco.typescript.getTypeScriptWorker())(typescript.uri)
        await formatter.getAction('editor.action.formatDocument')!.run()
        const cssFormatted = css.getValue().includes('\n')
        formatter.setModel(html)
        await formatter.getAction('editor.action.formatDocument')!.run()
        const htmlFormatted = html.getValue().includes('\n')
        const editor = monaco.editor.getEditors()[0]
        monaco.languages.registerHoverProvider('html', {
          provideHover: () => ({
            contents: [{ value: '<strong>Safe hover</strong><a href="javascript:alert(1)">Link</a>', supportHtml: true }],
          }),
        })
        editor.setPosition({ lineNumber: 1, column: 2 })
        editor.trigger('test', 'editor.action.showHover', {})
        return {
          jsonRoot: (await jsonWorker.parseJSONDocument(json.uri.toString()))?.root?.type,
          typeErrors: (await tsWorker.getSemanticDiagnostics(typescript.uri.toString())).length,
          cssFormatted,
          htmlFormatted,
        }
      } finally {
        formatter.dispose()
        host.remove()
        for (const model of [json, typescript, css, html]) model.dispose()
      }
    })
    expect(checks).toEqual({ jsonRoot: 'object', typeErrors: 1, cssFormatted: true, htmlFormatted: true })
    await expect(dialog.getByText('Safe hover', { exact: true })).toBeVisible()
    await expect(dialog.locator('a[href^="javascript:"]')).toHaveCount(0)

    // Follow the actual optimized module graph served to this browser. A normal
    // Vite resolver test can pass while the prebundler retains Monaco's old copy.
    const entry = await page.evaluate(() => performance.getEntriesByType('resource')
      .map((resource) => resource.name).find((url) => /\/monaco-editor\.js\?/.test(url)))
    const pending = [entry!]
    const visited = new Set<string>()
    let sanitizerSource = ''
    while (pending.length && !sanitizerSource) {
      const url = pending.pop()!
      if (visited.has(url)) continue
      visited.add(url)
      const response = await page.request.get(url)
      expect(response.ok()).toBe(true)
      const source = await response.text()
      if (/DOMPurify\.version\s*=/.test(source)) sanitizerSource = source
      for (const match of source.matchAll(/["']([^"']*\/chunk-[\w-]+\.js(?:\?[^"']*)?)["']/g)) {
        pending.push(new URL(match[1], url).href)
      }
    }
    expect(sanitizerSource.match(/DOMPurify\.version = "([^"]+)"/)?.[1]).toBe(DOMPurify.version)
    expect(sanitizerSource.includes('monaco-editor/esm/vs/base/browser/dompurify/dompurify.js')).toBe(false)

    const sanitizerUrl = `/@fs/${path.join(process.cwd(), 'node_modules/monaco-editor/esm/vs/base/browser/domSanitize.js')}`
    const sanitized = await page.evaluate(async (url) => {
      const { sanitizeHtml } = await import(url)
      return String(sanitizeHtml('<strong>Safe</strong><img src=x onerror="window.bad=1"><a href="javascript:alert(1)">Link</a>'))
    }, sanitizerUrl)
    expect(sanitized).toContain('<strong>Safe</strong>')
    expect(sanitized).not.toContain('onerror')
    expect(sanitized).not.toContain('javascript:')
    expect(workerUrls.length).toBeGreaterThanOrEqual(4)
    expect(workerUrls.every((url) => url.startsWith('blob:') || url.startsWith(new URL(page.url()).origin))).toBe(true)
    expect(editorRequests).toEqual([])
  })
})
