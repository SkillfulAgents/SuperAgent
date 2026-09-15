/**
 * The one Modal client of this process, and the app every sandbox and volume
 * of this deployment belongs to.
 *
 * Credentials come from `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` or the active
 * profile in `~/.modal.toml`, the way the Modal CLI reads them. The app is
 * `superagent` unless `SUPERAGENT_MODAL_APP` says otherwise; one deployment
 * per app, so two deployments sharing a Modal workspace do not see each
 * other's sandboxes by name.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ModalClient, type App } from 'modal'

export function isModalConfigured(): boolean {
  if (process.env.MODAL_TOKEN_ID?.trim() && process.env.MODAL_TOKEN_SECRET?.trim()) return true
  const configPath = process.env.MODAL_CONFIG_PATH?.trim() || path.join(os.homedir(), '.modal.toml')
  return fs.existsSync(configPath)
}

export function modalAppName(): string {
  return process.env.SUPERAGENT_MODAL_APP?.trim() || 'superagent'
}

let client: ModalClient | null = null
let app: Promise<App> | null = null

export function getModalClient(): ModalClient {
  client ??= new ModalClient()
  return client
}

/** The Modal environment objects are created in: the profile's default unless `MODAL_ENVIRONMENT` is set. */
export function modalEnvironmentName(): string {
  return getModalClient().environmentName()
}

export function getModalApp(): Promise<App> {
  app ??= getModalClient()
    .apps.fromName(modalAppName(), { createIfMissing: true })
    .catch((error: unknown) => {
      app = null
      throw error
    })
  return app
}

/** The gRPC control plane, for the volume file RPCs the SDK does not wrap. */
export function modalControlPlane(): ModalClient['cpClient'] {
  return getModalClient().cpClient
}

// gRPC status codes the volume RPCs answer with. nice-grpc's ClientError
// carries them as `code`; duck-typed so this module does not import nice-grpc.
export const GRPC_INVALID_ARGUMENT = 3
export const GRPC_NOT_FOUND = 5
export const GRPC_ALREADY_EXISTS = 6
export const GRPC_FAILED_PRECONDITION = 9

export function grpcStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' ? code : undefined
}

/** The server's own message for a gRPC error, without the method prefix nice-grpc adds. */
export function grpcDetails(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const details = (error as { details?: unknown }).details
    if (typeof details === 'string' && details) return details
  }
  return error instanceof Error ? error.message : String(error)
}
