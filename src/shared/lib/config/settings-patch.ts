import { z } from 'zod'
import type {
  ApiKeySettings,
  AppPreferences,
  AppSettings,
  ContainerSettings,
} from './settings'
import { agentCapabilitySettingsPatchSchema, DEFAULT_AGENT_CAPABILITIES } from './capability-policy-schema'
import { validateFaviconDataUrl } from './favicon'
import { isValidAccelerator } from './shortcuts'
import {
  CONTAINER_RUNNER_IDS,
  EFFORT_LEVELS,
  VALID_LIMA_VM_MEMORY_OPTIONS,
  type ContainerRunner,
} from '../container/types'
import { assessVmMemory } from '../container/vm-memory'
import { customEnvVarsSchema } from '../container/reserved-env-vars'
import { modelCatalogSettingsSchema } from '../llm-provider/model-catalog-schema'
import { LLM_PROVIDER_IDS, type LlmProviderId } from '../llm-provider/provider-types'
import { WEB_PROVIDER_IDS } from '../web-provider/types'

const notificationSettingsSchema = z.object({
  enabled: z.boolean(),
  sessionComplete: z.boolean(),
  sessionWaiting: z.boolean(),
  sessionScheduled: z.boolean(),
  platformNotification: z.boolean().optional(),
  notifyWhenUnfocused: z.boolean().optional(),
}).strict()

const resourceLimitsPatchSchema = z.object({
  cpu: z.number(),
  memory: z.string(),
}).partial().strict()

const runtimeSettingsPatchSchema = z
  .record(z.string(), z.record(z.string(), z.string()))
  .superRefine((runtimeSettings, ctx) => {
    const vmMemory = runtimeSettings.lima?.vmMemory
    if (
      vmMemory !== undefined &&
      !(VALID_LIMA_VM_MEMORY_OPTIONS as readonly string[]).includes(vmMemory)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['lima', 'vmMemory'],
        message: `Invalid VM memory setting. Must be one of: ${VALID_LIMA_VM_MEMORY_OPTIONS.join(', ')}`,
      })
    }
  })

export const containerSettingsPatchSchema = z.object({
  // ContainerSettings is intentionally string-typed because runtime eligibility
  // is platform-dependent. Keep that client-facing type while rejecting names
  // outside the complete runner registry at the API boundary.
  containerRunner: z.string().refine(
    (value) => (CONTAINER_RUNNER_IDS as readonly string[]).includes(value),
    { message: `containerRunner must be one of: ${CONTAINER_RUNNER_IDS.join(', ')}` },
  ),
  agentImage: z.string(),
  resourceLimits: resourceLimitsPatchSchema,
  runtimeSettings: runtimeSettingsPatchSchema,
}).partial().strict()

const faviconDataUrlPatchSchema = z.union([z.string(), z.null()]).superRefine((value, ctx) => {
  const result = validateFaviconDataUrl(value)
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', message: result.error })
  }
})

export const appSettingsPatchSchema = z.object({
  showMenuBarIcon: z.boolean(),
  notifications: notificationSettingsSchema,
  autoSleepTimeoutMinutes: z.number(),
  warmStartOnType: z.boolean(),
  autoResumeOnUnexpectedDeath: z.boolean(),
  autoDeleteInactiveDays: z.number(),
  setupCompleted: z.boolean(),
  accountProvider: z.enum(['composio', 'nango']),
  hostBrowserProvider: z.enum(['chrome', 'browserbase', 'platform']).nullable(),
  chromeProfileId: z.string(),
  chromeHeadless: z.boolean(),
  allowPrereleaseUpdates: z.boolean(),
  theme: z.enum(['system', 'light', 'dark']),
  globalDispatchShortcut: z.string().refine(
    (value) => value === '' || isValidAccelerator(value),
    {
      message:
        'globalDispatchShortcut must be an accelerator like "CommandOrControl+Shift+Space" (or "" to disable)',
    },
  ),
  maxBrowserTabs: z.number(),
  faviconDataUrl: faviconDataUrlPatchSchema,
  browserbaseAdvancedStealth: z.boolean(),
  browserbaseStealthOs: z.enum(['linux', 'windows', 'mac', 'mobile', 'tablet']),
  browserbaseProxies: z.boolean(),
  browserbaseProxyCountry: z.string(),
  browserbaseProxyState: z.string(),
  browserbaseProxyCity: z.string(),
}).partial().strict()

export const apiKeySettingsPatchSchema = z.object({
  anthropicApiKey: z.string(),
  openrouterApiKey: z.string(),
  genericApiKey: z.string(),
  genericBaseUrl: z.string(),
  bedrockApiKey: z.string(),
  bedrockAccessKeyId: z.string(),
  bedrockSecretAccessKey: z.string(),
  bedrockRegion: z.string(),
  composioApiKey: z.string(),
  composioUserId: z.string(),
  browserbaseApiKey: z.string(),
  browserbaseProjectId: z.string(),
  deepgramApiKey: z.string(),
  openaiApiKey: z.string(),
  nangoSecretKey: z.string(),
  accountProviderUserId: z.string(),
  exaApiKey: z.string(),
}).partial().strict()

const modelSettingsPatchSchema = z.object({
  summarizerModel: z.string(),
  agentModel: z.string(),
  browserModel: z.string(),
  dashboardBuilderModel: z.string(),
  agentEffort: z.enum(EFFORT_LEVELS, {
    error: `agentEffort must be one of: ${EFFORT_LEVELS.join(', ')}`,
  }),
}).partial().strict()

export const providerSettingsPatchSchema = z.object({
  llmProvider: z.enum(LLM_PROVIDER_IDS),
  webProvider: z.enum(WEB_PROVIDER_IDS, {
    error: 'Invalid webProvider',
  }).nullable(),
  webAllowedSites: z.array(z.string()),
  webBlockedSites: z.array(z.string()),
  models: modelSettingsPatchSchema,
  modelCatalog: modelCatalogSettingsSchema,
}).partial().strict()

const agentLimitsPatchSchema = z.object({
  maxOutputTokens: z.number(),
  maxThinkingTokens: z.number(),
  maxTurns: z.number(),
  maxBudgetUsd: z.number(),
}).partial().strict()

const authSettingsPatchSchema = z.object({
  trustedOrigins: z.array(z.string()),
  signupMode: z.enum(['open', 'domain_restricted', 'invitation_only', 'closed']),
  allowedSignupDomains: z.array(z.string()),
  requireAdminApproval: z.boolean(),
  defaultUserRole: z.enum(['member', 'admin']),
  allowLocalAuth: z.boolean(),
  allowSocialAuth: z.boolean(),
  passwordMinLength: z.number(),
  passwordMaxLength: z.number(),
  passwordRequireComplexity: z.boolean(),
  sessionMaxLifetimeHrs: z.number(),
  sessionIdleTimeoutMin: z.number(),
  maxConcurrentSessions: z.number(),
  accountLockoutThreshold: z.number(),
  accountLockoutDurationMin: z.number(),
}).partial().strict()

const voiceSettingsPatchSchema = z.object({
  sttProvider: z.enum(['deepgram', 'openai', 'platform']),
}).partial().strict()

const computerUseGrantSchema = z.object({
  level: z.enum(['list_apps_windows', 'use_application', 'use_host_shell']),
  appName: z.string().optional(),
  grantType: z.literal('always'),
}).strict()

const computerUseSettingsPatchSchema = z.object({
  agentPermissions: z.record(
    z.string(),
    z.object({ grants: z.array(computerUseGrantSchema) }).strict(),
  ),
}).partial().strict()

const analyticsTargetSchema = z.object({
  type: z.enum(['amplitude', 'google-analytics', 'mixpanel']),
  config: z.record(z.string(), z.string()),
  enabled: z.boolean(),
}).strict()

export const generalSettingsPatchSchema = z.object({
  agentLimits: agentLimitsPatchSchema,
  customEnvVars: customEnvVarsSchema,
  auth: authSettingsPatchSchema,
  voice: voiceSettingsPatchSchema,
  computerUse: computerUseSettingsPatchSchema,
  shareAnalytics: z.boolean(),
  analyticsTargets: z.array(analyticsTargetSchema),
  shareErrorReports: z.boolean(),
  enableToolSearch: z.boolean(),
  teamBrain: z.boolean(),
  agentCapabilities: agentCapabilitySettingsPatchSchema.strict(),
}).partial().strict()

/** The complete, allowlisted patch accepted by PUT /api/settings. */
export const settingsPatchSchema = z.object({
  container: containerSettingsPatchSchema.optional(),
  app: appSettingsPatchSchema.optional(),
  apiKeys: apiKeySettingsPatchSchema.optional(),
  ...providerSettingsPatchSchema.shape,
  ...generalSettingsPatchSchema.shape,
}).strict()

export type SettingsPatch = z.infer<typeof settingsPatchSchema>
export type ContainerSettingsPatch = z.infer<typeof containerSettingsPatchSchema>
export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>
export type ApiKeySettingsPatch = z.infer<typeof apiKeySettingsPatchSchema>
export type ProviderSettingsPatch = z.infer<typeof providerSettingsPatchSchema>
export type GeneralSettingsPatch = z.infer<typeof generalSettingsPatchSchema>

interface ProviderDefaultModels {
  summarizerModel: string
  agentModel: string
  browserModel: string
  dashboardBuilderModel: string
}

export interface SettingsApplyContext {
  now: Date
  getProviderDefaultModels(provider: LlmProviderId): ProviderDefaultModels | undefined
}

export interface SettingsTransitionContext {
  hasRunningAgents: boolean
  hostTotalMemoryBytes: number
  supportsCustomAgentImage(runner: ContainerRunner): boolean
}

export interface SettingsProblem {
  status: 400 | 409
  message: string
  includeRunningAgentIds?: boolean
}

interface ComponentApplyArgs<Patch> {
  before: AppSettings
  patch: Patch | undefined
  context: SettingsApplyContext
}

interface ComponentValidateArgs<Patch> {
  before: AppSettings
  after: AppSettings
  patch: Patch | undefined
  context: SettingsTransitionContext
}

/** A cohesive schema/apply/transition bundle for one settings business domain. */
export interface SettingsComponent<Schema extends z.ZodType> {
  readonly schema: Schema
  apply(args: ComponentApplyArgs<z.infer<Schema>>): AppSettings
  validate(args: ComponentValidateArgs<z.infer<Schema>>): SettingsProblem[]
}

export const containerSettingsComponent = {
  schema: containerSettingsPatchSchema,

  apply({ before, patch }: ComponentApplyArgs<ContainerSettingsPatch>): AppSettings {
    if (!patch) return before

    const resourceLimits: ContainerSettings['resourceLimits'] = patch.resourceLimits
      ? {
          cpu: patch.resourceLimits.cpu ?? before.container.resourceLimits.cpu,
          memory: patch.resourceLimits.memory ?? before.container.resourceLimits.memory,
        }
      : before.container.resourceLimits

    return {
      ...before,
      container: {
        ...before.container,
        ...patch,
        resourceLimits,
        runtimeSettings: patch.runtimeSettings
          ? { ...before.container.runtimeSettings, ...patch.runtimeSettings }
          : before.container.runtimeSettings,
      },
    }
  },

  validate({ before, after, patch, context }: ComponentValidateArgs<ContainerSettingsPatch>): SettingsProblem[] {
    if (!patch) return []
    const problems: SettingsProblem[] = []

    const runnerChanged = after.container.containerRunner !== before.container.containerRunner
    const resourcesChanged =
      after.container.resourceLimits.cpu !== before.container.resourceLimits.cpu ||
      after.container.resourceLimits.memory !== before.container.resourceLimits.memory

    if (context.hasRunningAgents && (runnerChanged || resourcesChanged)) {
      problems.push({
        status: 409,
        message:
          'Cannot change container runner or resource limits while agents are running. Please stop all agents first.',
        includeRunningAgentIds: true,
      })
    }

    const imageChanged = after.container.agentImage !== before.container.agentImage
    const effectiveRunner = after.container.containerRunner as ContainerRunner
    if (imageChanged && !context.supportsCustomAgentImage(effectiveRunner)) {
      problems.push({
        status: 400,
        message: `Agent image is managed by the deployment for the ${effectiveRunner} runner and cannot be changed here.`,
      })
    }

    const requestedVmMemory = patch.runtimeSettings?.lima?.vmMemory
    if (requestedVmMemory) {
      const assessment = assessVmMemory(requestedVmMemory, context.hostTotalMemoryBytes)
      if (assessment.level === 'refuse') {
        problems.push({ status: 400, message: assessment.message })
      }
    }

    return problems
  },
} satisfies SettingsComponent<typeof containerSettingsPatchSchema>

export const appSettingsComponent = {
  schema: appSettingsPatchSchema,

  apply({ before, patch, context }: ComponentApplyArgs<AppSettingsPatch>): AppSettings {
    if (!patch) return before

    const { faviconDataUrl, hostBrowserProvider, ...rest } = patch
    const normalizedPatch: Partial<AppPreferences> = { ...rest }

    if (Object.prototype.hasOwnProperty.call(patch, 'faviconDataUrl')) {
      normalizedPatch.faviconUpdatedAt = context.now.toISOString()
      normalizedPatch.faviconDataUrl =
        faviconDataUrl === null || faviconDataUrl === '' ? undefined : faviconDataUrl
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'hostBrowserProvider')) {
      normalizedPatch.hostBrowserProvider = hostBrowserProvider ?? undefined
    }

    return {
      ...before,
      app: {
        ...before.app,
        ...normalizedPatch,
      },
    }
  },

  validate(_args: ComponentValidateArgs<AppSettingsPatch>): SettingsProblem[] {
    return []
  },
} satisfies SettingsComponent<typeof appSettingsPatchSchema>

export const apiKeySettingsComponent = {
  schema: apiKeySettingsPatchSchema,

  apply({ before, patch }: ComponentApplyArgs<ApiKeySettingsPatch>): AppSettings {
    if (!patch) return before

    let apiKeys = before.apiKeys
    for (const [field, value] of Object.entries(patch) as [keyof ApiKeySettings, string][]) {
      apiKeys = { ...apiKeys }
      if (value === '') delete apiKeys[field]
      else apiKeys[field] = value
    }

    return {
      ...before,
      apiKeys: apiKeys && Object.keys(apiKeys).length > 0 ? apiKeys : undefined,
    }
  },

  validate(_args: ComponentValidateArgs<ApiKeySettingsPatch>): SettingsProblem[] {
    return []
  },
} satisfies SettingsComponent<typeof apiKeySettingsPatchSchema>

export const providerSettingsComponent = {
  schema: providerSettingsPatchSchema,

  apply({ before, patch, context }: ComponentApplyArgs<ProviderSettingsPatch>): AppSettings {
    if (!patch) return before

    const currentProvider = before.llmProvider ?? 'anthropic'
    const providerChanged =
      patch.llmProvider !== undefined && patch.llmProvider !== currentProvider

    let models = before.models
    if (patch.models !== undefined) {
      models = { ...before.models, ...patch.models } as AppSettings['models']
    } else if (providerChanged && patch.llmProvider) {
      const defaults = context.getProviderDefaultModels(patch.llmProvider)
      if (defaults) models = { ...before.models, ...defaults }
    }

    return {
      ...before,
      llmProvider: patch.llmProvider ?? before.llmProvider,
      webProvider:
        patch.webProvider === null
          ? undefined
          : patch.webProvider !== undefined
            ? patch.webProvider
            : before.webProvider,
      webAllowedSites:
        patch.webAllowedSites !== undefined ? patch.webAllowedSites : before.webAllowedSites,
      webBlockedSites:
        patch.webBlockedSites !== undefined ? patch.webBlockedSites : before.webBlockedSites,
      models,
      modelCatalog:
        patch.modelCatalog !== undefined ? patch.modelCatalog : before.modelCatalog,
    }
  },

  validate(_args: ComponentValidateArgs<ProviderSettingsPatch>): SettingsProblem[] {
    return []
  },
} satisfies SettingsComponent<typeof providerSettingsPatchSchema>

export const generalSettingsComponent = {
  schema: generalSettingsPatchSchema,

  apply({ before, patch }: ComponentApplyArgs<GeneralSettingsPatch>): AppSettings {
    if (!patch) return before

    return {
      ...before,
      agentLimits:
        patch.agentLimits !== undefined
          ? { ...before.agentLimits, ...patch.agentLimits }
          : before.agentLimits,
      customEnvVars:
        patch.customEnvVars !== undefined ? patch.customEnvVars : before.customEnvVars,
      auth: patch.auth !== undefined ? { ...before.auth, ...patch.auth } : before.auth,
      voice: patch.voice !== undefined ? { ...before.voice, ...patch.voice } : before.voice,
      computerUse:
        patch.computerUse !== undefined
          ? { ...before.computerUse, ...patch.computerUse }
          : before.computerUse,
      shareAnalytics:
        patch.shareAnalytics !== undefined ? patch.shareAnalytics : before.shareAnalytics,
      analyticsTargets:
        patch.analyticsTargets !== undefined ? patch.analyticsTargets : before.analyticsTargets,
      shareErrorReports:
        patch.shareErrorReports !== undefined
          ? patch.shareErrorReports
          : before.shareErrorReports,
      enableToolSearch:
        patch.enableToolSearch !== undefined
          ? patch.enableToolSearch
          : before.enableToolSearch,
      teamBrain: patch.teamBrain !== undefined ? patch.teamBrain : before.teamBrain,
      agentCapabilities:
        patch.agentCapabilities !== undefined
          ? {
              ...DEFAULT_AGENT_CAPABILITIES,
              ...before.agentCapabilities,
              ...patch.agentCapabilities,
            }
          : before.agentCapabilities,
    }
  },

  validate(_args: ComponentValidateArgs<GeneralSettingsPatch>): SettingsProblem[] {
    return []
  },
} satisfies SettingsComponent<typeof generalSettingsPatchSchema>

function pickProviderPatch(patch: SettingsPatch): ProviderSettingsPatch {
  return {
    llmProvider: patch.llmProvider,
    webProvider: patch.webProvider,
    webAllowedSites: patch.webAllowedSites,
    webBlockedSites: patch.webBlockedSites,
    models: patch.models,
    modelCatalog: patch.modelCatalog,
  }
}

function pickGeneralPatch(patch: SettingsPatch): GeneralSettingsPatch {
  return {
    agentLimits: patch.agentLimits,
    customEnvVars: patch.customEnvVars,
    auth: patch.auth,
    voice: patch.voice,
    computerUse: patch.computerUse,
    shareAnalytics: patch.shareAnalytics,
    analyticsTargets: patch.analyticsTargets,
    shareErrorReports: patch.shareErrorReports,
    enableToolSearch: patch.enableToolSearch,
    teamBrain: patch.teamBrain,
    agentCapabilities: patch.agentCapabilities,
  }
}

/** Build the candidate settings value without IO or runtime side effects. */
export function applySettingsPatch(
  before: AppSettings,
  patch: SettingsPatch,
  context: SettingsApplyContext,
): AppSettings {
  let after = containerSettingsComponent.apply({ before, patch: patch.container, context })
  after = appSettingsComponent.apply({ before: after, patch: patch.app, context })
  after = apiKeySettingsComponent.apply({ before: after, patch: patch.apiKeys, context })
  after = providerSettingsComponent.apply({
    before: after,
    patch: pickProviderPatch(patch),
    context,
  })
  after = generalSettingsComponent.apply({
    before: after,
    patch: pickGeneralPatch(patch),
    context,
  })
  return after
}

/** Run state-dependent policy against the fully merged candidate value. */
export function validateSettingsTransition(args: {
  before: AppSettings
  after: AppSettings
  patch: SettingsPatch
  context: SettingsTransitionContext
}): SettingsProblem[] {
  return [
    ...containerSettingsComponent.validate({
      before: args.before,
      after: args.after,
      patch: args.patch.container,
      context: args.context,
    }),
    ...appSettingsComponent.validate({
      before: args.before,
      after: args.after,
      patch: args.patch.app,
      context: args.context,
    }),
    ...apiKeySettingsComponent.validate({
      before: args.before,
      after: args.after,
      patch: args.patch.apiKeys,
      context: args.context,
    }),
    ...providerSettingsComponent.validate({
      before: args.before,
      after: args.after,
      patch: pickProviderPatch(args.patch),
      context: args.context,
    }),
    ...generalSettingsComponent.validate({
      before: args.before,
      after: args.after,
      patch: pickGeneralPatch(args.patch),
      context: args.context,
    }),
  ]
}

export function formatSettingsPatchError(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[]
}): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid settings update'
  const path = issue.path.join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}
