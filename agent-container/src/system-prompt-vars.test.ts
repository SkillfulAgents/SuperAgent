import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildSystemPromptVars, generateSystemPrompt } from './claude-code'

const KEYS = ['COMPOSIO_PLATFORM_MODE', 'PLATFORM_AUTH_ACTIVE', 'CONNECTED_ACCOUNTS', 'REMOTE_MCPS', 'CLAUDE_CONFIG_DIR', 'HOST_PLATFORM']
let saved: Record<string, string | undefined>
beforeEach(() => { saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]])); for (const k of KEYS) delete process.env[k] })
afterEach(() => { for (const k of KEYS) { saved[k] === undefined ? delete process.env[k] : process.env[k] = saved[k]! } })

describe('buildSystemPromptVars', () => {
  it('defaults CLAUDE_CONFIG_DIR when the host env is unset', () => {
    expect(buildSystemPromptVars(undefined, undefined, undefined, undefined).CLAUDE_CONFIG_DIR).toBe('/workspace/.claude')
  })
})

describe('generateSystemPrompt rendering', () => {
  // Trigger gating across every env combination, in one table so each case is
  // named. The `## Webhook Triggers` header always renders (disconnected hosts
  // still get the disclaimer under it), but the `### Custom Webhook Endpoints`
  // child only renders when composio content precedes it -- otherwise it would
  // be the sole child of its own parent. The composio-only `setup_trigger`
  // bullet is nested in the webhook body so it shows only when both are on; and
  // no combination may leak an unrendered `<% %>` or `${VAR}`.
  const combos = [
    { label: 'neither connected', env: {}, composio: false, webhook: false },
    { label: 'composio only', env: { COMPOSIO_PLATFORM_MODE: 'true' }, composio: true, webhook: false },
    { label: 'webhook only', env: { PLATFORM_AUTH_ACTIVE: 'true' }, composio: false, webhook: true },
    { label: 'both connected', env: { COMPOSIO_PLATFORM_MODE: 'true', PLATFORM_AUTH_ACTIVE: 'true' }, composio: true, webhook: true },
  ]
  it.each(combos)('$label: no leaked tokens, correct gating, header always present', ({ env, composio, webhook }) => {
    Object.assign(process.env, env)
    const out = generateSystemPrompt()
    expect(out).not.toMatch(/<%|%>/)                                          // no unrendered template tag
    expect(out).not.toMatch(/\$\{[A-Z_]+\}/)                                  // no dead ${VAR} interpolation
    expect(out).toContain('## Webhook Triggers')                             // header always -> disclaimer has a home
    expect(out.includes('mcp__user-input__setup_trigger')).toBe(composio)     // composio tools gated
    expect(out.includes('create_webhook_endpoint')).toBe(webhook)             // webhook body gated
    expect(out.includes('### Custom Webhook Endpoints')).toBe(composio && webhook) // child heading needs a sibling
    expect(out.includes('Prefer `setup_trigger`')).toBe(composio && webhook)  // composio-only bullet nested in webhook body
    expect(out.includes('platform-dependent')).toBe(!composio && !webhook)    // disconnected fallback
  })

  // A heading whose body is entirely gated renders as a title with the next
  // heading directly beneath it. Some headings (`## File Handling`) are static
  // containers of subheadings and are bodyless in every render, which is fine --
  // what must never happen is gating stripping a body and orphaning its heading.
  // Hence the invariant: the set of bodyless headings is the same under every
  // combination of gates.
  const bodylessHeadings = (prompt: string) => {
    const lines = prompt.split('\n')
    return lines.filter((line, i) => {
      if (!/^#{1,4} /.test(line)) return false
      const next = lines.slice(i + 1).find(l => l.trim() !== '')
      return next !== undefined && /^#{1,4} /.test(next)
    })
  }
  const gateCombos = [false, true].flatMap(composio =>
    [false, true].flatMap(webhook =>
      [false, true].map(desktop => ({ composio, webhook, desktop })),
    ),
  )
  it.each(gateCombos)('composio=$composio webhook=$webhook desktop=$desktop: gating orphans no heading', ({ composio, webhook, desktop }) => {
    process.env.COMPOSIO_PLATFORM_MODE = 'true'
    process.env.PLATFORM_AUTH_ACTIVE = 'true'
    process.env.HOST_PLATFORM = 'darwin'
    const baseline = bodylessHeadings(generateSystemPrompt())

    if (!composio) delete process.env.COMPOSIO_PLATFORM_MODE
    if (!webhook) delete process.env.PLATFORM_AUTH_ACTIVE
    if (!desktop) process.env.HOST_PLATFORM = 'linux'

    expect(bodylessHeadings(generateSystemPrompt())).toEqual(baseline)
  })

  // Same defect class as an orphaned heading: the prompt says `see "X" below`
  // while X sits behind a gate that is off, pointing the agent at nothing.
  it.each(gateCombos)('composio=$composio webhook=$webhook desktop=$desktop: every cross-referenced section exists', ({ composio, webhook, desktop }) => {
    if (composio) process.env.COMPOSIO_PLATFORM_MODE = 'true'
    if (webhook) process.env.PLATFORM_AUTH_ACTIVE = 'true'
    process.env.HOST_PLATFORM = desktop ? 'darwin' : 'linux'
    process.env.CONNECTED_ACCOUNTS = JSON.stringify({ gmail: [{ name: 'A', id: 'x' }] })

    const out = generateSystemPrompt()
    const headings = new Set(
      [...out.matchAll(/^#{1,4} (.+)$/gm)].map(m => m[1].trim()),
    )
    const refs = [...out.matchAll(/see "([^"]+)"/g)].map(m => m[1])
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      expect(headings.has(ref), `prompt references section "${ref}", which did not render`).toBe(true)
    }
  })

  it.each([
    { label: 'desktop host exposes computer use', platform: 'darwin', present: true },
    { label: 'linux host hides computer use', platform: 'linux', present: false },
  ])('$label', ({ platform, present }) => {
    process.env.HOST_PLATFORM = platform
    const out = generateSystemPrompt()
    expect(out.includes('## Computer Use')).toBe(present)
    expect(out.includes('computer_launch')).toBe(present)
    expect(out.includes('request_script_run')).toBe(present)
  })

  // A vendor disables the native tool, so the catalog must name whichever tool the
  // model actually has -- and must NOT still name the one it replaced. Either vendor
  // can be active alone, so assert the full cross product.
  it.each([
    { search: undefined, fetch: undefined, want: ['`WebFetch`', '`WebSearch`'] },
    { search: 'exa', fetch: undefined, want: ['`WebFetch`', '`mcp__web__web_search`'] },
    { search: undefined, fetch: 'exa', want: ['`mcp__web__web_fetch`', '`WebSearch`'] },
    { search: 'exa', fetch: 'exa', want: ['`mcp__web__web_fetch`', '`mcp__web__web_search`'] },
  ])('web tool catalog: search=$search fetch=$fetch', ({ search, fetch, want }) => {
    const catalog = generateSystemPrompt(undefined, undefined, undefined, search, fetch)
      .split('\n').find(l => l.startsWith('- **File system, shell, web**'))
    expect(catalog).toBeDefined()
    for (const label of want) expect(catalog).toContain(label)
    if (search) expect(catalog).not.toContain('`WebSearch`')
    if (fetch) expect(catalog).not.toContain('`WebFetch`')
  })

  // Future-proofing the template <-> code seam: the template is edited often,
  // and these guard the drift that would otherwise fail silently. Tags inside a
  // list section resolve against the list's element, then outward through the
  // enclosing scopes -- so build the bag with every list populated and walk the
  // template the way Mustache does.
  it('every <% %> template tag resolves against SystemPromptVars, and no field is dead', () => {
    process.env.CONNECTED_ACCOUNTS = JSON.stringify({ gmail: [{ name: 'A', id: 'x' }] })
    process.env.REMOTE_MCPS = JSON.stringify([{ name: 'M', tools: [{ name: 't' }] }])
    const vars = buildSystemPromptVars(['API_KEY'], 'be terse', ['hint'], 'exa') as Record<string, unknown>

    const template = readFileSync(__dirname + '/system-prompt.md', 'utf-8')
    const stack: Array<Record<string, unknown>> = [vars]
    const referenced = new Set<string>()
    const resolve = (name: string): { value: unknown; depth: number } | undefined => {
      for (let i = stack.length - 1; i >= 0; i--) if (name in stack[i]) return { value: stack[i][name], depth: i }
      return undefined
    }

    for (const [, sigil, name] of template.matchAll(/<%([#^/]?)([A-Za-z0-9_.]+)%>/g)) {
      if (sigil === '/') { stack.pop(); continue }
      if (name === '.') {
        expect(stack.length, 'the <%.%> item tag is only meaningful inside a list section').toBeGreaterThan(1)
        continue
      }
      const hit = resolve(name)
      expect(hit, `template tag <%${name}%> resolves to nothing (would render empty)`).toBeDefined()
      if (hit!.depth === 0) referenced.add(name)
      if (sigil === '#' || sigil === '^') {
        // A list pushes its element's shape; a boolean keeps the current scope.
        const value = hit!.value
        const frame = Array.isArray(value) && typeof value[0] === 'object' ? value[0] as Record<string, unknown> : {}
        stack.push(frame)
      }
    }
    expect(stack.length, 'every section tag must be closed').toBe(1)

    for (const key of Object.keys(vars)) {
      expect(referenced.has(key), `SystemPromptVars.${key} is never referenced in system-prompt.md (dead var)`).toBe(true)
    }
  })
  // Source-level, not render-level: a `${VAR}` inside a gated-off section never
  // appears in any rendered output, so the combos table above cannot see it.
  it('the template interpolates only through <% %>, never ${VAR}', () => {
    const template = readFileSync(__dirname + '/system-prompt.md', 'utf-8')
    expect(template).not.toMatch(/\$\{[A-Za-z_]+\}/)
  })
})
