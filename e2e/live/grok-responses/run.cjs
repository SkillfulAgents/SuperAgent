// Run inside the built agent image; see README.md. Grok inference, the bundled
// SDK, ClaudeCodeProcess, Bash/Read/Edit and Chromium are real. Only the web
// provider bridge uses local HTTP fixture pages; no email/chat is sent.
const fs = require('node:fs')
const { createServer } = require('node:http')
const { randomUUID, createHash } = require('node:crypto')
const assert = require('node:assert/strict')
const sharp = require('/app/node_modules/sharp')
const Anthropic = require('/app/node_modules/@anthropic-ai/sdk').default
const { connectionRuntimeSchema } = require('/app/dist/connection-runtime')
const { startLlmProxy } = require('/app/dist/llm-proxy')
const { fetchInput, reportSchema, packageMetadata } = require('./schema.cjs')
const work = '/workspace/grok-responses-validation'
const output = process.env.GROK_RESULTS_DIR || '/results'
const runtime = connectionRuntimeSchema.parse(JSON.parse(fs.readFileSync(process.env.GROK_RUNTIME_FILE || '/run/grok-runtime.json', 'utf8')))
assert.equal(runtime.proxy.format, 'responses')
const upstream = { responses: 0, messages: 0, images: 0, toolResults: 0 }
const realFetch = globalThis.fetch
// Record structural evidence only, never headers, credentials or request bodies.
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.startsWith('https://cli-chat-proxy.grok.com/v1/')) {
    if (url.endsWith('/responses')) upstream.responses++
    if (url.endsWith('/messages')) upstream.messages++
    if (typeof init?.body === 'string') {
      const body = JSON.parse(init.body)
      for (const item of body.input || []) {
        if (item.type === 'function_call_output') upstream.toolResults++
        upstream.images += (item.content || []).filter(part => part.type === 'input_image').length
      }
    }
  }
  return realFetch(input, init)
}
const markers = ['AMBER-241', 'COBALT-583', 'FERN-916']
const fetchedPages = []
const bridge = createServer(async (req, res) => {
  if (req.url?.startsWith('/page/')) {
    const i = Number(req.url.split('/').pop())
    res.setHeader('content-type', 'text/html')
    res.end(`<html><head><title>Grok fixture ${i}</title></head><body><h1>${markers[i] || 'COPPER'}</h1><p>Browser and fetch validation page.</p></body></html>`)
    return
  }
  if (req.url !== '/web-fetch/fetch' || req.headers.authorization !== 'Bearer local-fixture-only') { res.writeHead(404); res.end(); return }
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const input = fetchInput.parse(JSON.parse(Buffer.concat(chunks).toString()))
    assert.ok(/^http:\/\/127\.0\.0\.1:3030\/page\/[012]$/.test(input.url))
    const page = await realFetch(input.url)
    const content = await page.text()
    fetchedPages.push(input.url)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ result: { url: input.url, title: 'Local HTTP fixture', content: content.slice(0, input.maxChars || 10000), fetchedAt: new Date().toISOString() } }))
  } catch { res.writeHead(400); res.end('{}') }
})
process.env.SUPERAGENT_HOST_API_URL = 'http://127.0.0.1:3030'
process.env.PROXY_TOKEN = 'local-fixture-only'
// Real production browser server and tool registration.
require('/app/dist/server')
const { ClaudeCodeProcess } = require('/app/dist/claude-code')
const cases = []
let current
let sessionId
let agent
function attach(instance) {
  instance.on('claude-session-id', id => { sessionId = id })
  instance.on('error', error => current?.reject(error))
  instance.on('message', message => {
    if (!current) return
    if (message.type === 'stream_event') {
      const event = message.event
      if (event.type === 'message_start') current.blocks = new Set()
      if (event.type === 'content_block_start') {
        if (!Number.isInteger(event.index) || current.blocks.has(event.index)) current.streamErrors.push('Missing/reused block start index')
        current.blocks.add(event.index)
      }
      if (event.type === 'content_block_delta' || event.type === 'content_block_stop') {
        if (!Number.isInteger(event.index) || !current.blocks.has(event.index)) current.streamErrors.push('Delta/stop without an opened index')
      }
      if (event.type === 'message_delta' && event.index !== undefined) current.streamErrors.push('Indexed message_delta')
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') current.textDeltas++
      if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') current.thinkingDeltas++
    }
    if (message.type === 'assistant') for (const block of message.message?.content || []) {
      if (block.type === 'text') current.text += block.text
      if (block.type === 'tool_use') current.calls.push({ id: block.id, name: block.name, input: block.input, messageId: message.message.id })
    }
    if (message.type === 'user') for (const block of message.message?.content || []) {
      if (block.type === 'tool_result' && block.is_error) current.toolErrors.push(JSON.stringify(block.content))
    }
    if (message.type === 'result') { current.result = message; current.resolve() }
  })
}
async function turn(name, prompt, verify) {
  let resolve, reject
  const done = new Promise((yes, no) => { resolve = yes; reject = no })
  current = { name, text: '', textDeltas: 0, thinkingDeltas: 0, calls: [], toolErrors: [], streamErrors: [], blocks: new Set(), resolve, reject }
  const timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 180000)
  try {
    await agent.sendMessage(prompt)
    await done
    assert.equal(current.result.is_error, false, JSON.stringify(current.result))
    assert.equal(current.result.subtype, 'success')
    assert.ok(current.textDeltas > 0, `${name}: answer did not stream (#1186)`)
    assert.deepEqual(current.streamErrors, [])
    assert.deepEqual(current.toolErrors, [])
    verify(current)
    cases.push(current)
    console.log('LIVE_CASE_PASSED', JSON.stringify({ name, textDeltas: current.textDeltas, thinkingDeltas: current.thinkingDeltas, tools: current.calls.map(c => c.name), text: current.text }))
  } finally { clearTimeout(timer) }
}
function parallel(record, name) {
  const groups = new Map()
  for (const call of record.calls.filter(c => c.name === name)) groups.set(call.messageId, (groups.get(call.messageId) || 0) + 1)
  assert.ok([...groups.values()].some(count => count >= 3), `No model response contained three parallel ${name} calls`)
  assert.equal(new Set(record.calls.map(c => c.id)).size, record.calls.length)
}
async function main() {
  fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(output, { recursive: true })
  await new Promise(resolve => bridge.listen(3030, '127.0.0.1', resolve))
  markers.forEach((marker, i) => fs.writeFileSync(`${work}/${i}.txt`, marker))
  await sharp(Buffer.from('<svg width="640" height="240"><rect width="640" height="240" fill="white"/><text x="30" y="60" font-size="42" fill="black">COPPER</text><circle cx="80" cy="150" r="35" fill="blue"/><circle cx="180" cy="150" r="35" fill="blue"/><polygon points="280,110 240,185 320,185" fill="red"/><rect x="380" y="110" width="70" height="70" fill="green"/></svg>')).png().toFile(`${work}/fixture.png`)
  // Direct user image, through the same production loopback proxy.
  const handle = await startLlmProxy({ llmProviderId: runtime.llmProviderId, config: runtime.proxy })
  let directImage
  try {
    const client = new Anthropic({ baseURL: handle.env.ANTHROPIC_BASE_URL, apiKey: handle.env.ANTHROPIC_API_KEY, maxRetries: 0 })
    let textDeltas = 0
    const result = await client.messages.stream({ model: runtime.model, max_tokens: 4096, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: [
      { type: 'text', text: 'Read the word and describe the shapes and colors. Include the count of blue circles.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fs.readFileSync(`${work}/fixture.png`).toString('base64') } },
    ] }] }).on('text', () => textDeltas++).finalMessage()
    const text = result.content.filter(b => b.type === 'text').map(b => b.text).join('')
    assert.match(text, /COPPER/i); assert.match(text, /(?:two|2).*blue|blue.*(?:two|2)/i); assert.match(text, /red/i); assert.match(text, /green/i)
    assert.ok(textDeltas > 0); directImage = { text, textDeltas }; console.log('DIRECT_IMAGE_PASSED', text)
  } finally { await handle.close() }
  const options = { sessionId: randomUUID(), workingDirectory: work, llmRuntime: runtime, model: runtime.model, effort: 'low', maxTurns: 20,
    webFetchProvider: 'local-http-fixture', capabilityPolicies: { subagents: 'block', workflows: 'block' } }
  agent = new ClaudeCodeProcess(options); attach(agent); await agent.start()
  try {
    await turn('text-and-memory', 'Calculate 17 times 23. Remember the result and the marker MOSS-417 for later.', r => assert.match(r.text, /391/))
    await turn('bash-read-edit', `Use Bash to write the exact bytes alpha to ${work}/proof.txt. Read it with Read, replace alpha with omega using Edit, then use Bash to compute its SHA-256.`, r => {
      for (const name of ['Bash', 'Read', 'Edit']) assert.ok(r.calls.some(c => c.name === name), `Missing ${name}`)
      assert.equal(fs.readFileSync(`${work}/proof.txt`, 'utf8'), 'omega')
      assert.ok(r.text.includes(createHash('sha256').update('omega').digest('hex')))
    })
    await turn('parallel-read', `Read ${work}/0.txt, ${work}/1.txt and ${work}/2.txt. Issue three separate Read tool calls in parallel in a single response, one per file. Report all three markers.`, r => { parallel(r, 'Read'); markers.forEach(m => assert.ok(r.text.includes(m))) })
    await turn('parallel-mcp-fetch', 'Use ToolSearch to load mcp__web__web_fetch. Fetch http://127.0.0.1:3030/page/0, http://127.0.0.1:3030/page/1 and http://127.0.0.1:3030/page/2 with three separate mcp__web__web_fetch calls in parallel in one response, maxChars 3000 each. Report each marker. Do not use Bash, Read, or the browser.', r => {
      assert.ok(r.calls.some(c => c.name === 'ToolSearch')); parallel(r, 'mcp__web__web_fetch'); markers.forEach(m => assert.ok(r.text.includes(m))); assert.equal(fetchedPages.length, 3)
    })
    await turn('tool-result-image', `Use Read on ${work}/fixture.png. Report the word, the number and color of circles, and the other shapes and colors.`, r => { assert.ok(r.calls.some(c => c.name === 'Read')); assert.match(r.text, /COPPER/i); assert.match(r.text, /blue/i); assert.match(r.text, /red/i); assert.match(r.text, /green/i) })
    await turn('browser-screenshot', 'Use ToolSearch to load mcp__browser__browser_open and mcp__browser__browser_get_state. Open http://127.0.0.1:3030/page/0 with browser_open, then request browser_get_state with screenshot true. Tell me the visible marker. Do not use Bash.', r => {
      assert.ok(r.calls.some(c => c.name === 'mcp__browser__browser_open')); assert.ok(r.calls.some(c => c.name === 'mcp__browser__browser_get_state' && c.input.screenshot === true)); assert.ok(r.text.includes(markers[0]))
    })
    await turn('hosted-web-search', 'Use the native WebSearch tool to find the official Python asyncio.TaskGroup documentation. State its URL and the Python version that introduced TaskGroup. Do not use Bash or the browser.', r => { assert.ok(r.calls.some(c => c.name === 'WebSearch')); assert.match(r.text, /docs\.python\.org/); assert.match(r.text, /3\.11/) })
    await turn('continuation', 'What number did I first ask you to calculate? Add nine to it and repeat the marker I asked you to remember.', r => { assert.match(r.text, /400/); assert.match(r.text, /MOSS-417/) })
    await agent.dispose()
    agent = new ClaudeCodeProcess({ ...options, sessionId, claudeSessionId: sessionId }); attach(agent); await agent.start()
    await turn('resume', 'After resuming this session, repeat the marker I asked you to remember and the original multiplication result.', r => { assert.match(r.text, /MOSS-417/); assert.match(r.text, /391/) })
    assert.ok(upstream.responses > 0); assert.equal(upstream.messages, 0); assert.ok(upstream.images >= 3); assert.ok(upstream.toolResults > 0)
    const sdkVersion = packageMetadata.parse(JSON.parse(fs.readFileSync('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8'))).version
    const report = reportSchema.parse({ sessionId, sdkVersion, cases, directImage, upstream, fetchedPages })
    fs.writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 })
    console.log('LIVE_SUITE_PASSED', JSON.stringify({ sessionId, sdkVersion, cases: cases.length, upstream }))
  } finally { await agent.dispose(); bridge.close() }
}
main().then(() => process.exit(0)).catch(error => { console.error('LIVE_SUITE_FAILED', error.stack); process.exit(1) })
