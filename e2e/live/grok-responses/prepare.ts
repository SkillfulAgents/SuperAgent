import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { openDatabase, closeDatabase } from '../../../src/shared/lib/db'
import { getConnection, providerForConnection } from '../../../src/shared/lib/llm-provider/connections'
import { connectionRuntimeSchema } from '../../../agent-container/src/connection-runtime'

/** Export access-only test runtime using the app's normal refresh authority. */
async function main() {
  const { values } = parseArgs({ options: {
    connection: { type: 'string' }, out: { type: 'string' }, model: { type: 'string', default: 'grok-4.7' },
  } })
  if (!values.connection || !values.out) throw new Error('Supply --connection <id> --out <private runtime.json>')
  await openDatabase()
  try {
    const row = await getConnection(values.connection)
    if (!row || row.provider !== 'grok-subscription') throw new Error('Choose a Grok Subscription connection')
    const provider = providerForConnection(row)
    const proxy = await provider.getContainerProxyConfig()
    if (!proxy || proxy.format !== 'responses') throw new Error('Expected a Responses proxy')
    const model = values.model
    const runtime = connectionRuntimeSchema.parse({
      llmProviderId: row.id, generation: proxy.credential.generation, provider: row.provider,
      model, browserModel: model, dashboardBuilderModel: model, modelPromptHints: [], subagentModels: [],
      modelContextWindows: { [model]: 500000 }, env: { ENABLE_TOOL_SEARCH: 'true' }, proxy,
    })
    await fs.mkdir(path.dirname(values.out), { recursive: true, mode: 0o700 })
    await fs.writeFile(values.out, JSON.stringify(runtime), { mode: 0o600, flag: 'wx' })
    let textDeltas = 0
    const result = await provider.createClient().withOptions({ maxRetries: 0 }).messages.stream({
      model, max_tokens: 2048, thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'What is 17 times 23? Answer with the number.' }],
    }).on('text', () => { textDeltas++ }).finalMessage()
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    if (!text.includes('391') || !textDeltas) throw new Error('Host helper did not stream the expected answer')
    console.log(JSON.stringify({ hostHelperPassed: true, textDeltas, format: proxy.format, model }))
  } finally { await closeDatabase() }
}
void main().catch(() => {
  console.error('Grok preparation failed. Check the connection, writable output path, and provider availability.')
  process.exitCode = 1
})
