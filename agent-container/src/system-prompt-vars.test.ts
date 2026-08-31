import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { buildSystemPromptVars, generateSystemPrompt } from './claude-code'
import { SERVICES } from './tools/search-connected-account-services'
import { BROWSER_USE_GUIDANCE_HINT } from './tools/browser'
import { COMPUTER_USE_GUIDANCE_HINT } from './tools/computer-use'

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
    // platformServices shares PLATFORM_AUTH_ACTIVE with webhookEndpoints, but
    // its procedural API details now live in the on-demand guide.
    expect(out.includes('## Built-in media generation')).toBe(webhook)
    expect(out.includes('/opt/gamut/docs/media-generation.md')).toBe(webhook)
    // Spending the user's money is an approval rule, so the cost confirmation
    // and the no-invented-slugs rule stay in the prompt even though the API
    // procedure moved out.
    expect(out.includes('cost from that model')).toBe(webhook)
    expect(out.includes('Never invent a model slug')).toBe(webhook)
    expect(out.includes('## Built-in X reads')).toBe(webhook)
    expect(out.includes('/opt/gamut/docs/x.md')).toBe(webhook)
    expect(out.includes('Never invent an X endpoint')).toBe(webhook)
    expect(out.includes('$0.01 per person')).toBe(webhook)
    expect(out).not.toContain('v1/replicate')
    expect(out).not.toContain('v1/x')
    expect(out).not.toContain('ANTHROPIC_AUTH_TOKEN')
  })

  // The platform's model table replaced a scraped catalog: listing is filtered
  // by `kind`, the list row carries the cost the confirmation must quote, and a
  // 403 means re-list rather than retry.
  it('teaches the list-then-schema-then-create Replicate contract in the guide', () => {
    const guide = readFileSync(join(__dirname, '..', 'docs', 'media-generation.md'), 'utf8')

    expect(guide).toContain('/v1/replicate/models?kind=')
    for (const kind of ['image', 'video', 'audio', 'talking_head', '3d', 'document']) {
      expect(guide, `kind ${kind} must be documented`).toContain(`\`${kind}\``)
    }
    expect(guide).toContain('GET /models/{owner}/{name}')
    expect(guide).toContain('POST /models/{owner}/{name}/predictions')
    expect(guide).toContain('403')
    expect(guide).toMatch(/`Prefer: wait`/)

    // The scraped-catalog endpoint and its error-message fallback are gone.
    expect(guide).not.toContain('models/_/_')
    expect(guide).not.toContain('Available models')
  })

  it('teaches the X read contract in the guide', () => {
    const guide = readFileSync(join(__dirname, '..', 'docs', 'x.md'), 'utf8')
    expect(guide).toContain('/2/tweets/search/recent')
    expect(guide).toContain('/2/users/by/username/{username}')
    expect(guide).toContain('/tweets`')
    expect(guide).toContain('7 days')
    expect(guide).toContain('followers')
    expect(guide).toContain('Never print either environment variable')
  })

  it('references every image-owned capability guide and keeps its source file present', () => {
    process.env.COMPOSIO_PLATFORM_MODE = 'true'
    process.env.PLATFORM_AUTH_ACTIVE = 'true'
    process.env.HOST_PLATFORM = 'darwin'
    const out = generateSystemPrompt()
    const guides = [
      'session-history.md',
      'scheduling-and-resuming.md',
      'webhooks.md',
      'media-generation.md',
      'chat-integrations.md',
      'browser-use.md',
      'computer-use.md',
      'x.md',
    ]

    for (const guide of guides) {
      expect(out).toContain(`/opt/gamut/docs/${guide}`)
      const sourcePath = join(__dirname, '..', 'docs', basename(guide))
      expect(existsSync(sourcePath), `${guide} must be copied into the image`).toBe(true)
      expect(readFileSync(sourcePath, 'utf8').trim().length).toBeGreaterThan(100)
    }
  })

  // A `/opt/gamut/docs/...` path the prompt names but the image does not ship
  // sends the agent into a failed Read mid-task, so the reference set and the
  // shipped set must match exactly in both directions.
  it('never names a guide path the image does not ship, in any gate combination', () => {
    const referenced = new Set<string>()
    for (const composio of [false, true]) {
      for (const webhook of [false, true]) {
        for (const host of ['linux', 'darwin']) {
          for (const subagents of ['allow', 'block'] as const) {
            process.env.COMPOSIO_PLATFORM_MODE = String(composio)
            process.env.PLATFORM_AUTH_ACTIVE = String(webhook)
            process.env.HOST_PLATFORM = host
            const out = generateSystemPrompt(undefined, undefined, undefined, undefined, undefined, { subagents })
            for (const match of out.matchAll(/\/opt\/gamut\/docs\/([\w./-]+\.md)/g)) {
              referenced.add(match[1])
            }
          }
        }
      }
    }

    expect(referenced.size).toBeGreaterThan(0)
    for (const path of referenced) {
      expect(existsSync(join(__dirname, '..', 'docs', path)), `${path} is referenced but not shipped`).toBe(true)
    }
    const shipped = readdirSync(join(__dirname, '..', 'docs'))
      .filter(name => name.endsWith('.md') && name !== 'README.md')
    expect([...referenced].sort()).toEqual(shipped.sort())
  })

  // Same failure as a missing guide, one step worse: the agent runs the command
  // and gets "No such file". The prompt, the guide, and bin/ must name the same
  // scripts, in every gate combination.
  it('never names an /opt/gamut/bin script the image does not ship', () => {
    const referenced = new Set<string>()
    const sources = [readFileSync(join(__dirname, '..', 'docs', 'session-history.md'), 'utf8')]
    for (const subagents of ['allow', 'block'] as const) {
      process.env.PLATFORM_AUTH_ACTIVE = 'true'
      sources.push(generateSystemPrompt(undefined, undefined, undefined, undefined, undefined, { subagents }))
    }
    for (const source of sources) {
      for (const match of source.matchAll(/\/opt\/gamut\/bin\/([\w.-]+)/g)) referenced.add(match[1])
    }

    const shipped = readdirSync(join(__dirname, '..', 'bin'))
    expect([...referenced].sort()).toEqual(shipped.sort())
  })

  // The tool-result hints and the prompt must agree. When a specialist subagent
  // exists the prompt says to delegate instead of reading; an unconditional
  // "read this now" hint on the same call either undoes that or teaches the
  // model to ignore these hints — including where the read is the only source.
  it('keeps the browser and computer-use hints conditional, matching the delegate-first prompt', () => {
    process.env.HOST_PLATFORM = 'darwin'
    const delegating = generateSystemPrompt(undefined, undefined, undefined, undefined, undefined, { subagents: 'allow' })
    expect(delegating).toContain('only when you drive the browser yourself')
    expect(delegating).toContain('only when you drive the app yourself')

    for (const hint of [BROWSER_USE_GUIDANCE_HINT, COMPUTER_USE_GUIDANCE_HINT]) {
      expect(hint).toContain('rather than delegate')
      expect(hint).not.toContain('Required guidance')
    }

    // Without a specialist there is nothing to delegate to, so the prompt must
    // ask for the read outright.
    const solo = generateSystemPrompt(undefined, undefined, undefined, undefined, undefined, { subagents: 'block' })
    expect(solo).toContain('Read `/opt/gamut/docs/browser-use.md` before browser work')
    expect(solo).toContain('Read `/opt/gamut/docs/computer-use.md` before app interaction')
  })

  // Dashboard guidance lives in the `dashboards` skill, not a docs guide — a
  // second copy under docs/ is what this PR removed.
  it('routes dashboard work to the skill rather than a docs guide', () => {
    for (const subagents of ['allow', 'block'] as const) {
      const out = generateSystemPrompt(undefined, undefined, undefined, undefined, undefined, { subagents })
      expect(out).toContain('`dashboards` skill')
      expect(out).not.toContain('building-dashboards.md')
    }
    expect(existsSync(join(__dirname, '..', 'skills', 'dashboards', 'SKILL.md'))).toBe(true)
  })

  // Every relative link inside the shipped docs resolves to a shipped file.
  // Links to a docs tree that only exists on the website leave the agent
  // Read-ing a path that is not in the image.
  it('keeps every relative link inside the shipped docs resolvable', () => {
    const docsDir = join(__dirname, '..', 'docs')
    const files = [
      ...readdirSync(docsDir).filter(name => name.endsWith('.md')).map(name => join(docsDir, name)),
      ...readdirSync(join(docsDir, 'faqs')).map(name => join(docsDir, 'faqs', name)),
    ]

    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/]\((?!https?:|#)([^)]+)\)/g)) {
        const target = join(dirname(file), match[1])
        expect(existsSync(target), `${basename(file)} links to missing ${match[1]}`).toBe(true)
      }
    }
  })

  // The prompt's toolkit list is what the agent picks a `request_connected_account`
  // slug from without a discovery round-trip, so it has to stay in step with the
  // catalog `search_connected_account_services` answers from.
  it('keeps the prompt toolkit list in step with the searchable service catalog', () => {
    const line = generateSystemPrompt()
      .split('\n')
      .find(candidate => candidate.startsWith('**Supported services include:**'))
    expect(line, 'prompt no longer has a "Supported services include" line').toBeDefined()

    const promptSlugs = [...line!.matchAll(/`([a-z_0-9]+)`/g)].map(match => match[1])
    expect(new Set(promptSlugs).size, 'prompt lists a slug twice').toBe(promptSlugs.length)
    expect(promptSlugs.sort()).toEqual(SERVICES.map(service => service.slug).sort())
  })

  // The FAQ used to carry its own copy of the toolkit list, which drifted
  // silently against the two real sources.
  it('does not let the integrations FAQ grow a second toolkit list', () => {
    const faq = readFileSync(join(__dirname, '..', 'docs', 'faqs', 'what-integrations-are-supported.md'), 'utf8')
    const catalogSlugs = SERVICES.map(service => service.slug)
    const echoed = catalogSlugs.filter(slug => new RegExp(`\`${slug}\``).test(faq))
    expect(echoed, 'FAQ should point at the prompt/search tool, not restate slugs').toEqual([])
  })

  it('tells the agent to keep reusable work on /workspace and large ephemeral files on /tmp', () => {
    const out = generateSystemPrompt()
    expect(out).toContain('## Workspace vs Tmp')
    expect(out).toContain('Your main working directory is `/workspace`')
    expect(out).toContain('Store any reusable content / code / files / output in it')
    expect(out).toContain('`/tmp` is a faster ephemeral location')
    expect(out).toContain('For large temporary files / installs / temp work-trees')
  })

  it('routes product questions through the complete image-owned FAQ directory', () => {
    const out = generateSystemPrompt()
    const faqDir = join(__dirname, '..', 'docs', 'faqs')
    const expectedFaqs = [
      'how-do-i-get-help-or-report-a-bug.md',
      'is-my-data-secure.md',
      'what-can-the-agent-do.md',
      'what-integrations-are-supported.md',
      'what-is-gamut-and-how-does-it-work.md',
    ]

    expect(out).toContain('## Product Knowledge FAQs')
    expect(out).toContain('ls /opt/gamut/docs/faqs')
    expect(out).toContain('Use Read specifically')
    expect(out).toContain('do not read FAQ contents with Bash')
    expect(readdirSync(faqDir).sort()).toEqual(expectedFaqs)
    for (const faq of expectedFaqs) {
      const content = readFileSync(join(faqDir, faq), 'utf8')
      expect(content).toMatch(/^---\n/)
      expect(content.trim().length).toBeGreaterThan(100)
    }
  })

  // The pause/resume guidance must always render: without it agents reach for
  // schedule_task ("new session") when they mean "continue THIS conversation
  // later", which loses the context the wait was for.
  it('always teaches schedule_resume and how it differs from schedule_task', () => {
    const out = generateSystemPrompt()
    expect(out).toContain('## Pausing and Resuming This Session')
    expect(out).toContain('mcp__user-input__schedule_resume')
    // The decision rule both directions
    expect(out).toContain('THIS SAME conversation')
    expect(out).toContain('Use `schedule_task` only for genuinely independent work')
  })

  it('keeps expired assigned accounts visible and directs the agent through proxy re-auth', () => {
    process.env.CONNECTED_ACCOUNTS = JSON.stringify({
      notion: [{ name: 'Notion', id: 'account-notion', status: 'expired' }],
    })

    const out = generateSystemPrompt()
    expect(out).toContain('## Connected Accounts (Assigned)')
    expect(out).toContain('Notion (ID: `account-notion`, status: `expired`)')
    expect(out).toContain('Make the intended proxy call')
    expect(out).toContain('Do NOT report them as missing')
  })

  it('does not promise an in-chat MCP reconnect when no cached tools exist', () => {
    process.env.REMOTE_MCPS = JSON.stringify([{
      id: 'mcp-empty',
      name: 'Empty MCP',
      status: 'auth_required',
      proxyUrl: 'http://host/api/mcp-proxy/agent/mcp-empty',
      tools: [],
    }])

    const out = generateSystemPrompt()
    expect(out).toContain('No cached tools are available for this server.')
    expect(out).toContain('reconnect it from Connections')
    expect(out).not.toContain('mcp__Empty_MCP__<tool_name>')
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
  it('the template interpolates only through <% %>, never dollar-brace VAR', () => {
    const template = readFileSync(__dirname + '/system-prompt.md', 'utf-8')
    expect(template).not.toMatch(/\$\{[A-Za-z_]+\}/)
  })
})

describe('subagent capability gating', () => {
  const render = (policies?: { subagents?: 'allow' | 'review' | 'block'; workflows?: 'allow' | 'review' | 'block' }) =>
    generateSystemPrompt(undefined, undefined, undefined, undefined, undefined, policies)

  it.each([
    { label: 'no policies', policies: undefined },
    { label: 'subagents allow', policies: { subagents: 'allow' as const } },
    { label: 'subagents review', policies: { subagents: 'review' as const } },
  ])('$label: delegation sections render', ({ policies }) => {
    const out = render(policies)
    expect(out).toContain('Use the Agent tool with specialized agents')
    expect(out).toContain('### Web Browser Agent (delegate browsing tasks)')
    expect(out).toContain('## Dashboard Builder Agent')
    expect(out).not.toContain('## Building Dashboards')
    expect(out).not.toMatch(/<%|%>/)
  })

  it('subagents block: no delegation mention survives anywhere in the prompt', () => {
    process.env.HOST_PLATFORM = 'darwin' // include the computer-use block too
    const out = render({ subagents: 'block' })
    expect(out).not.toMatch(/subagent/i)
    expect(out).not.toContain('Agent tool')
    expect(out).not.toContain('Task(')
    // "don't delegate further" (cross-agent invocation) legitimately survives;
    // every instruction TO delegate must not.
    expect(out).not.toMatch(/delegate to the|Delegate:|delegating|delegations/i)
    // Direct-work fallbacks take the delegation sections' place
    expect(out).toContain('### Browsing Workflow')
    expect(out).toContain('## Building Dashboards')
    expect(out).not.toMatch(/<%|%>/)
  })

  it('workflow policy does not affect the prompt (the Workflow tool self-describes)', () => {
    expect(render({ workflows: 'block' })).toBe(render(undefined))
  })

  it('teaches exact model routing only when model-backed subagents are available', () => {
    const withoutCatalog = generateSystemPrompt()
    const withCatalog = generateSystemPrompt(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [{ id: 'openai/gpt-5.5', label: 'GPT 5.5' }],
    )

    expect(withoutCatalog).not.toContain('You can use a different model')
    expect(withCatalog).toContain('You can use a different model')
    expect(withCatalog).toContain('latest enabled model in an available model family')
    expect(withCatalog).toContain("omit the Agent tool's `model` argument")
  })

  it('does not advertise model routing when subagents are blocked', () => {
    const out = generateSystemPrompt(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { subagents: 'block' },
      [{ id: 'openai/gpt-5.5', label: 'GPT 5.5' }],
    )

    expect(out).not.toContain('model-*')
  })

  it('blocking subagents orphans no heading', () => {
    const bodyless = (prompt: string) => {
      const lines = prompt.split('\n')
      return lines.filter((line, i) => {
        if (!/^#{1,4} /.test(line)) return false
        const next = lines.slice(i + 1).find(l => l.trim() !== '')
        return next !== undefined && /^#{1,4} /.test(next)
      })
    }
    for (const desktop of [true, false]) {
      process.env.HOST_PLATFORM = desktop ? 'darwin' : 'linux'
      expect(bodyless(render({ subagents: 'block' }))).toEqual(bodyless(render(undefined)))
    }
  })
})
