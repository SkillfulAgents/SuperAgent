import { z } from 'zod'

const apiKeysSchema = z.object({
  anthropicApiKey: z.string().optional(),
  openrouterApiKey: z.string().optional(),
  genericApiKey: z.string().optional(),
  genericBaseUrl: z.string().optional(),
  bedrockApiKey: z.string().optional(),
  bedrockAccessKeyId: z.string().optional(),
  bedrockSecretAccessKey: z.string().optional(),
  bedrockRegion: z.string().optional(),
})

const resourceLimitsSchema = z.object({
  cpu: z.number(),
  memory: z.string(),
})

const jsonObjectSchema = z.record(z.string(), z.unknown())

export const probeSourceSettingsSchema = z.object({
  apiKeys: apiKeysSchema,
  llmProvider: z.string().optional(),
  models: jsonObjectSchema.optional(),
  modelCatalog: jsonObjectSchema.optional(),
  agentLimits: jsonObjectSchema.optional(),
  container: z.object({ resourceLimits: resourceLimitsSchema.optional() }).optional(),
}).superRefine((settings, context) => {
  const credentialValues = [
    settings.apiKeys.anthropicApiKey,
    settings.apiKeys.openrouterApiKey,
    settings.apiKeys.genericApiKey,
    settings.apiKeys.bedrockApiKey,
    settings.apiKeys.bedrockAccessKeyId,
    settings.apiKeys.bedrockSecretAccessKey,
  ]
  const hasLlmKey = credentialValues.some(
    (value) => typeof value === 'string' && value.length > 0,
  )
  if (!hasLlmKey) {
    context.addIssue({
      code: 'custom',
      message: 'Source settings must contain a configured LLM API key',
      path: ['apiKeys'],
    })
  }
})

export const seededProbeSettingsSchema = z.object({
  apiKeys: apiKeysSchema,
  container: z.object({
    containerRunner: z.literal('docker'),
    agentImage: z.string().min(1),
    resourceLimits: resourceLimitsSchema.optional(),
  }),
  app: z.object({
    setupCompleted: z.literal(true),
  }),
  llmProvider: z.string().optional(),
  models: jsonObjectSchema.optional(),
  modelCatalog: jsonObjectSchema.optional(),
  agentLimits: jsonObjectSchema.optional(),
  shareAnalytics: z.literal(false),
  shareErrorReports: z.literal(false),
})

export const createdAgentSchema = z.object({
  slug: z.string().min(1),
}).loose()

const apiToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  result: z.unknown().optional(),
  isError: z.boolean().optional(),
}).loose()

export const apiMessagesSchema = z.array(z.object({
  type: z.enum(['user', 'assistant']),
  content: z.object({ text: z.string() }),
  toolCalls: z.array(apiToolCallSchema),
}).loose())

export const invokeAgentInputSchema = z.object({
  slug: z.string().min(1),
  prompt: z.string().min(1),
  attachments: z.array(z.string().min(1)).min(1),
  sync: z.literal(true),
}).loose()

export const getSessionTranscriptInputSchema = z.object({
  slug: z.string().min(1),
  session_id: z.string().min(1),
  sync: z.literal(true),
}).loose()

export const downloadAgentFileInputSchema = z.object({
  slug: z.string().min(1),
  session_id: z.string().min(1),
  delivery_id: z.string().min(1),
}).loose()

export const deliverFileInputSchema = z.object({
  filePath: z.string().min(1),
  description: z.string().optional(),
}).loose()

export const attachmentProbeProofSchema = z.object({
  callerSlug: z.string().min(1),
  calleeSlug: z.string().min(1),
  callerSessionId: z.string().min(1),
  calleeSessionId: z.string().min(1),
  deliveryId: z.string().min(1),
  expectedBytes: z.number().int().positive(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  callerUploadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  calleeAttachmentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  calleeDeliverySha256: z.string().regex(/^[a-f0-9]{64}$/),
  callerDownloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
})

export const attachmentProbeAgentsSchema = z.object({
  callerSlug: z.string().min(1),
  calleeSlug: z.string().min(1),
})

export const attachmentProbeRunMetadataSchema = z.object({
  imageTag: z.string().min(1),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  gitCommit: z.string().regex(/^[a-f0-9]{40}$/),
  gitStatus: z.array(z.string()),
  builtFromCheckout: z.boolean(),
})

export const xAgentInvocationResultSchema = z.object({
  sessionId: z.string().min(1),
  status: z.enum(['running', 'completed']),
}).loose()
