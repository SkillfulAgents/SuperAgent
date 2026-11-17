import { z } from 'zod'

/**
 * How a callback's `iss` is checked (RFC 9207). Not secret: a callback is
 * checked against it in every state of the flow, before anything is claimed.
 */
export const mcpOAuthIssuerCheckSchema = z.object({
  /** The authorization server metadata's `issuer`, compared verbatim with `iss`. */
  expected: z.string().min(1).optional(),
  /** The server said it sends `iss`, so a callback without one is refused. */
  required: z.boolean(),
})
export type McpOAuthIssuerCheck = z.infer<typeof mcpOAuthIssuerCheckSchema>

/**
 * How the callback route hands its result back to the client that started the
 * flow. The callback may reach a different process, or a cloud deployment with
 * no desktop protocol of its own, so this travels with the flow.
 */
export const mcpOAuthDeliverySchema = z.object({
  /** Started by the Electron app. */
  electron: z.boolean(),
  /**
   * The redirect sent is the custom app scheme, whose callback the Electron
   * main process fetches itself; otherwise an http(s) page the external
   * browser loads, which has to hand the result back to the app.
   */
  redirectWasScheme: z.boolean(),
  /** The desktop app's deep-link scheme, from the flow's redirect candidates. */
  desktopProtocol: z.string().min(1).optional(),
})
export type McpOAuthDelivery = z.infer<typeof mcpOAuthDeliverySchema>

/**
 * Everything the token exchange and the credential write need, rebuilt into a
 * request by whichever process claims the flow. Holds the PKCE verifier and
 * the client secret in plain form; sealing them is a separate follow-up.
 */
export const mcpOAuthExchangeSchema = z.object({
  tokenEndpoint: z.string().min(1),
  /** The redirect the authorization request named; the token request repeats it. */
  redirectUri: z.string().min(1),
  /** RFC 8707 resource, repeated on the token request. */
  resource: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  codeVerifier: z.string().min(1),
  /** Where the credentials go: the server being re-authorized, or a new one created by the callback. */
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('existing'), mcpId: z.string().min(1) }),
    z.object({
      kind: z.literal('new'),
      name: z.string(),
      url: z.string().min(1),
      /** The user who started the flow, who will own the new server. */
      userId: z.string().min(1).optional(),
    }),
  ]),
})
export type McpOAuthExchange = z.infer<typeof mcpOAuthExchangeSchema>

const recordFields = {
  issuer: mcpOAuthIssuerCheckSchema,
  delivery: mcpOAuthDeliverySchema,
}

/**
 * One MCP sign-in, from its start until its callback is answered: `pending`
 * with what the exchange needs; `claimed` while one callback exchanges the
 * code; `finished` once that callback, or an error response, has used it.
 * Only `pending` holds secrets. `owner` is a random id per claim, so a claimant
 * can tell its own write from anyone else's after a lost answer.
 */
export const mcpOAuthFlowRecordSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending'), ...recordFields, exchange: mcpOAuthExchangeSchema }),
  z.object({ state: z.literal('claimed'), ...recordFields, owner: z.string().min(1) }),
  z.object({ state: z.literal('finished'), ...recordFields, owner: z.string().min(1) }),
])
export type McpOAuthFlowRecord = z.infer<typeof mcpOAuthFlowRecordSchema>
export type PendingMcpOAuthFlow = Extract<McpOAuthFlowRecord, { state: 'pending' }>

/**
 * The token endpoint's answer (RFC 6749 §5.1), checked before the credentials
 * are written. Lenient where servers differ: `expires_in` sometimes arrives as
 * a string, `refresh_token` as null.
 */
export const mcpOAuthTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().nullish(),
  expires_in: z.union([z.number(), z.string()]).nullish(),
})
export type McpOAuthTokenResponse = z.infer<typeof mcpOAuthTokenResponseSchema>
