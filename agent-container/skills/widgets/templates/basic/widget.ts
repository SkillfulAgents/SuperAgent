/**
 * Widget refresh script.
 *
 * Gamut runs this with `bun run widget` inside the agent container (package.json
 * `scripts.widget`, the widget half's answer to a dashboard's `scripts.start`) —
 * cwd is the artifact directory, no conversation, no LLM. Its job: gather fresh
 * data, rewrite widget.html with that data baked in, and say how long that
 * output stays true by writing widget.json. The platform then rasterizes
 * widget.html and shows it on the user's home screens.
 *
 * Contract:
 *   - Must finish within gamut.widget.timeoutSeconds (package.json), default 30s.
 *   - Must write a complete, self-contained widget.html (no external scripts,
 *     styles or fetches — the snapshot is displayed with scripts disabled).
 *   - Must write widget.json: { "validUntil": ISO-8601 | null }. YOU decide the
 *     expiry from the data: a stock widget is valid ~5 min while the market is
 *     open but until the next open after close; a calendar widget is valid
 *     until the next event starts (or until Monday over a free weekend);
 *     null means "never on its own" (only a rewrite changes it). If you skip
 *     this the platform assumes one hour and nags you about it.
 *   - Exit non-zero on failure; the previous widget.html keeps serving and the
 *     error shows up in `refresh_widget` / widget.log.
 *   - Env: WIDGET_SLUG, WIDGET_DIR, WIDGET_OUTPUT (absolute path of widget.html),
 *     WIDGET_META (absolute path of widget.json), plus every secret /
 *     connected-account token the agent itself has.
 *
 * Inside a dashboard artifact this script can import the dashboard's own data
 * helpers — one source of truth for the number on the card and on the page.
 */

const OUTPUT = process.env.WIDGET_OUTPUT ?? `${import.meta.dir}/widget.html`
const META = process.env.WIDGET_META ?? `${import.meta.dir}/widget.json`

interface WidgetData {
  label: string
  value: string
  detail: string
  /** 0–100 for the progress bar; omit to hide it. */
  percent?: number
  /** When this snapshot stops being true. null = only a rewrite changes it. */
  validUntil: Date | null
}

async function loadData(): Promise<WidgetData> {
  // TODO: replace with the real data source — an API call, a file under
  // /workspace, a database, a connected account. Keep it fast and offline-safe.
  const now = new Date()
  const nextHour = new Date(now)
  nextHour.setMinutes(0, 0, 0)
  nextHour.setHours(nextHour.getHours() + 1)
  return {
    label: 'Updated',
    value: now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    detail: now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
    percent: (now.getHours() / 24) * 100,
    validUntil: nextHour,
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fill(html: string, field: string, value: string): string {
  // Replace the inner text of the element carrying data-field="<field>".
  const re = new RegExp(`(<[^>]*data-field="${field}"[^>]*>)([\\s\\S]*?)(</)`)
  // A callback, not a replacement string: in a replacement string the data's
  // own `$` sequences are expansions, so a price of $1.99 would paste capture
  // group 1 back into the document and drop the digit.
  return html.replace(re, (_match, open: string, _inner: string, close: string) =>
    `${open}${escapeHtml(value)}${close}`,
  )
}

async function writeAtomic(file: string, content: string): Promise<void> {
  // A reader must never see a half-written snapshot.
  const tmp = `${file}.tmp`
  await Bun.write(tmp, content)
  const fs = await import('node:fs/promises')
  await fs.rename(tmp, file)
}

const data = await loadData()
let html = await Bun.file(OUTPUT).text()
html = fill(html, 'label', data.label)
html = fill(html, 'value', data.value)
html = fill(html, 'detail', data.detail)
html = html.replace(
  /(data-field="bar"[^>]*style=")[^"]*(")/,
  `$1width: ${Math.max(0, Math.min(100, data.percent ?? 0)).toFixed(0)}%$2`,
)
html = html.replace(/data-generated-at="[^"]*"/, `data-generated-at="${new Date().toISOString()}"`)

await writeAtomic(OUTPUT, html)
await writeAtomic(META, JSON.stringify({ validUntil: data.validUntil ? data.validUntil.toISOString() : null }) + '\n')
console.log(`wrote ${OUTPUT}, valid until ${data.validUntil?.toISOString() ?? 'rewritten'}`)
