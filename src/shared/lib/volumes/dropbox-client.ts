import { getAccountProviderByName } from '@shared/lib/account-providers/provider-factory'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { writeProxyAuditEntry } from '@shared/lib/proxy/audit'
import { dropboxErrorSchema } from './dropbox-schema'
import { DropboxUnavailableError } from './dropbox-error'
import { requireAccount, withRemoteAccount, withRemoteAttribution } from './remote-account'
import { RemoteRequestPacer, retryAfterSeconds } from './remote-request-pacer'

export type DropboxEndpoint =
  | 'get_metadata' | 'list_folder' | 'list_folder/continue' | 'download'
  | 'upload' | 'upload_session/start' | 'upload_session/append_v2' | 'upload_session/finish'
  | 'create_folder_v2' | 'delete_v2' | 'move_v2'

export function requireDropboxAccount(accountId: string, creator?: { userId: string | null }) {
  return requireAccount(accountId, 'dropbox', creator)
}

export function withDropboxAccount<T>(accountId: string, operation: (account: Awaited<ReturnType<typeof requireDropboxAccount>>) => Promise<T>, refresh = false): Promise<T> {
  return withRemoteAccount(accountId, 'dropbox', operation, refresh)
}

const pacer = new RemoteRequestPacer((status, delay) => new DropboxUnavailableError(status, delay))
const READS = new Set<DropboxEndpoint>(['get_metadata', 'list_folder', 'list_folder/continue', 'download'])

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
    return new DropboxUnavailableError(429, retryAfterSeconds(response, parsed.success ? parsed.data.error?.retry_after : undefined))
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
    return await withRemoteAttribution(accountId, 'dropbox', account => pacer.run(accountId, READS.has(endpoint), async () => {
      let response: Response
      try {
        response = await getAccountProviderByName(account.providerName).makeApiCall({
          providerConnectionId: account.providerConnectionId, toolkitSlug: 'dropbox',
          targetUrl: `https://${targetHost}/${targetPath}`, method: 'POST', headers, body,
        })
      } catch { throw new DropboxUnavailableError() }
      statusCode = response.status
      if (!response.ok) throw await responseError(response)
      return response
    }))
  } finally {
    if (options.agentSlug && AUDITED.has(endpoint)) await writeProxyAuditEntry({
      agentSlug: options.agentSlug, accountId, toolkit: 'dropbox', targetHost, targetPath, method: 'POST',
      statusCode, durationMs: Date.now() - start, policyDecision: 'allow',
      ...(statusCode === undefined || statusCode >= 400 ? { errorMessage: statusCode ? `Upstream returned ${statusCode}` : 'Dropbox volume request failed' } : {}),
    }, { analytics: false })
  }
}
