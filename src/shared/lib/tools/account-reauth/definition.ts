import type { RequestDefinition } from '../requests/definition'

export const accountReauthRequestDef = {
  kind: 'account_reauth_required',
  getNotification: () => null,
} satisfies RequestDefinition
