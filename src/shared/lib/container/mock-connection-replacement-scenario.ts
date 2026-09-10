/** Opt-in recording fixture. Only loaded by the E2E mock runtime with the
 * dedicated demo flag. The model and credential provider are simulated; the
 * script, host proxy, authorization, replacement route and interrupt are real. */
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import path from 'path'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { agentConnectedAccounts } from '../db/schema'
import { getOrCreateProxyToken } from '../proxy/token-store'
import { getAgentWorkspaceDir } from '../utils/file-storage'
import { ComposioAccountProvider } from '../account-providers/composio-account-provider'
import { registerAccountProvider } from '../account-providers/provider-factory'
import { MockContainerClient, SimpleTextResponseScenario, type MockScenario } from './mock-container-client'

const runFile = promisify(execFile)

class DemoAccountProvider extends ComposioAccountProvider {
  override async getConnection(connectionId: string) {
    return { id: connectionId, status: connectionId.endsWith('-expired') ? 'EXPIRED' as const : 'ACTIVE' as const }
  }

  override async makeApiCall(params: Parameters<ComposioAccountProvider['makeApiCall']>[0]): Promise<Response> {
    if (!params.providerConnectionId.startsWith('demo-slack-') || params.toolkitSlug !== 'slack') {
      throw new Error('The recording provider only accepts its seeded demo accounts')
    }
    const upstream = URL.parse(process.env.E2E_DEMO_SLACK_URL!)
    if (!upstream || upstream.hostname !== '127.0.0.1') throw new Error('Demo upstream must be loopback')
    upstream.pathname = '/api/conversations.list'
    return fetch(upstream, {
      headers: { 'X-Demo-Connection-Id': params.providerConnectionId },
    })
  }
}

class ConnectionReplacementScenario implements MockScenario {
  execute(sessionId: string, client: MockContainerClient, message: string): void {
    void this.run(sessionId, client, message).catch((error: unknown) => {
      new SimpleTextResponseScenario(`Demo failed: ${String(error)}`).execute(sessionId, client, message)
    })
  }

  private async run(sessionId: string, client: MockContainerClient, message: string): Promise<void> {
    const agentSlug = client.getAgentId()
    const scriptPath = path.join(getAgentWorkspaceDir(agentSlug), 'scripts', 'list-slack-channels.mjs')
    const replacementId = message.match(/New account ID: ([\w-]+)\./)?.[1]
    let accountId: string
    if (replacementId) {
      const previousId = message.match(/Previous account ID: ([\w-]+)\./)?.[1]
      const script = await fs.readFile(scriptPath, 'utf8')
      if (!previousId || !script.includes(previousId)) throw new Error('Script does not contain the old ID')
      // The simulated agent consumes the REAL system message and actually edits
      // and executes its script. It does not read the new mapping from the DB.
      await fs.writeFile(scriptPath, script.replaceAll(previousId, replacementId))
      accountId = replacementId
    } else {
      registerAccountProvider(new DemoAccountProvider())
      const mapping = db.select().from(agentConnectedAccounts)
        .where(eq(agentConnectedAccounts.agentSlug, agentSlug)).get()
      if (!mapping) throw new Error('No shared account assigned')
      accountId = mapping.connectedAccountId
      await fs.mkdir(path.dirname(scriptPath), { recursive: true })
      await fs.writeFile(scriptPath, [
        `const accountId = ${JSON.stringify(accountId)}`,
        `const url = new URL('/api/proxy/${agentSlug}/' + accountId + '/slack.com/api/conversations.list', process.env.DEMO_HOST_URL)`,
        `const response = await fetch(url, { headers: { Authorization: 'Bearer ' + process.env.DEMO_PROXY_TOKEN } })`,
        `console.log(JSON.stringify({ status: response.status, body: await response.json() }))`,
      ].join('\n'))
      client.writeJsonlEntry(sessionId, {
        type: 'user', message: { content: message }, timestamp: new Date().toISOString(),
      })
      const content = [{ type: 'text', text: 'I’m running `scripts/list-slack-channels.mjs` with the shared Slack connection.' }]
      client.writeJsonlEntry(sessionId, {
        type: 'assistant', message: { content }, timestamp: new Date().toISOString(),
      })
      client.emitStreamMessage(sessionId, {
        type: 'assistant', content: { type: 'assistant', message: { content } },
      })
    }
    const { stdout } = await runFile(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        DEMO_HOST_URL: `http://127.0.0.1:${process.env.PORT}`,
        DEMO_PROXY_TOKEN: await getOrCreateProxyToken(agentSlug),
      },
      timeout: 90_000,
    })
    // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- execute() catches parsing and execution failures and emits the demo failure
    const result = JSON.parse(stdout) as { status: number; body: { channels?: Array<{ name: string }>; error?: string } }
    if (!replacementId) {
      // Replacement interrupts this turn before releasing the parked 409.
      // Its epoch-pinned client suppresses stale emissions after that interrupt.
      if (result.status !== 409 || result.body.error !== 'account_replaced') {
        throw new Error(`Expected replaced response, got ${stdout}`)
      }
      return
    }
    if (result.status !== 200 || !result.body.channels?.length) throw new Error(`Slack request failed: ${stdout}`)
    const response = [
      'The replacement system message reached this session. I updated `scripts/list-slack-channels.mjs` to use the new account ID:',
      `\n\n\`${accountId}\``,
      '\n\nThe script ran successfully against the mock Slack API. Channels:',
      ...result.body.channels.map((channel) => `\n- #${channel.name}`),
    ].join('')
    new SimpleTextResponseScenario(response).execute(sessionId, client, message)
  }
}

export function registerConnectionReplacementDemo(): void {
  const scenario = new ConnectionReplacementScenario()
  MockContainerClient.registerScenario('list the slack channels using the shared connection', scenario)
  MockContainerClient.registerScenario('[SYSTEM] Connection to "Slack" was replaced.', scenario)
}
