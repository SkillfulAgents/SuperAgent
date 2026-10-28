import { z } from 'zod'
import { EmailGatewayClient } from './gateway-client'

const domainSetupSchema = z.object({ emailDomain: z.string().min(1) })

/** Read-only: the gateway resolves the authenticated organization's domain. */
export async function describeEmailSetup(ownerUserId: string | null) {
  return new EmailGatewayClient(ownerUserId).json('/domain/setup', domainSetupSchema)
}
