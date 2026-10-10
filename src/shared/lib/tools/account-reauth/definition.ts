import type { RequestDefinition } from '../requests/definition'

export const accountReauthRequestDef = {
  kind: 'account_reauth_required',
  describeVoice: (request) => `The agent needs the user to reconnect a ${request.toolkit} account in the application.`,
  getNotification: () => null,
} satisfies RequestDefinition<'account_reauth_required'>
