import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import {
  fetchPlatformJson,
  platformErrorMessage,
  PlatformRequestError,
} from '@shared/lib/platform-auth/platform-fetch'
import { PlatformBillingInfoSchema, type ParsedPlatformBillingInfo } from '@shared/lib/types/skillset-schema'
import {
  PlatformAutoReloadRequestSchema,
  PlatformAutoReloadResponseSchema,
  PlatformPaymentMethodConfirmRequestSchema,
  PlatformPaymentMethodConfirmResponseSchema,
  PlatformPaymentMethodSetupSchema,
  PlatformTopupRequestSchema,
  PlatformTopupResponseSchema,
  type PlatformAutoReloadRequest,
  type PlatformAutoReloadResponse,
  type PlatformPaymentMethodConfirmResponse,
  type PlatformPaymentMethodSetup,
  type PlatformTopupResponse,
} from './platform-billing-schema'

function billingMutationError(status: number, body: unknown, fallback: string): { message: string; status: number } {
  if (status === 401 || status === 403) {
    return { message: platformErrorMessage(body) ?? 'Billing is unavailable for this account.', status }
  }
  if (status === 400 || status === 402 || status === 409) {
    return { message: platformErrorMessage(body) ?? fallback, status }
  }
  return { message: platformErrorMessage(body) ?? fallback, status: status === 503 ? 503 : 502 }
}

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

export async function postPlatformTopup(amountCents: number): Promise<PlatformTopupResponse> {
  const body = PlatformTopupRequestSchema.parse({ amountCents })
  return fetchPlatformJson({
    path: '/v1/billing/topup',
    method: 'POST',
    token: getPlatformAccessToken(),
    schema: PlatformTopupResponseSchema,
    area: 'platform-billing',
    body,
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    notConnectedMessage: 'Platform is not connected.',
    mapStatusError: (status, errorBody) =>
      billingMutationError(status, errorBody, 'Could not complete the top-up. Please try again.'),
  })
}

export async function startPlatformPaymentMethodSetup(): Promise<PlatformPaymentMethodSetup> {
  return fetchPlatformJson({
    path: '/v1/billing/payment-method/setup',
    method: 'POST',
    token: getPlatformAccessToken(),
    schema: PlatformPaymentMethodSetupSchema,
    area: 'platform-billing',
    body: {},
    notConnectedMessage: 'Platform is not connected.',
    mapStatusError: (status, errorBody) =>
      billingMutationError(status, errorBody, 'Could not start card setup. Please try again.'),
  })
}

export async function confirmPlatformPaymentMethod(
  paymentMethodId: string,
): Promise<PlatformPaymentMethodConfirmResponse> {
  const body = PlatformPaymentMethodConfirmRequestSchema.parse({ paymentMethodId })
  return fetchPlatformJson({
    path: '/v1/billing/payment-method',
    method: 'POST',
    token: getPlatformAccessToken(),
    schema: PlatformPaymentMethodConfirmResponseSchema,
    area: 'platform-billing',
    body,
    notConnectedMessage: 'Platform is not connected.',
    mapStatusError: (status, errorBody) =>
      billingMutationError(status, errorBody, 'Could not save this card. Please try again.'),
  })
}

export async function postPlatformAutoReload(
  input: PlatformAutoReloadRequest,
): Promise<PlatformAutoReloadResponse> {
  const body = PlatformAutoReloadRequestSchema.parse(input)
  return fetchPlatformJson({
    path: '/v1/billing/auto-reload',
    method: 'POST',
    token: getPlatformAccessToken(),
    schema: PlatformAutoReloadResponseSchema,
    area: 'platform-billing',
    body,
    notConnectedMessage: 'Platform is not connected.',
    mapStatusError: (status, errorBody) =>
      billingMutationError(status, errorBody, 'Could not save auto-refill. Please try again.'),
  })
}

export { PlatformRequestError }
