import { z } from 'zod'

/** A sign-in started by `initiateOAuthFlow`, kept until its callback, keyed by `state`. */
export const pendingOAuthFlowSchema = z.object({
  codeVerifier: z.string(),
  redirectUri: z.string(),
  resource: z.string(),
  tokenEndpoint: z.string(),
  expectedIssuer: z.string().optional(),
  authorizationResponseIssParameterSupported: z.boolean(),
  clientId: z.string(),
  clientSecret: z.string().optional(),
  mcpId: z.string().optional(),
  newServer: z.object({ name: z.string(), url: z.string() }).optional(),
  userId: z.string().optional(),
  // True when the flow was initiated by the Electron app. Combined with whether
  // the winning redirect is the custom app scheme, this tells the callback route
  // how to hand the result back (see completeOAuthFlow's return).
  electron: z.boolean().optional(),
  // The desktop app's deep-link scheme, kept on the flow because the callback
  // may be served by a cloud deployment with no SUPERAGENT_PROTOCOL of its own.
  desktopProtocol: z.string().optional(),
})

export type PendingOAuthFlow = z.infer<typeof pendingOAuthFlowSchema>
