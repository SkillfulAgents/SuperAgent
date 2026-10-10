import { AsyncLocalStorage } from 'node:async_hooks'
import { eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { connectedAccounts } from '@shared/lib/db/schema'
import { getAccountProviderByName } from '@shared/lib/account-providers/provider-factory'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { attribution, runWithAttribution } from '@shared/lib/platform-attribution'
import { writeProxyAuditEntry } from '@shared/lib/proxy/audit'
import { dropboxErrorSchema } from './dropbox-schema'
import { DropboxUnavailableError } from './dropbox-error'

export type DropboxEndpoint =
  | 'get_metadata' | 'list_folder' | 'list_folder/continue' | 'download'
  | 'upload' | 'upload_session/start' | 'upload_session/append_v2' | 'upload_session/finish'
  | 'create_folder_v2' | 'delete_v2' | 'move_v2'

export async function requireDropboxAccount(accountId: string, creator?: { userId: string | null }) {
  const account = await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, accountId)).get()
  if (!account || account.toolkitSlug !== 'dropbox' || (creator?.userId && account.userId !== creator.userId)) {
    throw new WorkspaceFileError('not-found', 'Dropbox account not found')
  }
  if (account.status !== 'active') throw new WorkspaceFileError('not-accessible', 'Reconnect this Dropbox account in Connections')
  return account
}

type DropboxAccount = Awaited<ReturnType<typeof requireDropboxAccount>>
type Operation = { account: DropboxAccount; owner?: ReturnType<typeof attribution.fromResourceCreator> }
const operationAccount = new AsyncLocalStorage<Operation>()
const cooldowns = new Map<string, number>()
const RETRY_BUDGET_MS = 10_000
const MAX_ATTEMPTS = 4

/** One authorization lookup per filesystem operation, not per page/chunk. Never
 * retain account authorization between operations. Upload commits recheck it. */
export async function withDropboxAccount<T>(accountId: string, operation: (account: DropboxAccount) => Promise<T>): Promise<T> {
  const account = await requireDropboxAccount(accountId)
  return operationAccount.run({ account }, () => operation(account))
}

/** JSON in Dropbox headers must escape non-ASCII, including surrogate pairs. */
function headerJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

async function responseError(response: Response): Promise<Error> {
  const parsed = dropboxErrorSchema.safeParse(await response.json().catch(() => null))
  const tags = parsed.success ? (parsed.data.error_summary ?? '').split('/') : []
  if (parsed.success && parsed.data.error?.reason) tags.push(parsed.data.error.reason['.tag'])
  if (parsed.success && parsed.data.error?.['.tag']) tags.push(parsed.data.error['.tag'])
  if (response.status === 429 || tags.includes('too_many_write_operations') || tags.includes('too_many_requests')) {
    const header = response.headers.get('retry-after')
    const seconds = header === null ? NaN : Number(header)
    const date = header === null || Number.isFinite(seconds) ? NaN : Date.parse(header)
    const retryAfter = Number.isFinite(seconds) ? Math.max(0, seconds)
      : Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000)
        : parsed.success ? parsed.data.error?.retry_after : undefined
    return new DropboxUnavailableError(429, retryAfter)
  }
  if (tags.includes('not_found')) return new WorkspaceFileError('not-found')
  if (tags.includes('not_file')) return new WorkspaceFileError('not-a-file')
  if (tags.includes('not_folder') || tags.includes('file_ancestor')) return new WorkspaceFileError('not-a-directory')
  if (tags.includes('conflict')) return new WorkspaceFileError('already-exists')
  if (tags.includes('malformed_path') || tags.includes('cant_move_folder_into_itself')) return new WorkspaceFileError('invalid-path')
  if ([401, 403].includes(response.status) || tags.includes('no_write_permission') || tags.includes('restricted_content')) {
    return new WorkspaceFileError('not-accessible', 'Dropbox access is unavailable. Check the account connection and folder permissions.')
  }
  return new DropboxUnavailableError()
}

function postpone(accountId: string, delay: number): void {
  for (const [id, until] of cooldowns) if (until <= Date.now()) cooldowns.delete(id)
  cooldowns.set(accountId, Math.max(cooldowns.get(accountId) ?? 0, Date.now() + delay))
}

/** Only published filesystem mutations belong in the agent audit trail. Staging
 * chunks and reads are implementation traffic, and never product analytics. */
const AUDITED = new Set<DropboxEndpoint>(['upload', 'upload_session/finish', 'create_folder_v2', 'delete_v2', 'move_v2'])

/** Only the volume driver calls this. The attachment grants access; API account
 * policies and agent-account mappings do not expand or restrict that grant.
 * No caller-supplied URL, credential, or policy-bypass flag reaches the proxy. */
export async function dropboxRequest(
  accountId: string, endpoint: DropboxEndpoint, args: unknown,
  options: { agentSlug?: string; bytes?: ArrayBuffer; range?: string } = {},
): Promise<Response> {
  const content = endpoint === 'download' || endpoint === 'upload' || endpoint.startsWith('upload_session/')
  const targetHost = content ? 'content.dropboxapi.com' : 'api.dropboxapi.com'
  const targetPath = `2/files/${endpoint}`
  const headers = new Headers(content ? { 'Dropbox-API-Arg': headerJson(args) } : { 'Content-Type': 'application/json' })
  if (endpoint === 'upload' || endpoint.startsWith('upload_session/')) headers.set('Content-Type', 'application/octet-stream')
  if (options.range) headers.set('Range', options.range)
  const body = content ? options.bytes ?? null : new TextEncoder().encode(JSON.stringify(args)).buffer
  const start = Date.now()
  let statusCode: number | undefined
  try {
    const scoped = operationAccount.getStore()
    const context: Operation = scoped?.account.id === accountId ? scoped : { account: await requireDropboxAccount(accountId) }
    const { account } = context
    const owner = await (context.owner ??= attribution.fromResourceCreator(account.userId))
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // A 429 throttles this account's other requests as well. Recheck after
      // waking in case another in-flight request extended the cooldown.
      while ((cooldowns.get(accountId) ?? 0) > Date.now()) {
        const delay = cooldowns.get(accountId)! - Date.now()
        if (Date.now() + delay - start > RETRY_BUDGET_MS) throw new DropboxUnavailableError(429, Math.ceil(delay / 1000))
        await new Promise(resolve => setTimeout(resolve, delay))
      }
      let response: Response
      try {
        response = await runWithAttribution(owner, () =>
          getAccountProviderByName(account.providerName).makeApiCall({
            providerConnectionId: account.providerConnectionId, toolkitSlug: 'dropbox',
            targetUrl: `https://${targetHost}/${targetPath}`, method: 'POST', headers, body,
          }))
      } catch {
        // A transport failure may have committed a mutation. Never replay it.
        throw new DropboxUnavailableError()
      }
      statusCode = response.status
      if (response.ok) return response
      const error = await responseError(response)
      if (!(error instanceof DropboxUnavailableError) || error.status !== 429) throw error
      // Only explicit rejections are replayable. Namespace contention commonly
      // says Retry-After: 0; still back off instead of spinning immediately.
      const delay = Math.max((error.retryAfter ?? 0) * 1000, 250 * 2 ** attempt)
      postpone(accountId, delay)
      if (attempt === MAX_ATTEMPTS - 1 || Date.now() + delay - start > RETRY_BUDGET_MS) {
        throw new DropboxUnavailableError(429, Math.ceil(delay / 1000))
      }
    }
    throw new DropboxUnavailableError()
  } finally {
    if (options.agentSlug && AUDITED.has(endpoint)) await writeProxyAuditEntry({
      agentSlug: options.agentSlug, accountId, toolkit: 'dropbox', targetHost, targetPath, method: 'POST',
      statusCode, durationMs: Date.now() - start, policyDecision: 'allow',
      ...(statusCode === undefined || statusCode >= 400 ? { errorMessage: statusCode ? `Upstream returned ${statusCode}` : 'Dropbox volume request failed' } : {}),
    }, { analytics: false })
  }
}
