import { CompactEncrypt, importJWK } from 'jose'
import { z } from 'zod'
import { teamsIdentitySchema } from './config-schema'
import { IntegrationSetupError } from '../agent-integrations/setup-types'

const coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const gatewayPublicKey = z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: coordinate, y: coordinate })
export const gatewayPrivateKey = gatewayPublicKey.extend({ d: coordinate })
export const gatewayRoute = teamsIdentitySchema.extend({ relayUrl: z.string().url().max(512), secret: z.string().regex(/^[0-9a-f]{64}$/) })

/** Encrypt binding material on the private host; only the gateway operator can open it. */
export async function createTeamsGatewayEndpoint(gatewayBaseUrl: string, route: z.infer<typeof gatewayRoute>): Promise<string> {
  const base = URL.parse(gatewayBaseUrl)
  if (!base || base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new IntegrationSetupError('The configured Microsoft Teams relay gateway needs an HTTPS URL.')
  }
  const root = base.href.replace(/\/+$/, '')
  const binding = gatewayRoute.parse(route)
  try {
    const response = await fetch(`${root}/key`, { redirect: 'error', signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error('Gateway key unavailable')
    const jwk = gatewayPublicKey.parse(await response.json())
    const key = await importJWK(jwk, 'ECDH-ES')
    const token = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify(binding)))
      .setProtectedHeader({ alg: 'ECDH-ES', enc: 'A256GCM' }).encrypt(key)
    return `${root}/messages/${token}`
  } catch {
    throw new IntegrationSetupError('Could not obtain the Microsoft Teams relay gateway key. Check TEAMS_RELAY_GATEWAY_URL on this Gamut host.')
  }
}
