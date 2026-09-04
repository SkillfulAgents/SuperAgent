import { z } from 'zod'

export const credentialProviderStatusSchema = z.enum([
  'unconfigured',
  'ready',
  'unavailable',
  'locked',
  'error',
  'warming',
])

export const credentialProviderConnectionStatusSchema = z.enum([
  'connected',
  'disconnected',
  'unavailable',
  'error',
])

export const credentialProviderRemediationSchema = z.object({
  code: z.string(),
  title: z.string(),
  instructions: z.array(z.string()),
  action: z.object({
    kind: z.enum(['open_url', 'open_in_chrome']),
    label: z.string(),
    url: z.string(),
  }).optional(),
})

export const credentialProviderConnectionSchema = z.object({
  provider: z.string(),
  providerLabel: z.string(),
  installable: z.boolean(),
  status: credentialProviderConnectionStatusSchema,
  message: z.string().optional(),
  remediation: credentialProviderRemediationSchema.optional(),
})

export const passwordManagerCardSchema = credentialProviderConnectionSchema.extend({
  configured: z.boolean(),
})

export const credentialSuggestionSchema = z.object({
  id: z.string(),
  username: z.string().optional(),
  domain: z.string().optional(),
  title: z.string().optional(),
})

export const credentialSuggestionsResponseSchema = z.object({
  provider: z.string(),
  providerLabel: z.string(),
  status: credentialProviderStatusSchema,
  installable: z.boolean(),
  searchable: z.boolean(),
  origin: z.string(),
  message: z.string().optional(),
  suggestions: z.array(credentialSuggestionSchema),
})

export type CredentialProviderStatus = z.infer<typeof credentialProviderStatusSchema>
export type CredentialProviderConnectionStatus = z.infer<typeof credentialProviderConnectionStatusSchema>
export type CredentialProviderRemediation = z.infer<typeof credentialProviderRemediationSchema>
export type CredentialProviderConnection = z.infer<typeof credentialProviderConnectionSchema>
export type PasswordManagerCard = z.infer<typeof passwordManagerCardSchema>
export type CredentialSuggestion = z.infer<typeof credentialSuggestionSchema>
export type CredentialSuggestionsResponse = z.infer<typeof credentialSuggestionsResponseSchema>
