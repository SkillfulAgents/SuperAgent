import { createHash } from 'node:crypto'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { Agent as HttpsAgent } from 'node:https'
import { Agent as HttpAgent } from 'node:http'
import { S3Client, type ServiceInputTypes, type ServiceOutputTypes } from '@aws-sdk/client-s3'
import type { Command, HttpHandlerOptions } from '@smithy/types'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { openS3Credentials } from './s3-credentials'
import type { S3Credentials, S3Location, S3VolumeConfig } from './s3-schema'
import { VolumeError } from './volume-error'
import { RemoteRequestPacer } from './remote-request-pacer'
import { throwIfUploadAborted } from './remote-transfer'

// Request-scoped adapters share sockets, not credentials. Keep idle sockets bounded.
const transport = new NodeHttpHandler({ connectionTimeout: 5_000, socketTimeout: 60_000,
  httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8 }),
  httpAgent: new HttpAgent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8 }),
})
const pacer = new RemoteRequestPacer((status, delay) => new VolumeError('S3 is busy or temporarily unavailable. Please try again.', status, delay))

/** Never surface an SDK error verbatim: providers may echo signed URLs and key IDs. */
export function s3Error(error: unknown): Error {
  if (error instanceof VolumeError || error instanceof WorkspaceFileError) return error
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number }; $response?: { headers?: Record<string, string> } }
  const code = value?.name
  const status = value?.$metadata?.httpStatusCode
  if (code === 'NoSuchBucket') return new VolumeError('Bucket not found. Check the bucket name and endpoint.', 400)
  if (['NoSuchKey', 'NotFound'].includes(code ?? '') || status === 404) return new WorkspaceFileError('not-found')
  if (['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'InvalidToken', 'ExpiredToken'].includes(code ?? '')) {
    return new WorkspaceFileError('not-accessible', 'S3 could not authenticate this key. Check the access key ID, secret, region, and any session token.')
  }
  if (status === 401 || status === 403 || code === 'AccessDenied') return new WorkspaceFileError('not-accessible', 'S3 denied this operation. Check the key’s bucket and object permissions.')
  if (status === 412 || code === 'PreconditionFailed' || code === 'ConditionalRequestConflict') return new VolumeError('This object changed while the operation was in progress. Refresh and try again.', 409)
  if (status === 429 || code === 'SlowDown' || code === 'Throttling') {
    const raw = value.$response?.headers?.['retry-after']
    const seconds = raw ? Number(raw) || Math.max(0, (Date.parse(raw) - Date.now()) / 1000) : undefined
    return new VolumeError('S3 is rate limiting requests. Please try again shortly.', 429, seconds && Number.isFinite(seconds) ? Math.ceil(seconds) : undefined)
  }
  if (['PermanentRedirect', 'AuthorizationHeaderMalformed', 'IncorrectEndpoint', 'IllegalLocationConstraintException'].includes(code ?? '')) return new VolumeError('The endpoint or region does not match this bucket. Check the provider’s S3 connection details.', 400)
  if (code === 'NotImplemented' || status === 501) return new VolumeError('This S3 provider does not support a required operation.', 400)
  return new VolumeError('Could not reach the S3 bucket. Check the endpoint and network, then try again.', 503)
}

export function s3Namespace(config: S3Location): string {
  try { return JSON.stringify([new URL(config.endpoint || `https://s3.${config.region}.amazonaws.com`).origin, config.bucket]) }
  catch { throw new VolumeError('Invalid S3 endpoint.', 400) }
}

/** Where a volume's keys come from. Volumes with the same `cacheKey` may share cached views. */
export interface S3KeySource {
  cacheKey: string
  /** The SDK refreshes keys that carry an expiration a few minutes before it. */
  credentials: () => Promise<S3Credentials & { expiration?: Date }>
  /** Throws when the keys cannot be used, before any request or cached answer. */
  authorize: () => void | Promise<void>
}

/** A user's own keys, sealed with the volume. */
export function sealedS3Keys(config: S3VolumeConfig): S3KeySource {
  return {
    cacheKey: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    credentials: async () => openS3Credentials(config),
    authorize: () => { openS3Credentials(config) },
  }
}

/** SDK signs requests; explicit credentials prevent falling back to host AWS credentials.
 * One attempt in the SDK: our pacer retries safe reads and explicit throttles only. */
export class S3VolumeClient {
  readonly host: string
  readonly namespace: string
  readonly cacheKey: string
  private readonly client: S3Client
  constructor(readonly config: S3Location, private readonly keys: S3KeySource) {
    try { this.host = new URL(config.endpoint || `https://s3.${config.region}.amazonaws.com`).host } catch { throw new VolumeError('Invalid S3 endpoint.', 400) }
    this.namespace = s3Namespace(config)
    this.cacheKey = keys.cacheKey
    this.client = new S3Client({
      region: config.region, endpoint: config.endpoint || undefined, forcePathStyle: config.forcePathStyle,
      credentials: keys.credentials, maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: transport,
    })
  }

  async authorize(): Promise<void> { await this.keys.authorize() }

  async send<I extends ServiceInputTypes, O extends ServiceOutputTypes>(command: Command<ServiceInputTypes, I, ServiceOutputTypes, O, S3Client['config']>, options: { read?: boolean; signal?: AbortSignal } = {}): Promise<O> {
    await this.authorize()
    return pacer.run(this.namespace, options.read ?? false, async () => {
      throwIfUploadAborted(options.signal)
      try {
        return await this.client.send(command, { abortSignal: options.signal } satisfies HttpHandlerOptions)
      } catch (error) {
        throwIfUploadAborted(options.signal)
        throw s3Error(error)
      }
    }, options.signal)
  }
}
