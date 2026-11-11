import { z } from 'zod'

export const seedSettingsSchema = z.object({
  app: z.object({ setupCompleted: z.literal(true), showMenuBarIcon: z.literal(false) }),
  container: z.object({ containerRunner: z.literal('docker') }),
  shareAnalytics: z.literal(false),
  auth: z.object({
    signupMode: z.literal('open'),
    allowLocalAuth: z.literal(true),
    requireAdminApproval: z.literal(false),
    passwordMinLength: z.literal(8),
    passwordRequireComplexity: z.literal(false),
    maxConcurrentSessions: z.literal(50),
  }).optional(),
})

export const authResponseSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
})

export const cloudTargetSchema = z.object({
  target: z.literal('cloud'),
  baseUrl: z.url(),
  deploymentUrl: z.url(),
})

export const policySchema = z.object({
  auth: z.object({ passwordMinLength: z.number(), passwordRequireComplexity: z.boolean() }),
})
