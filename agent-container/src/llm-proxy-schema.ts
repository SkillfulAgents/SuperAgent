import { z } from 'zod'

// Execution-only data. Never put this object in session or warm-profile files.
export const proxyCredentialSchema = z.object({
  accessToken: z.string().min(1),
  accountId: z.string().optional(),
  generation: z.number().int(),
  expiresAt: z.number().optional(),
})
export const llmProxyConfigSchema = z.object({
  format: z.enum(['messages', 'chat-completions', 'responses']),
  baseUrl: z.url({ protocol: /^https?$/ }),
  credential: proxyCredentialSchema,
  headers: z.record(z.string(), z.string()).default({}),
  maxOutputTokens: z.number().int().positive().optional(),
  chatTokenLimitField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  omitReasoningEffort: z.boolean().optional(),
})
export type ProxyCredential = z.infer<typeof proxyCredentialSchema>
export type LlmProxyConfig = z.infer<typeof llmProxyConfigSchema>
