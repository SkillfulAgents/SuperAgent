import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { fetchPlatformJson } from '@shared/lib/platform-auth/platform-fetch'
import { PlatformBillingInfoSchema, type ParsedPlatformBillingInfo } from '@shared/lib/types/skillset-schema'

/**
 * Fetch the billing snapshot for the connected account from the platform proxy.
 *
 * The token is a fallback for callers outside a request scope (e.g. the
 * boot-time PlatformService). Inside a request scope the installed platform
 * fetch interceptor overrides it with the attributed bearer (`token::memberId`),
 * so the per-member seat balance resolves correctly in auth_mode too.
 *
 * Throws {@link PlatformRequestError} on failure (401/403 = unavailable for this
 * account; 5xx = transient).
 */
export async function fetchPlatformBillingInfo(): Promise<ParsedPlatformBillingInfo> {
  return fetchPlatformJson({
    path: '/v1/billing',
    token: getPlatformAccessToken(),
    schema: PlatformBillingInfoSchema,
    area: 'platform-billing',
    notConnectedMessage: 'Platform is not connected.',
    mapStatusError: (status) =>
      status === 401 || status === 403
        ? { message: 'Billing is unavailable for this account.', status }
        : { message: 'Could not load billing right now. Please try again.', status: 502 },
  })
}
