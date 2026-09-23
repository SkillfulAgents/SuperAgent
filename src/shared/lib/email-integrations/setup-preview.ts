import { fetch as memberFetch } from 'undici'
import { z } from 'zod'
import { attribution } from '../platform-attribution'
import { getPlatformProxyBaseUrl } from '../platform-auth/config'
import { EmailGatewayClient, emailBearer, EmailGatewayError } from './gateway-client'

const domainResponseSchema = z.object({ domain: z.object({ name: z.string().min(1) }).nullable() })
const deploymentsSchema = z.array(z.object({ org_id: z.string(), deployment_url: z.string().url(), status: z.string() }))

/** Read-only: opening setup must never enroll a domain or reserve an inbox. */
export async function describeEmailSetup(ownerUserId: string | null) {
  const client = new EmailGatewayClient(ownerUserId)
  const existing = await client.json('/domain', domainResponseSchema)
  if (existing.domain) return { emailDomain: existing.domain.name }

  const identity = await client.json('/me', z.object({ orgId: z.string() }))
  const proxy = getPlatformProxyBaseUrl()
  if (!proxy) throw new EmailGatewayError(409, 'Platform discovery is not configured')
  let token = await emailBearer(ownerUserId)
  if (attribution.requiresActingMember()) {
    if (!ownerUserId) throw new EmailGatewayError(409, 'Sign in with Platform to preview the company email domain')
    try {
      const { getAuth } = await import('../auth')
      token = (await getAuth().api.getAccessToken({ body: { providerId: 'platform', userId: ownerUserId } })).accessToken
    } catch { throw new EmailGatewayError(409, 'Sign in with Platform again to preview the company email domain') }
  }
  // Discovery requires the member credential. The global fetch interceptor
  // replaces it with the deployment's org JWT, which this endpoint cannot use.
  const response = await memberFetch(`${proxy}/v1/me/deployments`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new EmailGatewayError(502, 'Could not look up the company email domain')
  const deployments = deploymentsSchema.parse(await response.json()).filter(item => item.org_id === identity.orgId && item.status === 'deployed')
  if (deployments.length !== 1) throw new EmailGatewayError(409, 'Organization must have exactly one deployed platform hostname')
  const deployment = URL.parse(deployments[0].deployment_url)
  // Match the gateway's enrollment rules for its ongamut.so mail root.
  if (!deployment || deployment.protocol !== 'https:' || !/^[a-z0-9-]+\.ongamut\.so$/.test(deployment.hostname)) {
    throw new EmailGatewayError(409, 'Company deployment does not have a supported email domain')
  }
  return { emailDomain: deployment.hostname }
}
