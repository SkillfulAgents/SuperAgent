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

/** What an opened volume's S3 traffic uses: where it lives and its keys. Volumes with the same
 * `cacheKey` may share cached views. */
export interface S3Access {
  location: S3Location
  cacheKey: string
  /** The SDK refreshes keys that carry an expiration a few minutes before it. */
  credentials: () => Promise<S3Credentials & { expiration?: Date }>
  /** How far this machine's clock runs ahead of the keys' issuer; requests are signed in its time. */
  clockOffsetMs?: number
  /** Throws when access was withdrawn since the volume opened. Checked again before a change is published. */
  recheck: () => void | Promise<void>
}

/** A user's own keys, sealed with the volume. Opening it proves they still unlock. */
export function sealedS3Access(config: S3VolumeConfig): S3Access {
  openS3Credentials(config)
  return {
    location: config,
    cacheKey: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    credentials: async () => openS3Credentials(config),
    recheck: () => { openS3Credentials(config) },
  }
}

/** Keys the source could not give inside an SDK call. They are not an S3 answer, so the pacer
 * neither retries them nor cools the bucket down for them. */
class KeysUnavailable extends Error {
  constructor(readonly reason: unknown) { super('S3 keys unavailable') }
}

/** SDK signs requests; explicit credentials prevent falling back to host AWS credentials.
 * One attempt in the SDK: our pacer retries safe reads and explicit throttles only. */
export class S3VolumeClient {
  readonly host: string
  readonly namespace: string
  readonly cacheKey: string
  private readonly client: S3Client
  constructor(access: S3Access) {
    const { location } = access
    try { this.host = new URL(location.endpoint || `https://s3.${location.region}.amazonaws.com`).host } catch { throw new VolumeError('Invalid S3 endpoint.', 400) }
    this.namespace = s3Namespace(location)
    this.cacheKey = access.cacheKey
    this.client = new S3Client({
      region: location.region, endpoint: location.endpoint || undefined, forcePathStyle: location.forcePathStyle,
      credentials: async () => { try { return await access.credentials() } catch (error) { throw new KeysUnavailable(error) } },
      systemClockOffset: -(access.clockOffsetMs ?? 0), maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: transport,
    })
  }

  async send<I extends ServiceInputTypes, O extends ServiceOutputTypes>(command: Command<ServiceInputTypes, I, ServiceOutputTypes, O, S3Client['config']>, options: { read?: boolean; signal?: AbortSignal } = {}): Promise<O> {
    try {
      return await pacer.run(this.namespace, options.read ?? false, async () => {
        throwIfUploadAborted(options.signal)
        try {
          return await this.client.send(command, { abortSignal: options.signal } satisfies HttpHandlerOptions)
        } catch (error) {
          if (error instanceof KeysUnavailable) throw error
          throwIfUploadAborted(options.signal)
          throw s3Error(error)
        }
      }, options.signal)
    } catch (error) {
      throw error instanceof KeysUnavailable ? error.reason : error
    }
  }
}
