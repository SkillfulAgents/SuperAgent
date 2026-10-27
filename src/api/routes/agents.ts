import { assertConnectionSelectionAccess, connectionNeedsAttachment, credentialSource } from '@shared/lib/llm-provider/connection-runtime'
import { findAgentRuntimeError } from '@shared/lib/agent-runtime-errors/agent-runtime-error'
import { LlmProviderNotFoundError } from '@shared/lib/agent-runtime-errors/llm-provider-not-found/llm-provider-not-found-error'
import { listConnections, getConnection, providerForConnection, resolveGlobalSelection, storedSelection } from '@shared/lib/llm-provider/connections'
import { resolveConnectionRuntimeInherit } from '@shared/lib/llm-provider/connection-runtime'
import { loadTargetContext } from '@shared/lib/proxy/rules/service'
import { requiresOneTimeXAgentReview } from '@shared/lib/proxy/x-agent-review'
import agentMembers, { agentMembersBatch } from './agent-members'
import { notifySessionMentions, readSessionMentions } from './session-mentions'
import { deleteMessageAuthorBestEffort, insertMessageAuthorBestEffort } from './message-author'
import { parseMentions } from '@shared/lib/utils/mentions'
import { parseDictationNote } from '@shared/lib/utils/dictation-note'
import { notifyAgentMembersChanged, changeMemberRole, removeMember, countMembersWithMinRole, countOtherMembers } from '@shared/lib/services/agent-members-service'
import { formatSenderPrefix } from '@shared/lib/utils/sender-prefix'
import { getUserSummaries, searchUserSummaries, toUserSender, userExists, type UserSenderSource } from '@shared/lib/services/user-profile-service'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE } from 'hono/streaming'
import { getConnInfo } from '@hono/node-server/conninfo'
import type Anthropic from '@anthropic-ai/sdk'
import { createHash, randomUUID } from 'crypto'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { agentAvatarSchema } from '@shared/lib/types/agent-avatar'
import { getPolyfillJs } from '../speech-recognition-polyfill'
import accountReauth from './account-reauth'
import mcpReauth from './mcp-reauth'
import { agentMemoryRoutes } from './agent-memories'
import { agentBrowserAccountRoutes, sharedAgentRefusal } from './browser-accounts'
import { getLlmPolyfillJs } from '../llm-polyfill'
import {
  dashboardMountPath,
  dashboardResponseHeaders,
  injectDashboardRuntime,
} from '../dashboard-runtime'
import { parsePagination } from '../pagination'
import { MESSAGES_PAGE_MAX_LIMIT, capMessagesPageLimit, clampMessagesPageBytes } from '@shared/lib/messages-page'
import { streamJsonArrayResponse } from '../stream-json-array'
import { readLimitedJsonBody } from '../lib/read-limited-json-body'
import { waitForClientGone } from '../lib/wait-for-client-gone'
import { Authenticated, AgentRead, AgentUser, AgentAdmin, IsAdmin, ResolveAgent, getAgentId, getAuthorizedAgentRole, getMeetingParticipant, getRequestDeviceId } from '../middleware/auth'
import {
  listAgentsWithStatus,
  createAgent,
  getAgentWithStatus,
  getAgent,
  getAgentRecord,
  updateAgent,
  updateAgentAvatar,
  deleteAgent,
  agentExists,
  AgentContainerStopError,
} from '@shared/lib/services/agent-service'
import { AGENT_DESCRIPTION_MAX_LENGTH, AGENT_NAME_MAX_LENGTH } from '@shared/lib/services/agent-identity-schema'
import {
  agentRegistry,
  containerHost,
  WorkspaceFileError,
  joinWorkspacePath,
  normalizeWorkspacePath,
  decodeMediaRef,
  sortSessionsNewestFirst,
  SESSIONS_LIST_MAX_LIMIT,
  deliveryFailure,
  type AgentActor,
  type DeliverResult,
  type FileStat,
  type SessionSortBy,
} from '@shared/lib/agent-actor'
import { copyHostFileIntoWorkspace, moveHostFileIntoWorkspace } from '@shared/lib/agent-actor/copy-into-workspace'
import { parseRuntimeOptions } from '@shared/lib/container/runtime-options'
import {
  sessionDashboardDispatchSchema,
  type SessionDashboardDispatch,
} from '@shared/lib/dashboard-dispatch-schema'
import { getDashboardViewDispatchHostJs } from '../dashboard-view-dispatch-host'
import { isBlockingUserInputToolName } from '@shared/lib/tools/user-input-tools'
import { listWebhookTriggers, listActiveWebhookTriggers, listCancelledWebhookTriggers } from '@shared/lib/services/webhook-trigger-service'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { guessMimeType } from '@shared/lib/utils/mime'
import { HEIC_PREVIEW_MAX_SOURCE_BYTES } from '@shared/lib/utils/heic-preview'
import { servedRange } from '@shared/lib/utils/http-range'
import { globalFeed } from '@shared/lib/notifications/global-feed'
import { isSystemMessageText } from '@shared/lib/utils/system-message'
import { credentialBroker } from '../credentials/credential-broker'
import { CredentialBrokerError } from '../credentials/types'
import {
  completeLoginBodySchema,
  fillLoginBodySchema,
  fillLoginCredentialBodySchema,
  loginContextSchema,
  loginVaultPayloadSchema,
  loginViaBodySchema,
  type LoginContext,
} from '@shared/lib/tools/request-login/login-request'
import {
  accountView,
  answerLoginRequest,
  fillLoginInContainer,
  noteUsername,
  fieldsWentIn,
  partsFrom,
  readLoginContext,
  settleHeldParts,
  usableHeld,
  valuesFor,
} from '@shared/lib/browser-vault/login-host'
import {
  forgetHeldLogin,
  heldLoginFor,
  holdLoginValues,
  recentSignInIdentity,
  releaseHeldValues,
  rememberSignInIdentity,
} from '@shared/lib/browser-vault/held-values'
import { providerName, providerOf, SIGN_IN_PROVIDERS } from '@shared/lib/browser-vault/providers'
import { registrableDomain, siteOfOrigin, usernameKey, vaultFillsInto } from '@shared/lib/browser-vault/site'
import { partKeyOf } from '@shared/lib/browser-vault/vault-schemas'
import {
  clearAccountRejected,
  findOwnedProviderAccount,
  getAccount,
  getOwnedAccount,
  grantAccount,
  isAccountGranted,
  listGrantedAccountIds,
  listOwnedAccountsElsewhere,
  listOwnedAccountsOnSite,
  readAccountValues,
  recordAccountUse,
  saveAccount,
  switchAccountToVia,
  MAX_USERNAME,
  VaultConflictError,
  type VaultAccount,
  type VaultOwner,
} from '@shared/lib/browser-vault/vault-service'
import type {
  UserInputRequestKind,
  UserInputRequestScope,
} from '@shared/lib/tools/requests/request-schema'
import { forkSession, type ForkSessionOpts } from '@shared/lib/services/session-fork-service'
import { displaySlug, createJsonArrayStringifyTransform } from '@shared/lib/utils/file-storage'
import {
  MAX_UPLOAD_TOTAL_SIZE,
  UploadTooLargeError,
  cleanupStaleTempUploads,
  formatUploadTooLargeMessage,
  storeUploadChunk,
} from '@shared/lib/utils/chunked-upload'
import { getMountsWithHealth, addMount, attachMount, removeMount, setMountReadOnly, volumeSummary } from '@shared/lib/services/mount-service'
import { addMountSchema, updateMountSchema } from '@shared/lib/services/mount-schema'
import { releaseVolume, VolumeError } from '@shared/lib/services/volume-service'
import { volumeViewer } from '../lib/volume-access'
import { afterMountChange } from '../lib/mount-change'
import { readAgentHooks, removeAgentHook } from '@shared/lib/services/agent-hooks-service'
import { removeAgentHookSchema } from '@shared/lib/services/agent-hooks-schema'
import {
  listUserSecrets,
  getSecret,
  setSecret,
  updateSecret,
  deleteSecret,
  getSecretEnvVars,
} from '@shared/lib/services/secrets-service'
import { isReservedEnvVar } from '@shared/lib/container/reserved-env-vars'
import { keyToEnvVar } from '@shared/lib/utils/secrets'
import {
  listScheduledTasks,
  listPendingScheduledTasks,
  listCancelledScheduledTasks,
  listCompletedOneTimeTasks,
  createScheduledTask,
  cancelPendingWakeForSession,
  getPendingWakeForSession,
  listPendingWakesByAgent,
} from '@shared/lib/services/scheduled-task-service'
import { db } from '@shared/lib/db'
import { scheduledTasks, webhookTriggers, chatIntegrations, connectedAccounts, agentConnectedAccounts, proxyAuditLog, remoteMcpServers, agentRemoteMcps, mcpAuditLog, agentAcl, messageAuthor, apiScopePolicies, mcpToolPolicies } from '@shared/lib/db/schema'
import { eq, and, inArray, isNotNull, desc, count } from 'drizzle-orm'
import { isAuthMode } from '@shared/lib/auth/mode'
import { resolveTimezoneForAgent } from '@shared/lib/services/timezone-resolver'
import { validateCronExpression } from '@shared/lib/services/schedule-parser'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { isOwnOrigin } from '@shared/lib/auth/own-origin'
import { getViewerUserId, ownerScope } from '@shared/lib/auth/ownership'
import { normalizeMcpRequestLog, normalizeProxyRequestLog } from '@shared/lib/types/request-log'
import { withRuleNames } from '@shared/lib/proxy/rules/log-names'
import { auditRuleDecision } from '@shared/lib/proxy/rules/audit-events'
import { getProvider } from '@shared/lib/account-providers'
// getAgentSkills is superseded by getAgentSkillsWithStatus from skillset-service
// import { getAgentSkills } from '@shared/lib/skills'
import {
  getAgentSkillsWithStatus,
  getDiscoverableSkills,
  installSkillFromSkillset,
  updateSkillFromSkillset,
  createSkillPR,
  getSkillPRInfo,
  getSkillPublishInfo,
  publishSkillToSkillset,
  refreshAgentSkills,
  exportSkill,
  deleteSkill,
  importSkillFromZip,
  SKILL_MAX_COMPRESSED_SIZE,
} from '@shared/lib/services/skillset-service'
import { type ArtifactInfo, listArtifactsFromFilesystem, listArtifactsAndWidgets, deleteArtifactFromFilesystem, renameArtifactOnFilesystem } from '@shared/lib/services/artifact-service'
import {
  WIDGET_HTML_CSP,
  renderWidgetDocument,
  listWidgetsFromFilesystem,
  readWidgetFromFilesystem,
  readWidgetHtml,
  resolveWidgetPath,
  resolveArtifactPath,
  widgetSnapshotPngPath,
  containedArtifactPath,
} from '@shared/lib/services/widget-service'
import { widgetRefreshService } from '@shared/lib/services/widget-refresh-service'
import { widgetSchemeSchema, widgetSizeSchema } from '@shared/lib/widgets/widget-schema'
import { getSessionIdsWithUnreadMentions, getSessionIdsWithUnreadNotifications, getUnreadMentionsByAgents, getUnreadNotificationsByAgents, deleteNotificationsBySessionIds } from '@shared/lib/services/notification-service'
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import { markSessionUnread, clearSessionUnread, getSessionIdsMarkedUnread, getSessionIdsMarkedUnreadByAgents, deleteSessionUnreadMarks } from '@shared/lib/services/session-unread-service'
import { unlinkTodosFromSessions } from '@shared/lib/services/todo-service'
import { annotateIntegrationMessages } from '@shared/lib/services/agent-integration-message-service'
import { isHiddenAutomatedSession } from '@shared/lib/services/session-visibility'
import { getInboundXAgentDetails } from '@shared/lib/services/inbound-x-agent-service'
import { isValidApiScope } from '@shared/lib/proxy/scope-matcher'
import { isLabelDefaultKey } from '@shared/lib/proxy/policy-sentinels'
import type { ScopeLabel } from '@shared/lib/proxy/scope-metadata'
import {
  deletePolicy,
  deletePoliciesForAgent,
  deleteTargetPolicy,
  listPoliciesForCaller,
  replacePoliciesForCaller,
  replacePoliciesForCallerInputSchema,
  setPolicy,
  xAgentDecisionSchema,
  xAgentOperationSchema,
} from '@shared/lib/services/x-agent-policy-service'
import {
  exportAgentTemplate,
  exportAgentFull,
  isHostExportBusy,
  importAgentFromTemplate,
  MAX_COMPRESSED_SIZE,
  installAgentFromSkillset,
  updateAgentFromSkillset,
  getAgentTemplateStatus,
  getDiscoverableAgents,
  refreshSkillsetCaches,
  getAgentPRInfo,
  createAgentPR,
  getAgentPublishInfo,
  publishAgentToSkillset,
  refreshAgentTemplates,
  hasOnboardingSkill,
  getAgentTemplatePrompt,
  type TemplateZipSource,
} from '@shared/lib/services/agent-template-service'
import { getSkillsetProvider } from '@shared/lib/skillset-provider'
import type { SkillsetConfig } from '@shared/lib/types/skillset'
import { transformMessages, type TransformedMessage, type TransformedItem } from '@shared/lib/utils/message-transform'
import { subagentOwnEntries } from '@shared/lib/utils/fork-subagent-transcript'
import { workflowRoutes } from './workflows'
import { getEffectiveModels, getEffectiveAgentLimits, getCustomEnvVars, getSettings, getTeamBrain, mutateSettings, VALID_SCRIPT_TYPES } from '@shared/lib/config/settings'
import { readsHostFolders } from '@shared/lib/facts/capabilities'
import { getServerFacts } from '@shared/lib/facts/server-facts'
import { ungrabAC } from '@shared/lib/computer-use/executor'
import type { PermissionGrantType } from '@shared/lib/computer-use/types'
import { rejectInput, type HostRunOutcome } from '@shared/lib/agent-actor/host-runs'
import { getConfiguredLlmClient, createSummarizerText } from '@shared/lib/llm-provider/helpers'
import { getActiveLlmProvider, getLlmProvider, resolveActiveProviderModel } from '@shared/lib/llm-provider'
import { revokeProxyToken } from '@shared/lib/proxy/token-store'
import { sanitizeUploadFilename, withUploadTimestamp } from '@shared/lib/utils/path-safety'
import { AGENT_PACKAGE_EXTENSION, SKILL_PACKAGE_EXTENSION } from '@shared/lib/utils/package-extensions'
import { readAgentPreferences, updateAgentPreferences } from '@shared/lib/services/agent-preferences-service'
import { agentPreferencesUpdateSchema } from '@shared/lib/types/agent-preferences'
import { cleanupAgentData } from '@shared/lib/services/agent-cleanup-service'
import { stopInstanceOnAllProviders } from '../../main/host-browser'
import { deleteBrowserProfile } from '../../main/host-browser/profile-maintenance'
import { logAuditEvent, logAuditEventOrThrow } from '@shared/lib/services/audit-log-service'
import { captureException } from '@shared/lib/error-reporting'
import { background } from '@shared/lib/background'
import * as fs from 'fs'
import { Readable, pipeline } from 'stream'
import pLimit from 'p-limit'
import * as path from 'path'
import type { ApiAgent } from '@shared/lib/types/api'
import type { JsonlEntry, JsonlMessageEntry, SessionInfo, SessionMetadata, SessionMetadataMap } from '@shared/lib/types/agent'
import { listAgentIntegrationsHandler } from './agent-integration-list'
import { toPublicWebhookTrigger } from '@shared/lib/webhook-triggers/public'
import {
  toAgentConnectedAccountDto,
  toAgentRemoteMcpDto,
} from '@shared/lib/agent-connections/public'
import { createSecretRequestSchema, updateSecretRequestSchema } from './secrets-schema'
import type { Bookmark } from '@shared/lib/utils/bookmarks'

const WorkspaceBookmarkSchema = z.object({
  name: z.string().min(1),
  link: z.string().url().startsWith('https://').optional(),
  file: z.string().min(1).optional(),
  folder: z.string()
    .min(1)
    .transform(folderPath => normalizeWorkspaceContainerPath(folderPath) ?? folderPath)
    .optional(),
}).superRefine((bookmark, ctx) => {
  const resourceCount = [bookmark.link, bookmark.file, bookmark.folder]
    .filter(value => value != null).length
  if (resourceCount !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'Each bookmark must have exactly one of link, file, or folder',
    })
  }
  if (bookmark.folder && normalizeWorkspaceContainerPath(bookmark.folder) == null) {
    ctx.addIssue({
      code: 'custom',
      path: ['folder'],
      message: 'Folder path must be inside /workspace',
    })
  }
})

const WorkspaceBookmarksSchema = z.array(WorkspaceBookmarkSchema)
type WorkspaceBookmark = z.infer<typeof WorkspaceBookmarkSchema>

// The renderer's Bookmark is this shape with "exactly one of link/file/folder"
// expressed in the type system rather than in the superRefine above, so the two
// cannot be one declaration — but everything the renderer can construct has to
// be something this schema accepts. If that stops holding this stops compiling,
// which is what keeps the two definitions in step.
type AssertAssignable<A extends B, B> = A
type _RendererBookmarkIsWritable = AssertAssignable<Bookmark, WorkspaceBookmark>

const WorkspaceFolderFileSchema = z.object({
  root: z.string().min(1),
  path: z.string().min(1),
})

const RenameWorkspaceFolderFileSchema = WorkspaceFolderFileSchema.extend({
  name: z.string()
    .trim()
    .min(1)
    .max(255)
    .refine(
      name => name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !name.includes('\0'),
      'Invalid file name',
    ),
})

const MAX_FOLDER_ENTRIES = 1_000

class WorkspaceFolderAccessError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message)
  }
}

/** The container spelling of a workspace path the actor resolved (`''` is the root). */
function toContainerPath(workspacePath: string): string {
  return workspacePath === '' ? '/workspace' : `/workspace/${workspacePath}`
}

function normalizeWorkspaceContainerPath(rawPath: string): string | null {
  if (!rawPath.startsWith('/') || rawPath.includes('\0')) return null
  const normalizedPath = path.posix.normalize(rawPath)
  const normalized = normalizedPath === '/' ? normalizedPath : normalizedPath.replace(/\/+$/, '')
  if (normalized !== '/workspace' && !normalized.startsWith('/workspace/')) return null
  return normalized
}

function isContainerPathWithin(basePath: string, candidatePath: string): boolean {
  const relative = path.posix.relative(basePath, candidatePath)
  return relative === '' || (!relative.startsWith('../') && relative !== '..' && !path.posix.isAbsolute(relative))
}

const BOOKMARKS_FILE = 'bookmarks.json'

async function readWorkspaceBookmarks(agentSlug: string): Promise<WorkspaceBookmark[]> {
  const bytes = await agentRegistry.get(agentSlug).files.getDoc(BOOKMARKS_FILE).catch(() => null)
  if (!bytes || bytes.byteLength === 0) return []
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes))
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry): WorkspaceBookmark[] => {
      const result = WorkspaceBookmarkSchema.safeParse(entry)
      return result.success ? [result.data] : []
    })
  } catch {
    return []
  }
}

function workspaceFolderFsError(error: unknown): WorkspaceFolderAccessError | null {
  if (error instanceof WorkspaceFileError) {
    if (error.status === 400) return new WorkspaceFolderAccessError('Invalid folder path', 400)
    if (error.status === 403) return new WorkspaceFolderAccessError('Folder is not accessible', 403)
    return new WorkspaceFolderAccessError('Folder or file not found', 404)
  }
  const code = error instanceof Error && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new WorkspaceFolderAccessError('Folder or file not found', 404)
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new WorkspaceFolderAccessError('Folder is not accessible', 403)
  }
  return null
}

async function resolveBookmarkedWorkspacePath(
  agentSlug: string,
  rawRoot: string,
  rawCurrentPath: string,
) {
  const rootPath = normalizeWorkspaceContainerPath(rawRoot)
  const currentPath = normalizeWorkspaceContainerPath(rawCurrentPath)
  if (!rootPath || !currentPath || !isContainerPathWithin(rootPath, currentPath)) {
    throw new WorkspaceFolderAccessError('Invalid folder path', 400)
  }

  // The full workspace is the built-in Agent Directory root. All other roots
  // remain bookmark-gated so an arbitrary nested path cannot be promoted into
  // a browser root by a client request alone.
  if (rootPath !== '/workspace') {
    const bookmarks = await readWorkspaceBookmarks(agentSlug)
    const isBookmarkedRoot = bookmarks.some(bookmark => (
      bookmark.folder != null && normalizeWorkspaceContainerPath(bookmark.folder) === rootPath
    ))
    if (!isBookmarkedRoot) {
      throw new WorkspaceFolderAccessError('Folder bookmark not found', 404)
    }
  }

  // Both are container paths (`/workspace/…`), which the actor's file
  // operations accept as workspace paths; containment against the workspace
  // itself is theirs to enforce. What the actor cannot know is the bookmark
  // root: a link inside the shared sub-tree that points elsewhere in the
  // workspace would widen what a viewer can reach. So the check is on where
  // the two really are, as it always was: the entry's real location has to
  // stay under the root's, which lets a link that stays inside the shared
  // tree be browsed and refuses one that leaves it. An escaping link is the
  // same 400 it always was.
  const files = agentRegistry.get(agentSlug).files
  let stat: FileStat | null
  try {
    // The workspace root is where it is; only a bookmarked sub-tree can itself
    // sit behind a link, so only that root is resolved.
    const rootResolved = rootPath === '/workspace' ? '' : await files.resolve(rootPath)
    const resolved = await files.resolve(currentPath)
    if (resolved !== null && (rootResolved === null || !isContainerPathWithin(toContainerPath(rootResolved), toContainerPath(resolved)))) {
      throw new WorkspaceFolderAccessError('Invalid folder path', 400)
    }
    stat = resolved === null ? null : await files.stat(resolved)
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      throw new WorkspaceFolderAccessError(error.status === 400 ? 'Invalid folder path' : error.message, error.status)
    }
    throw error
  }

  return { rootPath, currentPath, stat }
}

/**
 * The same, for an operation on the entry itself. The rename and delete are
 * carried out by the container, which has to be running for it; a path with
 * nothing at it is answered here first, so a stale browser acting on an
 * entry that is already gone does not start the container for nothing.
 */
async function resolveBookmarkedWorkspaceEntry(
  agentSlug: string,
  rawRoot: string,
  rawPath: string,
): Promise<{ rootPath: string; currentPath: string; stat: FileStat }> {
  const resolved = await resolveBookmarkedWorkspacePath(agentSlug, rawRoot, rawPath)
  if (!resolved.stat) {
    throw new WorkspaceFolderAccessError('Folder or file not found', 404)
  }
  return { ...resolved, stat: resolved.stat }
}

async function requestContainerWorkspaceMutation<T>(
  agentSlug: string,
  method: 'PATCH' | 'DELETE',
  body: {
    path: string
    type: 'file' | 'directory'
    name?: string
  },
): Promise<T> {
  await agentRegistry.get(agentSlug).container.start()
  const response = await agentRegistry.get(agentSlug).container.fetch('/workspace/entries', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null) as (T & { error?: string }) | null
  if (!response.ok) {
    const message = payload?.error ?? 'Workspace operation failed'
    if (response.status === 400 || response.status === 404 || response.status === 409) {
      throw new WorkspaceFolderAccessError(message, response.status)
    }
    throw new Error(message)
  }
  if (!payload) throw new Error('Workspace operation returned an invalid response')
  return payload
}

function getConfiguredSkillsets() {
  return getSettings().skillsets || []
}

function toSkillsetRef(config: Pick<SkillsetConfig, 'id' | 'url' | 'name' | 'provider' | 'providerData'>) {
  const provider = getSkillsetProvider(config.provider)
  return {
    skillsetId: config.id,
    skillsetUrl: config.url,
    provider: config.provider,
    skillsetName: config.name,
    providerData: provider.normalizeProviderData(config),
  }
}

const strictBooleanQuerySchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')

const positiveIntegerQuerySchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .refine((value) => Number.isSafeInteger(value))

const sessionsListQuerySchema = z.object({
  sortBy: z.literal('last_activity_at').optional(),
  notable: strictBooleanQuerySchema.optional(),
  limit: positiveIntegerQuerySchema.optional(),
})

const agentsListQuerySchema = z.object({
  includeLatestVisibleSessionTail: strictBooleanQuerySchema.optional(),
})

// Agent-list hydration only needs enough recent display items to derive a
// preview. Keep both item count and raw tail window far below the chat page
// limits because this cost is multiplied by the number of agents.
const LATEST_VISIBLE_SESSION_TAIL_LIMIT = 20
const LATEST_VISIBLE_SESSION_TAIL_BYTE_BUDGET = 256 * 1024

interface AgentSummaryOptions {
  includeLatestVisibleSessionTail?: boolean
  signal?: AbortSignal
  /**
   * Acting user, for the per-user half of the unread projection. REQUIRED, and
   * deliberately not defaulted: a caller that forgot it would silently drop
   * marks from the rollup — a dot that quietly stops appearing, with nothing
   * failing. `getCurrentUserId(c)` always yields one (the `'local'` sentinel
   * outside auth mode), so there is no caller that legitimately lacks it.
   */
  userId: string
}

function attentionSessionCountsOutsideLatest(
  sessionId: string,
  latestSessionId: string | undefined,
  visibleSessionIds: Set<string>,
  sessionMetadata: SessionMetadataMap,
): boolean {
  if (sessionId === latestSessionId) return false
  if (visibleSessionIds.has(sessionId)) return true

  // An ID absent from the visible snapshot is either confirmed-hidden or
  // unresolved (for example a just-created or stale attention source). Only a
  // metadata-confirmed hidden automation is safe to ignore. Unknown ordinary
  // and promoted sessions conservatively count as outside.
  return !isHiddenAutomatedSession(sessionMetadata[sessionId])
}

async function getAttentionOutsideLatest(
  agentSlug: string,
  visibleSessions: SessionInfo[],
  unreadSessionIds: Set<string>,
  sessionMetadata: SessionMetadataMap,
): Promise<NonNullable<ApiAgent['attentionOutsideLatest']>> {
  const latestSessionId = visibleSessions[0]?.id
  const visibleSessionIds = new Set(visibleSessions.map((session) => session.id))
  const countsOutside = (sessionId: string) => attentionSessionCountsOutsideLatest(
    sessionId,
    latestSessionId,
    visibleSessionIds,
    sessionMetadata,
  )

  const hasUnreadNotification = [...unreadSessionIds].some(countsOutside)

  const live = await agentRegistry.get(agentSlug).live()
  // The registry is authoritative for open requests and exposes explicit
  // session attribution when it exists. Agent-scoped requests have no unique
  // session, so they must conservatively count as outside latest. The live
  // sessions' own projection covers recovered/racing state, and lets hidden
  // sessions be classified without ever returning their IDs.
  const hasPendingInput =
    live.openRequests.some((request) =>
      request.blocking && !request.autoApproved && (request.sessionId === undefined || countsOutside(request.sessionId))) ||
    live.awaitingSessionIds.some(countsOutside)

  return { hasUnreadNotification, hasPendingInput }
}

async function getLatestVisibleSessionTail(
  agentSlug: string,
  session: SessionInfo,
  unreadSessionIds: Set<string>,
  sessionMetadata: SessionMetadataMap,
  signal?: AbortSignal,
): Promise<NonNullable<ApiAgent['latestVisibleSession']>> {
  const actor = agentRegistry.get(agentSlug)
  // KNOWN RESIDUAL (accepted, out of scope): `session` comes from the listing,
  // which drops symlinked transcripts by dirent type but still readdir's THROUGH
  // a symlinked ancestor directory (e.g. an agent that replaced its own
  // `-workspace` with a link to another agent's). This read would then follow
  // that link and surface a stranger's tail on the agent's own home card. It is
  // NOT gated with the realpath check the direct content routes use, because
  // that costs an fs op on the exactly-pinned home/agents perf budgets. The
  // vector is narrow (self-destructive: it breaks the attacker's own agent, and
  // exposes only the latest tail via their own home). Direct-id content routes
  // (messages, media, raw-log, usage, single-session, subagent) ARE covered by
  // sessionFileRealPathWithinAgent; closing this path means gating the read here
  // and re-recording those budgets.
  signal?.throwIfAborted()
  // Read first, check existence only if the read came back empty: the page
  // reader answers a missing transcript with an empty page, so the common
  // case (a transcript with messages) costs no stat at all.
  const messageTail = await actor.messages.page(session.id, {
    limit: LATEST_VISIBLE_SESSION_TAIL_LIMIT,
    byteBudget: LATEST_VISIBLE_SESSION_TAIL_BYTE_BUDGET,
    media: 'ref',
    signal,
  })
  signal?.throwIfAborted()
  // A registered session with no transcript yet (created, nothing streamed) is
  // a normal state and serves an empty tail. Only an id with neither a
  // transcript nor a registration — a session that vanished after listing —
  // is an error. Registration is answered from the metadata map already in
  // hand; the stat runs only for an unregistered empty tail.
  if (
    messageTail.messages.length === 0 &&
    !(Object.hasOwn(sessionMetadata, session.id) && sessionMetadata[session.id]?.createdAt) &&
    !(await actor.sessions.exists(session.id))
  ) {
    throw new Error(
      'Latest visible session transcript not found for ' + agentSlug + '/' + session.id,
    )
  }
  // Same treatment as the transcript page endpoint, so the tail matches what
  // opening the session shows. Must run before the session flags below so
  // recovered awaiting-input state is reflected in them.
  await annotateAndRecoverMessages(messageTail.messages, agentSlug, session.id)
  signal?.throwIfAborted()
  const live = await actor.sessions.live(session.id)

  return {
    session: {
      ...session,
      isActive: live.isActive,
      isAwaitingInput: live.isAwaitingInput,
      hasUnreadNotifications: unreadSessionIds.has(session.id),
    },
    messageTail,
  }
}

interface AgentVisibleSessionExpansion {
  latestVisibleSession: ApiAgent['latestVisibleSession']
  attentionOutsideLatest: ApiAgent['attentionOutsideLatest']
}

async function getVisibleSessionExpansion(
  agentSlug: string,
  unreadSessionIds: Set<string>,
  sessionMetadataPromise: Promise<SessionMetadataMap>,
  signal?: AbortSignal,
): Promise<AgentVisibleSessionExpansion> {
  let visibleSessions: SessionInfo[]
  let sessionMetadata: SessionMetadataMap
  try {
    // Keep the complete visibility-filtered snapshot: its first item selects
    // latest, while the remaining metadata-only items answer the two attention
    // booleans without loading older transcripts. Built from the summary
    // cache with the metadata map the caller already read, so a warm poll
    // costs one directory stat per agent instead of one stat per transcript.
    sessionMetadata = await sessionMetadataPromise
    visibleSessions = await agentRegistry.get(agentSlug).sessions.listFromSummary({
      metadata: sessionMetadata,
      excludeAutomated: true,
      sortBy: 'last_activity_at',
    })
  } catch (error) {
    if (signal?.aborted) throw error
    console.error('Failed to select latest visible session for agent ' + agentSlug + ':', error)
    captureException(error, {
      tags: { component: 'agents', operation: 'latest-visible-session-selection' },
      extra: { agentSlug },
    })
    return { latestVisibleSession: null, attentionOutsideLatest: null }
  }

  const latestSession = visibleSessions[0]

  let attentionOutsideLatest: ApiAgent['attentionOutsideLatest']
  try {
    attentionOutsideLatest = await getAttentionOutsideLatest(
      agentSlug,
      visibleSessions,
      unreadSessionIds,
      sessionMetadata,
    )
  } catch (error) {
    if (signal?.aborted) throw error
    console.error('Failed to compute attention outside latest for agent ' + agentSlug + ':', error)
    captureException(error, {
      tags: { component: 'agents', operation: 'attention-outside-latest' },
      extra: { agentSlug },
    })
    attentionOutsideLatest = null
  }

  const latestVisibleSession = latestSession
    ? await getLatestVisibleSessionTail(agentSlug, latestSession, unreadSessionIds, sessionMetadata, signal)
        .catch((error): null => {
          if (signal?.aborted) throw error
          // Attention still excludes this session as latest, so on this path
          // its own unread/pending is reported nowhere until the next poll.
          console.error(
            'Failed to fetch latest visible session tail for agent ' + agentSlug + ':',
            error,
          )
          captureException(error, {
            tags: { component: 'agents', operation: 'latest-visible-session-tail' },
            extra: { agentSlug },
          })
          return null
        })
    : null

  return { latestVisibleSession, attentionOutsideLatest }
}

/**
 * Enrich an array of ApiAgent objects with summary fields:
 * active/awaiting sessions, last activity, and dashboards.
 * Batch notification lookup upfront, then parallelize per-agent FS operations.
 */
async function enrichAgentsWithSummary(
  agents: ApiAgent[],
  options: AgentSummaryOptions,
): Promise<ApiAgent[]> {
  const slugs = agents.map(a => a.slug)

  // Both halves of the unread projection, one query each rather than one per
  // agent — this route hydrates every agent on every poll.
  const [unreadByAgent, markedUnreadByAgent, mentionsByAgent] = await Promise.all([
    getUnreadNotificationsByAgents(slugs, options.userId),
    getSessionIdsMarkedUnreadByAgents(slugs, options.userId),
    // Only auth mode has people to mention.
    isAuthMode() ? getUnreadMentionsByAgents(slugs, options.userId) : new Map<string, Set<string>>(),
  ])

  const limit = pLimit(5)
  return Promise.all(
    agents.map((agent) => limit(async () => {
      // Union of the two sources, so every projection below sees one set.
      const notifiedIds = unreadByAgent.get(agent.slug) ?? new Set<string>()
      const markedIds = markedUnreadByAgent.get(agent.slug) ?? new Set<string>()
      const mentionedIds = mentionsByAgent.get(agent.slug) ?? new Set<string>()
      const unreadSessionIds = markedIds.size === 0
        ? notifiedIds
        : new Set<string>([...notifiedIds, ...markedIds])
      const actor = agentRegistry.get(agent.slug)
      const sessionMetadataPromise = actor.sessions.readMetadata()
      const visibleSessionExpansionPromise = options.includeLatestVisibleSessionTail
        ? getVisibleSessionExpansion(
            agent.slug,
            unreadSessionIds,
            sessionMetadataPromise,
            options.signal,
          )
        : Promise.resolve(undefined)

      // Only FS operations remain per-agent (parallelized and bounded by the
      // outer p-limit).
      const [sessionSummary, { dashboards: artifacts, widgets }, sessionMetadata, visibleSessionExpansion] =
        await Promise.all([
          actor.sessions.summary(),
          // Dashboards and widgets are two halves of the same artifacts, read
          // in one scan: listing them separately doubled the manifest reads.
          listArtifactsAndWidgets(agent.slug),
          sessionMetadataPromise,
          visibleSessionExpansionPromise,
        ])

      // Compute session flags from in-memory state (no I/O needed).
      // `unreadByAgent` is already filtered to user-actionable notification types
      // (session_complete / session_waiting). Unread notifications on hidden
      // automated sessions are skipped: those sessions are excluded from every
      // session list (`excludeAutomated`), so a flag raised by them would show
      // an unread indicator with nothing visible behind it — and no way to ever
      // clear it. (Legacy rows exist from before creation-time suppression;
      // session_waiting now promotes the session first, but old rows remain.)
      let hasUnreadNotifications = false
      // An unread notification that tags the viewer: drawn as an @, not a dot.
      let hasUnreadMention = false
      for (const sessionId of sessionSummary.sessionIds) {
        if (unreadSessionIds.has(sessionId) && !isHiddenAutomatedSession(sessionMetadata[sessionId])) {
          hasUnreadNotifications = true
          if (mentionedIds.has(sessionId)) hasUnreadMention = true
        }
      }
      // Live state covers sessions not yet on the filesystem too (a new
      // session whose .jsonl is not written yet). Pending proxy reviews raise
      // the flag regardless of session state: dashboard-triggered reviews have
      // no session but still need the user.
      const live = await agentRegistry.get(agent.slug).live()
      const hasActiveSessions = live.activeSessionIds.length > 0
      const hasSessionsAwaitingInput = live.awaitingSessionIds.length > 0 || live.pendingReviews.length > 0

      return {
        ...agent,
        hasActiveSessions,
        hasSessionsAwaitingInput,
        hasUnreadNotifications,
        hasUnreadMention,
        sessionCount: sessionSummary.sessionCount,
        lastActivityAt: sessionSummary.lastActivityAt,
        dashboards: artifacts.map((a) => ({
          slug: a.slug,
          name: a.name || a.slug,
          ...(a.hasScreenshot ? { hasScreenshot: true } : {}),
        })),
        widgets: await widgetRefreshService.decorate(agent.slug, widgets),
        ...(options.includeLatestVisibleSessionTail
          ? {
              latestVisibleSession: visibleSessionExpansion?.latestVisibleSession ?? null,
              attentionOutsideLatest:
                visibleSessionExpansion?.attentionOutsideLatest ?? null,
            }
          : {}),
      }
    }))
  )
}

/**
 * Square the transcript's open tool calls with the session's requests.
 *
 * Parallel tool calls hold every sibling's transcript result until the LAST
 * one resolves, so a request the user already decided still looks
 * unresolved here: its outcome is stamped on, so every history consumer (the
 * client's refresh fallback, the transcript card) sees a completed call
 * instead of resurrecting a decided one. And while the session runs, the
 * blocking asks of its trailing turn nobody decided are parked again: if the
 * request's own stream event was missed, the persisted messages are the
 * fallback source of truth. A stale transcript can briefly re-assert awaiting
 * input, but the next stream result/idle event clears it.
 */
async function reconcileOpenToolCalls(items: TransformedItem[], agentSlug: string, sessionId: string): Promise<void> {
  const open: Array<{ toolCall: { id: string; name: string; result?: unknown }; awaitsInput: boolean }> = []
  let trailingTurn = true
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.type === 'user' && !item.queued) trailingTurn = false
    if (item.type !== 'assistant') continue
    for (const toolCall of item.toolCalls) {
      if (toolCall.result !== undefined) continue
      open.push({ toolCall, awaitsInput: trailingTurn && isBlockingUserInputToolName(toolCall.name) })
    }
  }
  if (open.length === 0) return
  const { settled } = await agentRegistry.get(agentSlug).sessions.reconcileTranscript(
    sessionId,
    open.map(({ toolCall, awaitsInput }) => ({ toolUseId: toolCall.id, toolName: toolCall.name, awaitsInput })),
  )
  for (const { toolCall } of open) {
    const outcome = settled[toolCall.id]
    if (outcome !== undefined) toolCall.result = outcome === 'answered' ? 'User provided input' : 'User declined the request'
  }
}

/**
 * For interrupted Task tool calls (no result), discover the subagent ID
 * by scanning the subagents directory so the UI can still show subagent messages.
 */
export async function resolveInterruptedSubagents(
  items: TransformedItem[],
  agentSlug: string,
  sessionId: string
): Promise<void> {
  // Collect Task tool calls, separating resolved from unresolved
  const resolvedAgentIds = new Set<string>()
  const unresolvedTaskCalls: TransformedMessage['toolCalls'][number][] = []

  for (const item of items) {
    if (item.type !== 'assistant') continue
    const msg = item as TransformedMessage
    for (const tc of msg.toolCalls) {
      if (tc.name !== 'Task' && tc.name !== 'Agent') continue
      if (tc.subagent?.agentId) {
        resolvedAgentIds.add(tc.subagent.agentId)
      } else {
        unresolvedTaskCalls.push(tc)
      }
    }
  }

  if (unresolvedTaskCalls.length === 0) return

  // The subagent sidecars carry the toolUseId that launched each one. The
  // subagents already resolved are not read: an already-completed one must
  // not be re-marked cancelled, and its sidecar is one read saved.
  const subagents = await agentRegistry.get(agentSlug).sessions.subagents(sessionId, { except: resolvedAgentIds })

  // Build toolUseId → agentId map (deterministic, no FIFO)
  const toolUseToAgentId = new Map<string, string>()
  for (const { id, toolUseId } of subagents) {
    if (!toolUseId) continue
    toolUseToAgentId.set(toolUseId, id)
  }

  // Match unresolved Task calls by toolUseId (deterministic)
  for (const tc of unresolvedTaskCalls) {
    const agentId = toolUseToAgentId.get(tc.id)
    if (agentId) {
      tc.subagent = { agentId, status: 'cancelled' }
    }
  }
}

const agents = new Hono()

agents.use('*', Authenticated())

// Collection roster reads must be mounted before /:id/* resolution.
agents.route('/members/batch', agentMembersBatch)

// ============================================================
// Routes that must be registered BEFORE /:id middleware
// (paths like /import-template would otherwise match as :id)
// ============================================================

// POST /api/agents/import-template - Import agent from uploaded ZIP
// Supports both single-request (file field) and chunked upload (chunk field)
agents.post('/import-template', async (c) => {
  try {
    const formData = await c.req.formData()

    // Check if this is a chunked upload
    const chunk = formData.get('chunk') as File | null
    if (chunk) {
      return await handleChunkedImport(c, formData, chunk)
    }

    // Legacy single-request upload
    const file = formData.get('file') as File | null
    if (!file) {
      return c.json({ error: 'No file or chunk provided' }, 400)
    }

    if (file.size > MAX_COMPRESSED_SIZE) {
      return c.json({ error: formatUploadTooLargeMessage(file.size, MAX_COMPRESSED_SIZE) }, 413)
    }

    const arrayBuffer = await file.arrayBuffer()
    const zipBuffer = Buffer.from(arrayBuffer)

    return await processImport(c, zipBuffer, formData)
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      return c.json({ error: error.message }, 413)
    }
    const message = error instanceof Error ? error.message : 'Failed to import template'
    console.error('Failed to import template:', error)
    captureException(error, { tags: { component: 'agents', operation: 'import-template' } })
    return c.json({ error: message }, 500)
  }
})

type ParsedChunkFields =
  | { ok: true; uploadId: string; chunkIndex: number; totalChunks: number }
  | { ok: false; error: string }

// Validate the chunked-upload metadata fields shared by import-template and
// upload-file. Keeps the three routes thin and the validation in one place.
function parseChunkFields(formData: FormData): ParsedChunkFields {
  const uploadId = formData.get('uploadId') as string | null
  const chunkIndexStr = formData.get('chunkIndex') as string | null
  const totalChunksStr = formData.get('totalChunks') as string | null

  if (!uploadId || chunkIndexStr === null || totalChunksStr === null) {
    return { ok: false, error: 'Missing chunked upload fields: uploadId, chunkIndex, totalChunks' }
  }
  // uploadId becomes a directory name — UUID only, prevents path traversal
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) {
    return { ok: false, error: 'Invalid uploadId format' }
  }

  const chunkIndex = parseInt(chunkIndexStr, 10)
  const totalChunks = parseInt(totalChunksStr, 10)
  if (isNaN(chunkIndex) || isNaN(totalChunks) || chunkIndex < 0 || totalChunks < 1 || chunkIndex >= totalChunks || totalChunks > 200) {
    return { ok: false, error: 'Invalid chunkIndex or totalChunks' }
  }

  return { ok: true, uploadId, chunkIndex, totalChunks }
}

async function handleChunkedImport(c: Context, formData: FormData, chunk: File) {
  const parsed = parseChunkFields(formData)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  const result = await storeUploadChunk(
    parsed.uploadId,
    parsed.chunkIndex,
    parsed.totalChunks,
    Buffer.from(await chunk.arrayBuffer()),
    MAX_COMPRESSED_SIZE,
  )

  if (result.status === 'received') {
    return c.json({ status: 'chunk_received', chunkIndex: parsed.chunkIndex })
  }

  try {
    const size = (await fs.promises.stat(result.filePath)).size
    if (size > MAX_COMPRESSED_SIZE) {
      return c.json({ error: formatUploadTooLargeMessage(size, MAX_COMPRESSED_SIZE) }, 413)
    }
    // The assembled upload is already on disk — import straight from the file
    // instead of pinning the whole (up to 500MB) ZIP in memory.
    return await processImport(c, { filePath: result.filePath }, formData)
  } finally {
    try {
      await fs.promises.unlink(result.filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn('[agents] failed to unlink assembled import upload:', err)
        captureException(err, {
          tags: { component: 'agents', operation: 'unlink-assembled-import' },
          extra: { filePath: result.filePath },
        })
      }
    }
  }
}

async function processImport(c: Context, zip: TemplateZipSource, formData: FormData) {
  // File sources are size-checked by the caller via stat before reaching here.
  if (Buffer.isBuffer(zip) && zip.length > MAX_COMPRESSED_SIZE) {
    return c.json({ error: formatUploadTooLargeMessage(zip.length, MAX_COMPRESSED_SIZE) }, 413)
  }

  const nameOverride = formData.get('name') as string | null
  const mode = formData.get('mode') as string | null
  const importMode = mode === 'full' ? 'full' : 'template'

  const agent = await importAgentFromTemplate(zip, nameOverride || undefined, importMode)
  await createOwnerAclOrRollback(c, agent.slug)
  const [onboarding, templatePrompt] = await Promise.all([
    hasOnboardingSkill(agent.slug),
    getAgentTemplatePrompt(agent.slug),
  ])
  await logAuditEvent({ userId: getCurrentUserId(c), object: 'agent', objectId: agent.slug, action: 'imported', details: { name: agent.name } })
  return c.json({
    ...agent,
    hasOnboarding: onboarding.hasOnboarding,
    templatePrompt,
    onboardingFirstPrompt: onboarding.firstPrompt,
  }, 201)
}

// GET /api/agents/discoverable-agents - List agents available from skillsets
// Uses ?refresh=true to force a cache refresh before reading
agents.get('/discoverable-agents', async (c) => {
  try {
    const skillsets = getConfiguredSkillsets()
    const shouldRefresh = c.req.query('refresh') === 'true'

    if (shouldRefresh) {
      await refreshSkillsetCaches(skillsets)
    }

    const discoverableAgents = await getDiscoverableAgents(skillsets)
    return c.json({ agents: discoverableAgents })
  } catch (error) {
    console.error('Failed to fetch discoverable agents:', error)
    return c.json({ error: 'Failed to fetch discoverable agents' }, 500)
  }
})

// GET /api/agents/export-status — host-wide; registered before /:id
agents.get('/export-status', (c) => {
  return c.json({ inProgress: isHostExportBusy() })
})

// POST /api/agents/install-from-skillset - Install agent from skillset
agents.post('/install-from-skillset', async (c) => {
  try {
    const { skillsetId, agentPath, agentName, agentVersion } = await c.req.json()

    if (!skillsetId || !agentPath) {
      return c.json({ error: 'skillsetId and agentPath are required' }, 400)
    }

    const config = getConfiguredSkillsets().find(s => s.id === skillsetId)
    if (!config) {
      return c.json({ error: 'Skillset not found' }, 404)
    }

    const agent = await installAgentFromSkillset(
      toSkillsetRef(config),
      agentPath,
      agentName || agentPath,
      agentVersion || '0.0.0',
    )

    await createOwnerAclOrRollback(c, agent.slug)
    const [onboarding, templatePrompt] = await Promise.all([
      hasOnboardingSkill(agent.slug),
      getAgentTemplatePrompt(agent.slug),
    ])
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'agent', objectId: agent.slug, action: 'imported', details: { name: agent.name, skillsetId } })
    return c.json({
      ...agent,
      hasOnboarding: onboarding.hasOnboarding,
      templatePrompt,
      onboardingFirstPrompt: onboarding.firstPrompt,
    }, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to install agent from skillset'
    console.error('Failed to install agent from skillset:', error)
    return c.json({ error: message }, 500)
  }
})

// GET /api/agents/my-roles - Get current user's roles on all agents (with member counts)
agents.get('/my-roles', async (c) => {
  try {
    if (!isAuthMode()) {
      return c.json({ roles: {} })
    }
    const userId = getCurrentUserId(c)

    // Get user's roles
    const rows = await db
      .select({ agentSlug: agentAcl.agentSlug, role: agentAcl.role })
      .from(agentAcl)
      .where(eq(agentAcl.userId, userId))

    if (rows.length === 0) {
      return c.json({ roles: {} })
    }

    // Get member counts for those agents in one query
    const slugs = rows.map((r) => r.agentSlug)
    const counts = await db
      .select({ agentSlug: agentAcl.agentSlug, memberCount: count() })
      .from(agentAcl)
      .where(inArray(agentAcl.agentSlug, slugs))
      .groupBy(agentAcl.agentSlug)

    const countMap = new Map(counts.map((c) => [c.agentSlug, c.memberCount]))

    const roles: Record<string, { role: string; memberCount: number }> = {}
    for (const row of rows) {
      roles[row.agentSlug] = {
        role: row.role,
        memberCount: countMap.get(row.agentSlug) ?? 1,
      }
    }
    return c.json({ roles })
  } catch (error) {
    console.error('Failed to fetch agent roles:', error)
    return c.json({ error: 'Failed to fetch agent roles' }, 500)
  }
})

// POST /api/agents/generate-name - Generate an agent name and one-line description from a prompt using a lightweight LLM
// Collection-level route: keep this before the /:id/* agent-existence middleware.
// TODO: Migrate remaining route handlers to use zValidator for consistent request validation
const generateNameBodySchema = z.object({
  prompt: z.string().min(1, 'Prompt is required'),
})

// The prompts ask for a short name, but a chatty model can answer with prose
// anyway (the old max_tokens: 50 doubled as a truncator); clamp to one line
// and a sidebar-sized length before using it.
function clampGeneratedName(raw: string): string {
  return raw.split('\n')[0].trim().substring(0, AGENT_NAME_MAX_LENGTH)
}

agents.post('/generate-name', zValidator('json', generateNameBodySchema), async (c) => {
  try {
    const { prompt } = c.req.valid('json')
    const truncatedPrompt = prompt.trim().substring(0, 10_000)

    const anthropic = await getLlmClient()
    const raw = (
      await createSummarizerText(anthropic, {
        model: getSummarizerModel(),
        messages: [
          {
            role: 'user',
            content: `Based on what the user wants an agent to do, write two lines:
Line 1: a short, descriptive agent name (2-4 words max).
Line 2: one sentence (under 20 words) saying what the agent is for.

The user's description is:

"${truncatedPrompt}"

Respond with ONLY those two lines. No labels, no quotes, no explanation.`,
          },
        ],
      })
    )?.trim()
    const [nameLine, descriptionLine] = (raw ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
    const name = nameLine ? clampGeneratedName(nameLine) : undefined
    if (!name) {
      return c.json({ error: 'Failed to generate name' }, 500)
    }
    const description = descriptionLine?.substring(0, AGENT_DESCRIPTION_MAX_LENGTH)

    return c.json(description ? { name, description } : { name })
  } catch (error) {
    console.error('Failed to generate agent name:', error)
    return c.json({ error: 'Failed to generate name' }, 500)
  }
})

// Middleware: resolve the :id param (display slug / bare id / legacy compound)
// to the canonical agent id for all /:id/* routes, stashing it for getAgentId(c).
// 404s if it doesn't resolve — subsumes the old existence check.
agents.use('/:id/*', ResolveAgent())

// Create owner ACL entry when an agent is created in auth mode
async function createOwnerAcl(c: Context, agentSlug: string) {
  if (!isAuthMode()) return
  const userId = getCurrentUserId(c)
  await db.insert(agentAcl).values({
    id: randomUUID(),
    userId,
    agentSlug,
    role: 'owner',
    createdAt: new Date(),
  })
  // Notification streams load the user's agents when they open; this tells
  // the creator's open streams to load again, so the new agent's events reach them.
  globalFeed.publish({ type: 'agent_created', agentSlug })
}

// Insert the owner ACL for a just-created agent, rolling back the on-disk
// workspace if the ACL write fails. Agent creation writes the workspace
// (directory + AGENTS.md) before the ACL row exists; without this, a transient
// ACL insert failure would return 500 but leave an orphaned agent directory
// with no owner ACL (SUP-207). The cleanup is best-effort and guarded so a
// failed rollback never masks the original error. In non-auth mode
// createOwnerAcl is a no-op, so this never rolls back there.
async function createOwnerAclOrRollback(c: Context, agentSlug: string) {
  try {
    await createOwnerAcl(c, agentSlug)
  } catch (error) {
    const userId = getCurrentUserId(c)
    let rolledBack = true
    try {
      await deleteAgent(agentSlug)
    } catch (cleanupError) {
      // Rollback failed: the agent workspace is now orphaned (exists on disk with
      // no owner ACL). This is the worst case and needs operator attention, so
      // report it as a distinct error (the original ACL failure is reported below).
      rolledBack = false
      console.error(`Failed to roll back orphaned agent workspace "${agentSlug}" after owner ACL insert failed:`, cleanupError)
      captureException(cleanupError, {
        tags: { component: 'agents', operation: 'owner-acl-rollback' },
        extra: { agentSlug, userId, originalError: error instanceof Error ? error.message : String(error) },
        level: 'error',
      })
    }
    // Report the ACL insert failure itself. A clean rollback is a recovered
    // failure (warning); a failed rollback left an orphan behind (error).
    captureException(error, {
      tags: { component: 'agents', operation: 'owner-acl-insert' },
      extra: { agentSlug, userId, rolledBack },
      level: rolledBack ? 'warning' : 'error',
    })
    throw error
  }
}

// Create LLM client using the active provider
async function getLlmClient(): Promise<Anthropic> {
  return await getConfiguredLlmClient()
}

// Model used for generating session names (lightweight task).
// Resolve here because this is a host-direct SDK call (no container chokepoint).
function getSummarizerModel(): string {
  return resolveActiveProviderModel(getEffectiveModels().summarizerModel, 'summarizer')
}

/**
 * Name a session opened by a system notice (voice mode started from the
 * agent home) from the first message a person sends to it. The notice must
 * not name the session; the agent remembers which sessions wait for this
 * (`sessions.deferNaming`).
 */
async function nameSessionFromFirstHumanMessage(actor: AgentActor, sessionId: string, message: string, agentName: string): Promise<void> {
  if (isSystemMessageText(message) || !(await actor.sessions.takeDeferredNaming(sessionId))) return
  background(generateAndUpdateSessionNameAsync(actor.slug, sessionId, message, agentName).catch(console.error), { name: 'agents-route.generate-session-name' })
}

// Generate session name using AI (fire and forget)
async function generateAndUpdateSessionNameAsync(
  agentSlug: string,
  sessionId: string,
  firstMessage: string,
  agentName: string
): Promise<void> {
  // Named from what the person wrote, without the notes that tell the agent who it tags and that it was dictated.
  const message = parseMentions(parseDictationNote(firstMessage).cleanText).cleanText
  let sessionName: string | null = null
  // The E2E mock avoids all real provider calls — but this host-direct SDK
  // call bypassed it, so every test session made a doomed HTTPS round trip
  // (plus SDK retries) and logged an auth-error stack. Skip straight to the
  // truncated-message fallback below.
  const skipProviderNaming = process.env.E2E_MOCK === 'true'
  if (!skipProviderNaming) {
    try {
      const anthropic = await getLlmClient()
      sessionName = await createSummarizerText(anthropic, {
        model: getSummarizerModel(),
        messages: [
          {
            role: 'user',
            content: `Generate a short, descriptive session name (3-6 words max) for a conversation with an AI agent named "${agentName}". The first message in the conversation is:

"${message}"

Respond with ONLY the session name, nothing else. No quotes, no explanation.`,
          },
        ],
      })
    } catch (error) {
      console.error('Failed to generate session name after retries:', error)
    }
  }
  try {
    // Naming can fail outright (misconfigured summarizer model) or return no
    // text (thinking-first ruminators like small qwen burn the whole budget);
    // fall back to the truncated first message so the session is still
    // identifiable in the sidebar instead of staying "New Session".
    if (!sessionName && !skipProviderNaming) {
      console.warn(`Session name generation returned no text; falling back to truncated message for session ${sessionId}`)
    }
    const finalName = sessionName
      ? clampGeneratedName(sessionName)
      : message.trim().split(/\s+/).slice(0, 6).join(' ').substring(0, 60)
    if (finalName) {
      await agentRegistry.get(agentSlug).sessions.rename(sessionId, finalName)
      await agentRegistry.get(agentSlug).sessions.broadcastUpdate(sessionId)
    }
  } catch (error) {
    console.error('Failed to update session name:', error)
  }
}

// GET /api/agents - List agents with status (filtered by ACL in auth mode)
// Response includes pre-aggregated summary: session activity and dashboards.
// ?include_latest_visible_session_tail=true additionally returns one
// visibility-safe session and a small media-ref transcript page per agent.
agents.get('/', async (c) => {
  try {
    const includeTailRaw = c.req.query('include_latest_visible_session_tail')
    const parsedQuery = agentsListQuerySchema.safeParse({
      ...(includeTailRaw === undefined
        ? {}
        : { includeLatestVisibleSessionTail: includeTailRaw }),
    })
    if (!parsedQuery.success) {
      return c.json({ error: 'Invalid agent list query' }, 400)
    }

    // In auth mode, only return agents the user has explicit ACL entries for.
    // Note: Admins do NOT get implicit access to all agents in the listing.
    // This is intentional — admin privileges grant bypass access to individual
    // agent routes (via middleware), but agents must be explicitly shared with
    // admins for them to appear in the sidebar. This prevents admins from
    // seeing every agent in large deployments.
    let agentList: ApiAgent[]
    if (isAuthMode()) {
      const userId = getCurrentUserId(c)
      const rows = await db
        .select({ agentSlug: agentAcl.agentSlug })
        .from(agentAcl)
        .where(eq(agentAcl.userId, userId))
      // One catalog query for the visible slugs, newest first like the
      // non-auth listing, so a freshly created agent lands at the top of the
      // sidebar (the client's applyAgentOrder floats new agents up).
      agentList = await listAgentsWithStatus({ slugs: rows.map((r) => r.agentSlug) })
    } else {
      agentList = await listAgentsWithStatus()
    }

    return c.json(await enrichAgentsWithSummary(agentList, {
      includeLatestVisibleSessionTail:
        parsedQuery.data.includeLatestVisibleSessionTail === true,
      signal: c.req.raw.signal,
      userId: getCurrentUserId(c),
    }))
  } catch (error) {
    console.error('Failed to fetch agents:', error)
    return c.json({ error: 'Failed to fetch agents' }, 500)
  }
})

// POST /api/agents - Create a new agent (with owner ACL in auth mode)
agents.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const { name, description } = body

    if (!name?.trim()) {
      return c.json({ error: 'Name is required' }, 400)
    }

    const agent = await createAgent({
      name: name.trim(),
      description: description?.trim(),
    })

    await createOwnerAclOrRollback(c, agent.slug)

    await logAuditEvent({ userId: getCurrentUserId(c), object: 'agent', objectId: agent.slug, action: 'created', details: { name: name.trim() } })
    return c.json(agent, 201)
  } catch (error) {
    console.error('Failed to create agent:', error)
    return c.json({ error: 'Failed to create agent' }, 500)
  }
})

// GET /api/agents/:id - Get a single agent
agents.get('/:id', ResolveAgent(), AgentRead(), async (c) => {
  try {
    const slug = getAgentId(c)
    const agent = await getAgentWithStatus(slug, { includeSummary: false })

    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const [enriched] = await enrichAgentsWithSummary([agent], { userId: getCurrentUserId(c) })
    return c.json(enriched)
  } catch (error) {
    console.error('Failed to fetch agent:', error)
    return c.json({ error: 'Failed to fetch agent' }, 500)
  }
})

// PUT /api/agents/:id - Update an agent
agents.put('/:id', ResolveAgent(), AgentAdmin(), async (c) => {
  try {
    const slug = getAgentId(c)
    const body = await c.req.json()
    const { name, description, instructions } = body

    const agent = await updateAgent(slug, {
      name: name?.trim(),
      description: description?.trim(),
      instructions: instructions,
    })

    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const updatedFields = Object.keys(body).filter(k => body[k] !== undefined)
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'agent', objectId: slug, action: 'updated', details: { fields: updatedFields } })
    return c.json(agent)
  } catch (error) {
    console.error('Failed to update agent:', error)
    return c.json({ error: 'Failed to update agent' }, 500)
  }
})

// Appearance is shared agent metadata, with the same permission as renaming.
agents.put('/:id/avatar', ResolveAgent(), AgentAdmin(), zValidator('json', agentAvatarSchema), async (c) => {
  const slug = getAgentId(c)
  const avatar = await updateAgentAvatar(slug, c.req.valid('json'))
  if (!avatar) return c.json({ error: 'Agent not found' }, 404)
  await logAuditEvent({ userId: getCurrentUserId(c), object: 'agent', objectId: slug, action: 'updated', details: { fields: ['avatar'] } })
  globalFeed.publish({ type: 'agent_updated', agentSlug: slug })
  return c.json(avatar)
})

// DELETE /api/agents/:id - Delete an agent
agents.delete('/:id', ResolveAgent(), AgentAdmin(), async (c) => {
  try {
    const slug = getAgentId(c)

    // Existence check up front so we never start the destructive flow for a
    // missing agent. We rely on getAgent (not deleteAgent's return value)
    // because the irreversible workspace removal is deferred to the last step.
    const agentBeforeDelete = await getAgent(slug)
    if (!agentBeforeDelete) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    // The container is stopped, and its runtime forgotten, inside deleteAgent
    // below: forgetting it here first would leave the stop to a fresh runtime
    // while the old client's callbacks still pointed at the dropped one.

    // Clean up proxy token (best-effort — a revoked token is harmless on its own).
    try {
      await revokeProxyToken(slug)
    } catch (error) {
      console.error('Failed to revoke proxy token:', error)
    }

    // Clean up x-agent invoke policies referencing this agent (caller or target).
    await deletePoliciesForAgent(slug)

    // Turning Team Brain off: no other agent keeps reading a brain that no longer syncs. The drive and its files stay.
    const teamBrain = getTeamBrain()
    // Running agents drop it on their next start.
    if (teamBrain?.agentSlug === slug) for (const agent of await releaseVolume(teamBrain.volumeId, slug)) await afterMountChange(agent)

    // Clean up all peripheral data (triggers, integrations, tasks, ACLs, etc.).
    // This runs BEFORE the irreversible workspace removal: if any peripheral
    // cleanup throws, the route returns 500 with the workspace still intact, so
    // the delete is safely retryable instead of leaving orphaned rows pointing
    // at a workspace that no longer exists (SUP-208).
    await cleanupAgentData(slug)

    // Irreversible: remove the agent workspace directory. Done LAST so it only
    // happens once every peripheral cleanup above has succeeded.
    const deleted = await deleteAgent(slug)
    if (!deleted) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    // The Team Brain record names its agent; with the agent gone there is no Team Brain. Its drive stays.
    if (getTeamBrain()?.agentSlug === slug) mutateSettings((settings) => { delete settings.teamBrain })

    // Remove the agent's dedicated host-browser Chrome profile. The container
    // teardown above only stops the browser on the ACTIVE provider — a Chrome
    // launched before the user switched providers survives it — so stop this
    // agent's browser on every provider first. deleteBrowserProfile itself
    // refuses profiles claimed by an in-flight launch. Best-effort throughout:
    // a leftover dir is reclaimed by a later startup sweep.
    try {
      await stopInstanceOnAllProviders(slug)
      await deleteBrowserProfile(slug)
    } catch (error) {
      console.error('Failed to delete host-browser profile:', error)
    }

    await logAuditEvent({ userId: getCurrentUserId(c), object: 'agent', objectId: slug, action: 'deleted', details: { name: agentBeforeDelete.frontmatter.name } })
    return c.body(null, 204)
  } catch (error) {
    if (error instanceof AgentContainerStopError) {
      // SUP-209: the container couldn't be stopped, so deleteAgent aborted
      // before removing the workspace. The agent is preserved and the delete is
      // retryable — surface an actionable 409 instead of a generic 500. (The
      // peripheral cleanup above has already run; a retry once the container
      // un-wedges completes the deletion.)
      console.error('Agent deletion aborted — container stop failed:', error)
      return c.json(
        { error: "Couldn't stop the agent's container, so it wasn't deleted. It may be busy — please try again in a moment." },
        409
      )
    }
    console.error('Failed to delete agent:', error)
    return c.json({ error: 'Failed to delete agent' }, 500)
  }
})

// ============================================================
// Agent Preferences endpoints
// ============================================================

// GET /api/agents/:id/preferences - Get agent preferences
agents.get('/:id/preferences', AgentRead(), async (c) => {
  try {
    const slug = getAgentId(c)
    if (!(await agentExists(slug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }
    const prefs = await readAgentPreferences(slug)
    return c.json(prefs)
  } catch (error) {
    console.error('Failed to get agent preferences:', error)
    return c.json({ error: 'Failed to get agent preferences' }, 500)
  }
})

// PUT /api/agents/:id/preferences - Update agent preferences
agents.put('/:id/preferences', AgentAdmin(), async (c) => {
  try {
    const slug = getAgentId(c)
    if (!(await agentExists(slug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    const parsed = agentPreferencesUpdateSchema.safeParse(await c.req.json())
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const field = issue?.path.join('.') || 'body'
      return c.json({ error: `Invalid preferences: ${field}: ${issue?.message ?? 'invalid value'}` }, 400)
    }

    await assertConnectionSelectionAccess(parsed.data.defaultLlmProviderId, parsed.data.defaultLlmProviderId ? (await readAgentPreferences(slug)).defaultLlmProviderId : undefined)
    const merged = await updateAgentPreferences(slug, parsed.data)
    return c.json(merged)
  } catch (error) {
    if (error instanceof LlmProviderNotFoundError) return c.json({ error: error.message }, 404)
    console.error('Failed to update agent preferences:', error)
    return c.json({ error: 'Failed to update agent preferences' }, 500)
  }
})

// ============================================================
// Agent Access (ACL) endpoints
// ============================================================

agents.route('/:id/members', agentMembers)

// GET /api/agents/:id/access - List users with roles on this agent
agents.get('/:id/access', AgentAdmin(), async (c) => {
  try {
    const slug = getAgentId(c)
    const rows = await db
      .select({
        userId: agentAcl.userId,
        role: agentAcl.role,
        createdAt: agentAcl.createdAt,
      })
      .from(agentAcl)
      .where(eq(agentAcl.agentSlug, slug))
    const profiles = await getUserSummaries(rows.map(row => row.userId))
    return c.json(rows.flatMap(row => {
      const profile = profiles.get(row.userId)
      return profile ? [{ ...row, userName: profile.name, userEmail: profile.email, image: profile.image }] : []
    }))
  } catch (error) {
    console.error('Failed to fetch agent access:', error)
    return c.json({ error: 'Failed to fetch agent access' }, 500)
  }
})

// POST /api/agents/:id/access - Invite user (assign role)
agents.post('/:id/access', AgentAdmin(), async (c) => {
  try {
    const slug = getAgentId(c)
    const { userId, role } = await c.req.json()

    if (!userId || !role) {
      return c.json({ error: 'userId and role are required' }, 400)
    }
    if (!['owner', 'user', 'viewer'].includes(role)) {
      return c.json({ error: 'Invalid role. Must be owner, user, or viewer' }, 400)
    }

    // Check user exists
    if (!(await userExists(userId))) {
      return c.json({ error: 'User not found' }, 404)
    }

    // Check if ACL already exists
    const [existing] = await db
      .select({ id: agentAcl.id })
      .from(agentAcl)
      .where(and(eq(agentAcl.userId, userId), eq(agentAcl.agentSlug, slug)))
      .limit(1)
    if (existing) {
      return c.json({ error: 'User already has access to this agent' }, 409)
    }

    await db.insert(agentAcl).values({
      id: randomUUID(),
      userId,
      agentSlug: slug,
      role,
      createdAt: new Date(),
    })

    await notifyAgentMembersChanged(slug)
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'agent_access', objectId: slug, action: 'granted', details: { targetUserId: userId, role } })
    return c.json({ ok: true }, 201)
  } catch (error) {
    console.error('Failed to add agent access:', error)
    return c.json({ error: 'Failed to add agent access' }, 500)
  }
})

// PATCH /api/agents/:id/access/:userId - Change user's role
agents.patch('/:id/access/:userId', AgentAdmin(), async (c) => {
  try {
    const slug = getAgentId(c)
    const targetUserId = c.req.param('userId')
    const { role } = await c.req.json()

    if (!role || !['owner', 'user', 'viewer'].includes(role)) {
      return c.json({ error: 'Invalid role. Must be owner, user, or viewer' }, 400)
    }

    // The last-owner guard is part of the update statement, so there is no
    // read-then-decide window for a concurrent demotion to slip through.
    const outcome = await changeMemberRole(slug, targetUserId, role)
    if (outcome === 'not-a-member') return c.json({ error: 'User does not have access to this agent' }, 404)
    if (outcome === 'last-owner') return c.json({ error: 'Cannot change role: agent must have at least one owner' }, 400)
    await notifyAgentMembersChanged(slug)
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'agent_access', objectId: slug, action: 'changed', details: { targetUserId: targetUserId, role } })
    return c.json({ ok: true })
  } catch (error) {
    console.error('Failed to update agent access:', error)
    return c.json({ error: 'Failed to update agent access' }, 500)
  }
})

// DELETE /api/agents/:id/access/:userId - Remove user's access
agents.delete('/:id/access/:userId', AgentAdmin(), async (c) => {
  try {
    const slug = getAgentId(c)
    const targetUserId = c.req.param('userId')

    // The last-owner guard is part of the delete statement, so two concurrent
    // revokes leave exactly one owner.
    const outcome = await removeMember(slug, targetUserId)
    if (outcome === 'not-a-member') return c.json({ error: 'User does not have access to this agent' }, 404)
    if (outcome === 'last-owner') return c.json({ error: 'Cannot remove access: agent must have at least one owner' }, 400)
    await notifyAgentMembersChanged(slug, targetUserId)
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'agent_access', objectId: slug, action: 'revoked', details: { targetUserId } })
    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to remove agent access:', error)
    return c.json({ error: 'Failed to remove agent access' }, 500)
  }
})

// POST /api/agents/:id/leave - Remove yourself from an agent's ACL
agents.post('/:id/leave', AgentRead(), async (c) => {
  try {
    const slug = getAgentId(c)
    const userId = getCurrentUserId(c)

    const outcome = await removeMember(slug, userId)
    if (outcome === 'not-a-member') return c.json({ error: 'You do not have access to this agent' }, 400)
    if (outcome === 'last-owner') return c.json({ error: 'Cannot leave: you are the only owner' }, 400)
    await notifyAgentMembersChanged(slug, userId)
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'agent_access', objectId: slug, action: 'revoked', details: { targetUserId: userId } })
    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to leave agent:', error)
    return c.json({ error: 'Failed to leave agent' }, 500)
  }
})

// GET /api/agents/:id/access/search-users - List/search users for invite.
// Without a query, returns all invitable users (teams are small enough to
// show everyone as suggestions in the share popover).
agents.get('/:id/access/search-users', AgentAdmin(), async (c) => {
  try {
    const query = c.req.query('q')?.trim()
    const slug = getAgentId(c)

    // Get users who already have access
    const existingUserIds = await db
      .select({ userId: agentAcl.userId })
      .from(agentAcl)
      .where(eq(agentAcl.agentSlug, slug))

    const excludeIds = existingUserIds.map((r) => r.userId)

    return c.json(await searchUserSummaries(query, excludeIds))
  } catch (error) {
    console.error('Failed to search users:', error)
    return c.json({ error: 'Failed to search users' }, 500)
  }
})

// POST /api/agents/:id/start - Start an agent's container.
// Optional JSON body `{ sessionId }`: the session the caller is typing into.
// Once the container is up, that session's CLI — evicted after a few idle
// minutes — is resumed in the background, so the next send skips the CLI
// spawn and `--resume`. Clients call this on the first keystroke. Older ones
// send no body, and any body this route cannot use is a plain start.
const startAgentBodySchema = z.object({
  sessionId: z.string().min(1).max(256).optional(),
})
// A `{ sessionId }` body is tiny. Reject a declared oversize without reading,
// and also bound actual bytes: chunked requests need not declare their size.
const START_AGENT_BODY_MAX_BYTES = 16 * 1024

async function sessionToPreResume(c: Context): Promise<string | null> {
  if (Number(c.req.header('content-length')) > START_AGENT_BODY_MAX_BYTES) return null
  // An oversized or unreadable optional hint must not prevent a plain start.
  const json = await readLimitedJsonBody(c.req.raw, START_AGENT_BODY_MAX_BYTES).catch(() => null)
  const parsed = startAgentBodySchema.safeParse(json)
  return parsed.success ? parsed.data.sessionId ?? null : null
}

// Never delays or fails the start. The id is the caller's, so it is acted on
// only when it names one of this agent's sessions — the containment check
// every session route makes. Any other id is dropped without a trace.
async function preResumeSession(actor: AgentActor, sessionId: string): Promise<void> {
  try {
    if (!(await actor.sessions.isKnown(sessionId))) return
    await actor.sessions.warm(sessionId)
  } catch (error) {
    console.debug(`[Agents] Pre-resume of session ${sessionId} skipped:`, error)
  }
}

agents.post('/:id/start', AgentUser(), async (c) => {
  try {
    const slug = getAgentId(c)
    const sessionId = await sessionToPreResume(c)
    const actor = agentRegistry.get(slug)

    await actor.container.start()
    if (sessionId) background(preResumeSession(actor, sessionId), { name: 'agents-route.pre-resume-session' })

    // Skip the session-summary enrichment: it stats every transcript, and every
    // caller of this command discards the body and refetches agent data anyway.
    const agent = await getAgentWithStatus(slug, { includeSummary: false })

    // Note: agent_status_changed is broadcast by containerManager.ensureRunning()

    return c.json(agent)
  } catch (error) {
    console.error('Failed to start agent:', error)
    const message = error instanceof Error ? error.message : 'Failed to start agent'
    return c.json({ error: message }, 500)
  }
})

// POST /api/agents/:id/stop - Stop an agent's container
agents.post('/:id/stop', AgentUser(), async (c) => {
  try {
    const slug = getAgentId(c)
    const agent = await getAgent(slug)

    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    // Use cached status to avoid spawning docker process
    const info = await agentRegistry.get(slug).container.status()

    if (info.status === 'stopped') {
      return c.json({
        slug: agent.slug,
        displaySlug: displaySlug(agent.frontmatter.name, agent.slug),
        name: agent.frontmatter.name,
        description: agent.frontmatter.description,
        createdAt: agent.frontmatter.createdAt,
        status: 'stopped',
        containerPort: null,
        message: 'Agent is already stopped',
      })
    }

    await agentRegistry.get(slug).container.stop()

    return c.json({
      slug: agent.slug,
      displaySlug: displaySlug(agent.frontmatter.name, agent.slug),
      name: agent.frontmatter.name,
      description: agent.frontmatter.description,
      createdAt: agent.frontmatter.createdAt,
      status: 'stopped',
      containerPort: null,
    })
  } catch (error) {
    console.error('Failed to stop agent:', error)
    return c.json({ error: 'Failed to stop agent' }, 500)
  }
})

// POST /api/agents/:id/keep-alive - Prevent auto-sleep (e.g. dashboard is open)
agents.post('/:id/keep-alive', AgentRead(), async (c) => {
  const slug = getAgentId(c)
  await agentRegistry.get(slug).container.keepAlive()
  return c.json({ ok: true })
})

// POST /api/agents/:id/open-directory - Get workspace path, optionally open in system file manager
const OpenDirectoryBody = z.object({ open: z.boolean().optional() })

agents.post('/:id/open-directory', AgentAdmin(), async (c) => {
  try {
    const slug = getAgentId(c)

    // Ensure the workspace exists, then find where it lives on this machine —
    // opening it in the OS file manager is a host capability, not a file operation.
    await agentRegistry.get(slug).files.mkdir('')
    const workspaceDir = containerHost.workspaceHostPath(slug)

    const raw = await c.req.json().catch(() => ({}))
    const { open } = OpenDirectoryBody.parse(raw)
    if (open) {
      const { execFile } = await import('child_process')
      const platform = process.platform
      const command =
        platform === 'darwin' ? 'open' :
        platform === 'win32' ? 'explorer' :
        'xdg-open'

      // Use execFile with an argv array so the path is passed as a single
      // argument — avoids shell-injection if workspaceDir contains quotes/$.
      execFile(command, [workspaceDir])
    }

    return c.json({ success: true, path: workspaceDir })
  } catch (error) {
    console.error('Failed to open agent directory:', error)
    return c.json({ error: 'Failed to open agent directory' }, 500)
  }
})

// GET /api/agents/:id/sessions - List sessions for an agent
// ?notable=true means active/awaiting-input or unread. Its fast path intersects
// those targeted IDs with server-visible sessions before sort_by and limit,
// avoiding a stat of every transcript. Supported ordering is deterministic
// newest-first activity via sort_by=last_activity_at.
agents.get('/:id/sessions', AgentRead(), async (c) => {
  try {
    const slug = getAgentId(c)
    const actor = agentRegistry.get(slug)
    const sortByRaw = c.req.query('sort_by')
    const notableRaw = c.req.query('notable')
    const limitRaw = c.req.query('limit')
    const parsedQuery = sessionsListQuerySchema.safeParse({
      ...(sortByRaw === undefined ? {} : { sortBy: sortByRaw }),
      ...(notableRaw === undefined ? {} : { notable: notableRaw }),
      ...(limitRaw === undefined ? {} : { limit: limitRaw }),
    })
    if (!parsedQuery.success) {
      return c.json({ error: 'Invalid sessions query' }, 400)
    }

    const sortBy: SessionSortBy = parsedQuery.data.sortBy ?? 'last_activity_at'
    const isNotable = parsedQuery.data.notable === true
    const requestedLimit = parsedQuery.data.limit === undefined
      ? undefined
      : Math.min(parsedQuery.data.limit, SESSIONS_LIST_MAX_LIMIT)
    const resultLimit = requestedLimit ?? (isNotable ? 25 : undefined)

    if (isNotable) {
      // Both halves of the unread projection are table lookups — overlap them,
      // and note that neither touches the filesystem. That matters here: with
      // nothing notable the id set is empty, listSessionsByIds returns before
      // it stats anything, and the whole request stays off disk.
      const [unreadIds, markedUnreadIds, mentionedIds] = await Promise.all([
        getSessionIdsWithUnreadNotifications(slug, undefined, getCurrentUserId(c)),
        getSessionIdsMarkedUnread(slug, getCurrentUserId(c)),
        isAuthMode() ? getSessionIdsWithUnreadMentions(slug, getCurrentUserId(c)) : new Set<string>(),
      ])
      const live = await actor.live()
      const active = new Set(live.activeSessionIds)
      const awaiting = new Set(live.awaitingSessionIds)
      const infos = await actor.sessions.listByIds(
        [...new Set([...live.activeSessionIds, ...unreadIds, ...markedUnreadIds])],
        { excludeAutomated: true },
      )
      const enriched = infos.map((session) => {
        const isActive = active.has(session.id)
        return {
          ...session,
          isActive,
          // The awaiting projection already counts agent-scoped reviews
          // against every active session of the agent — no review special-case.
          isAwaitingInput: awaiting.has(session.id),
          hasUnreadNotifications: unreadIds.has(session.id) || markedUnreadIds.has(session.id),
          hasUnreadMention: mentionedIds.has(session.id),
        }
      })
      const ordered = sortSessionsNewestFirst(enriched, sortBy)
      if (sortByRaw === undefined) {
        // Preserve the existing notable-only contract when no explicit order
        // was requested: live sessions survive the default/caller cap. The
        // stable sort retains deterministic newest-first ordering per band.
        ordered.sort((a, b) => {
          const aLive = a.isActive || a.isAwaitingInput ? 1 : 0
          const bLive = b.isActive || b.isAwaitingInput ? 1 : 0
          return bLive - aLive
        })
      }
      return c.json(ordered.slice(0, resultLimit))
    }

    // Independent lookups (filesystem summary, notifications table, unread
    // marks, scheduled tasks table) — overlap them rather than paying their
    // latencies in series.
    const [sessionList, unreadSessionIds, markedUnreadSessionIds, pendingWakes, mentionedSessionIds] = await Promise.all([
      actor.sessions.listFromSummary({
        excludeAutomated: true,
        ...(sortByRaw === undefined ? {} : { sortBy }),
        ...(resultLimit === undefined ? {} : { limit: resultLimit }),
      }),
      getSessionIdsWithUnreadNotifications(slug, undefined, getCurrentUserId(c)),
      getSessionIdsMarkedUnread(slug, getCurrentUserId(c)),
      listPendingWakesByAgent(slug),
      isAuthMode() ? getSessionIdsWithUnreadMentions(slug, getCurrentUserId(c)) : new Set<string>(),
    ])
    const wakesBySession = new Map(pendingWakes.map((w) => [w.resumeSessionId!, w]))
    const live = await actor.live()
    const active = new Set(live.activeSessionIds)
    const awaiting = new Set(live.awaitingSessionIds)
    const sessionsWithStatus = sessionList.map((session) => {
      const isActive = active.has(session.id)
      const wake = wakesBySession.get(session.id)
      return {
        ...session,
        isActive,
        // The awaiting projection already counts agent-scoped reviews against
        // every active session of the agent — no review special-case.
        isAwaitingInput: awaiting.has(session.id),
        hasUnreadNotifications:
          unreadSessionIds.has(session.id) || markedUnreadSessionIds.has(session.id),
        hasUnreadMention: mentionedSessionIds.has(session.id),
        ...(wake
          ? {
              pendingWakeAt: wake.nextExecutionAt.toISOString(),
              pendingWakeTaskId: wake.id,
              pendingWakeNote: wake.prompt,
            }
          : {}),
      }
    })

    return c.json(sessionsWithStatus)
  } catch (error) {
    console.error('Failed to fetch sessions:', error)
    return c.json({ error: 'Failed to fetch sessions' }, 500)
  }
})

// Saved references are readable through the agent that owns them. This exposes
// just the displayed binding, never unrelated personal accounts.
agents.get('/:id/llm-connections', AgentRead(), async c => {
  const slug = getAgentId(c)
  const prefs = await readAgentPreferences(slug)
  let currentId = prefs.defaultLlmProviderId ?? undefined
  const reference = c.req.query('llmProviderId')
  if (reference && reference !== currentId) {
    for (const table of [scheduledTasks, webhookTriggers, chatIntegrations]) {
      const attached = await db.select({ id: table.id }).from(table)
        .where(and(eq(table.agentSlug, slug), eq(table.llmProviderId, reference))).get()
      if (attached) { currentId = reference; break }
    }
  }
  return c.json({ connections: await listConnections({ userId: getCurrentUserId(c), admin: false }, currentId) })
})

agents.get('/:id/sessions/:sessionId/llm-connections', AgentUser(), async c => {
  const slug = getAgentId(c)
  const actor = agentRegistry.get(slug)
  const sessionId = c.req.param('sessionId')
  if (!await actor.sessions.isKnown(sessionId)) return c.json({ error: 'Session not found' }, 404)
  const metadata = await actor.sessions.metadata(sessionId)
  const effective = await resolveConnectionRuntimeInherit(metadata ?? {}, await readAgentPreferences(slug), getEffectiveModels())
  return c.json({ connections: await listConnections({ userId: getCurrentUserId(c), admin: false }, effective.llmProviderId ?? undefined) })
})

// POST /api/agents/:id/sessions - Create a new session with initial message
agents.post('/:id/sessions', AgentUser(), async (c) => {
  try {
    const slug = getAgentId(c)
    const body = await c.req.json()
    const { message } = body

    if (!message?.trim()) {
      return c.json({ error: 'Message is required' }, 400)
    }

    const runtimeOptions = parseRuntimeOptions(body)

    // Optional provenance: the renderer's dashboard-dispatch dialog marks the
    // sessions it creates so they can show where they came from. This is a
    // LABEL, not proof of user consent: dashboard iframes share the API's
    // origin and ambient credentials, so dashboard JS can already POST here
    // directly, with or without this field. The consent dialog is therefore a
    // guarantee about host-built UI paths (and a throttle on well-behaved
    // dashboards), not a server-enforced boundary — enforcing consent
    // server-side requires isolating dashboards onto their own origin with a
    // host-issued capability, which is deliberately out of scope here.
    let dashboardDispatch: SessionDashboardDispatch | undefined
    if (body.dashboardDispatch !== undefined) {
      const parsed = sessionDashboardDispatchSchema.safeParse(body.dashboardDispatch)
      if (!parsed.success) {
        return c.json({ error: 'Invalid dashboardDispatch' }, 400)
      }
      dashboardDispatch = parsed.data
    }

    // The agent's name is all this route needs of it, and the catalog has it.
    const agent = await getAgentRecord(slug)
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    // Refused before the session exists. A first message always runs the agent:
    // the teammates it tags are notified, and it is never notify-only.
    const mentions = await readSessionMentions(c, slug, message.trim())
    if ('error' in mentions) return c.json({ error: mentions.error }, 400)

    const actor = agentRegistry.get(slug)

    await actor.container.start()
    const availableEnvVars = await getSecretEnvVars(slug)

    const agentLimits = getEffectiveAgentLimits()
    const customEnvVars = getCustomEnvVars()

    // Server-generated uuid for the initial message (never client-supplied —
    // it keys the messageAuthor attribution row). Returned in the response so
    // the client can materialize its optimistic copy by exact id match.
    const initialMessageUuid = randomUUID()

    // Model/effort/speed preference order: explicit per-session pick > agent default > global default.
    const agentPrefs = await readAgentPreferences(slug)
    const models = getEffectiveModels()
    await assertConnectionSelectionAccess(runtimeOptions.llmProviderId, agentPrefs.defaultLlmProviderId)
    const resolved = await resolveConnectionRuntimeInherit(runtimeOptions, agentPrefs, models)
    const prewarm = await resolveConnectionRuntimeInherit({}, agentPrefs, models)

    // Runtime choices are SESSION state once the first turn starts, including
    // inherited defaults. Persist the effective values, not merely explicit
    // overrides, so changing an agent/app default later cannot silently change
    // an existing conversation's next turn or make the composer claim it will.
    const initialMetadata: Partial<SessionMetadata> = {
      model: resolved.model,
      llmProviderId: resolved.llmProviderId,
      ...(resolved.effort ? { effort: resolved.effort } : {}),
      ...(resolved.speed ? { speed: resolved.speed } : {}),
      ...(dashboardDispatch
        ? {
            dispatchedByDashboardSlug: dashboardDispatch.dashboardSlug,
            // Derived from the route, never client-supplied: dispatch always
            // targets the dashboard's owning agent, so the label can't be spoofed.
            dispatchedByDashboardAgentSlug: slug,
          }
        : {}),
    }
    if (isAuthMode()) {
      initialMetadata.createdByUserId = getCurrentUserId(c)
      // Origin-device stamp: which mobile device family (if any) started this
      // session. ApnsRelayChannel routes visible alert pushes only to it, so
      // it must land in the INITIAL registration write — a fast completion
      // would beat a fire-and-forget update and demote the origin's alert to
      // a silent push.
      const deviceId = getRequestDeviceId(c)
      if (deviceId) initialMetadata.createdByDeviceId = deviceId
    }

    // Create, mark, register and attach in one op: the first turn can emit
    // as soon as create returns, and a session whose attach or registration
    // fails is revoked rather than left running unseen. The registration
    // carries the commands the container listed.
    const containerSession = await actor.sessions.start({
      create: {
        availableEnvVars: availableEnvVars.length > 0 ? availableEnvVars : undefined,
        initialMessage: await attributedForAgent(c, slug, message.trim()),
        initialMessageUuid,
        model: resolved.model,
        llmProviderId: resolved.llmProviderId,
        browserModel: models.browserModel,
        dashboardBuilderModel: models.dashboardBuilderModel,
        maxOutputTokens: agentLimits.maxOutputTokens,
        maxThinkingTokens: agentLimits.maxThinkingTokens,
        maxTurns: agentLimits.maxTurns,
        maxBudgetUsd: agentLimits.maxBudgetUsd,
        customEnvVars: Object.keys(customEnvVars).length > 0 ? customEnvVars : undefined,
        maxBrowserTabs: getSettings().app?.maxBrowserTabs,
        effort: resolved.effort,
        speed: resolved.speed,
        // Same preference chain MINUS the per-session pick: this is what the
        // composer will send next time (it only puts model/effort/speed on the
        // wire when the user explicitly chooses one), so it is what the
        // container should pre-warm for.
        prewarmDefaults: {
          llmProviderId: prewarm.llmProviderId ?? undefined,
          model: prewarm.model,
          effort: prewarm.effort,
          speed: prewarm.speed,
        },
      },
      name: 'New Session',
      metadata: initialMetadata,
    })
    const sessionId = containerSession.id

    // The session runs now, so a failed attribution row leaves the message
    // unattributed rather than failing a session the user can already see.
    if (isAuthMode()) {
      await insertMessageAuthorBestEffort({ id: initialMessageUuid, sessionId, agentSlug: slug, userId: getCurrentUserId(c) })
    }

    await notifySessionMentions(c, mentions, { agentSlug: slug, agentName: agent.name, sessionId, messageUuid: initialMessageUuid })

    if (isSystemMessageText(message.trim())) {
      await actor.sessions.deferNaming(sessionId)
    } else {
      background(generateAndUpdateSessionNameAsync(
        slug,
        sessionId,
        message.trim(),
        agent.name
      ).catch(console.error), { name: 'agents-route.generate-session-name' })
    }

    return c.json(
      {
        id: sessionId,
        agentSlug: slug,
        name: 'New Session',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        isActive: true,
        model: resolved.model,
        llmProviderId: resolved.llmProviderId,
        ...(resolved.effort ? { effort: resolved.effort } : {}),
        ...(resolved.speed ? { speed: resolved.speed } : {}),
        initialMessageUuid,
        credentialSource: credentialSource((await actor.sessions.live(sessionId)).runtime?.provider),
      },
      201
    )
  } catch (error) {
    const runtimeError = findAgentRuntimeError(error)
    if (runtimeError) return runtimeError.toHttpResponse()
    console.error('Failed to create session:', error)
    return c.json({ error: 'Failed to create session' }, 500)
  }
})

const messagesListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MESSAGES_PAGE_MAX_LIMIT).optional(),
    cursor: z.string().min(1).max(200).optional(),
    after: z.string().min(1).max(200).optional(),
    // Opt-in: images ship as refs to the media endpoint instead of inline
    // base64. Absent means inline, so clients that predate the media endpoint
    // (and the unpaginated path below) are unaffected.
    media: z.literal('ref').optional(),
    // Opt-in `max_bytes`: a soft budget on the raw transcript bytes behind a
    // backward page, clamped by clampMessagesPageBytes. Absent means the
    // reader's default, so clients that predate it are unaffected. Validated
    // on every paginated request, honored on backward pages only: a forward
    // delta is already bounded by the live turn.
    maxBytes: z.coerce.number().int().min(1).optional(),
  })
  // Backward paging and the forward delta are different protocols; a request
  // mixing them has no coherent meaning.
  .refine((q) => !(q.cursor && q.after), { message: 'cursor and after are mutually exclusive' })

// Presentation is derived fresh per response (not persisted), so provider copy
// changes apply to history retroactively.
async function attachProviderErrorPresentations(transformed: TransformedItem[], agentSlug: string, sessionId: string): Promise<void> {
  if (!transformed.some(item => item?.type === 'assistant' && item.apiError)) return
  const runtimeProvider = (await agentRegistry.get(agentSlug).sessions.live(sessionId)).runtime?.provider
  let provider = runtimeProvider ? getLlmProvider(runtimeProvider) : undefined
  const metadata = await agentRegistry.get(agentSlug).sessions.metadata(sessionId)
  if (!provider) {
    // Resolve the saved account even if its selected model has since retired.
    const id = storedSelection(metadata?.model, metadata?.llmProviderId)?.llmProviderId
    const connection = id ? await getConnection(id) : null
    provider = connection ? providerForConnection(connection) : (await resolveGlobalSelection())?.provider ?? getActiveLlmProvider()
  }
  for (const item of transformed) {
    // Holes serialize as null (JSON.stringify / streamJsonArrayResponse); skip so this walk does not 500.
    if (!item || item.type !== 'assistant' || !item.apiError) continue
    // An error keeps the copy of the provider that produced it.
    const recorded = metadata?.errorProviders?.[item.id]
    item.errorPresentation =
      (recorded ? getLlmProvider(recorded) : provider).presentationForTurnError(undefined, item.content.text, item.apiError) ?? undefined
  }
}

/** Rows authored by a person; an integration's rows carry its card instead (see annotateIntegrationMessages). */
function userAuthors(rows: { messageId: string; userId: string | null }[]): { messageId: string; userId: string }[] {
  return rows.flatMap(row => row.userId ? [{ messageId: row.messageId, userId: row.userId }] : [])
}

// Integration cards are decoration: a lookup failure leaves the messages as text.
async function annotateIntegrationMessagesBestEffort(
  transformed: TransformedItem[],
  agentSlug: string,
  sessionId: string,
): Promise<void> {
  try {
    await annotateIntegrationMessages(agentSlug, sessionId, transformed)
  } catch (error) {
    captureException(error, { tags: { component: 'agents', operation: 'annotate-integration-messages' }, level: 'warning' })
  }
}

async function annotateAndRecoverMessages(
  transformed: TransformedItem[],
  agentSlug: string,
  sessionId: string,
): Promise<void> {
  await attachProviderErrorPresentations(transformed, agentSlug, sessionId)
  await resolveInterruptedSubagents(transformed, agentSlug, sessionId)
  await reconcileOpenToolCalls(transformed, agentSlug, sessionId)

  await annotateIntegrationMessagesBestEffort(transformed, agentSlug, sessionId)

  if (!isAuthMode()) return

  const userMessageIds = transformed.filter((m) => m.type === 'user').map((m) => m.id)
  if (userMessageIds.length === 0) return

  // Scope the lookup to the ids actually in this response — a delta window is
  // a handful of items, and loading the whole session's author history per
  // refetch would erase the bounded-memory benefit on auth deployments.
  const authors = userAuthors(await db
    .select({
      messageId: messageAuthor.id,
      userId: messageAuthor.userId,
    })
    .from(messageAuthor)
    .where(and(eq(messageAuthor.sessionId, sessionId), inArray(messageAuthor.id, userMessageIds), isNotNull(messageAuthor.userId))))

  const profiles = await getUserSummaries(authors.map(author => author.userId))
  const authorMap = new Map(authors.map(author => [author.messageId, profiles.get(author.userId)]))
  for (const msg of transformed) {
    if (msg.type !== 'user') continue
    const author = authorMap.get(msg.id)
    if (author) {
      msg.sender = author
    }
  }
}

// Buffers, not strings: Readable.toWeb hands chunks straight to the web
// ReadableStream, whose byte consumers reject non-Uint8Array chunks.
function* messagesPageJsonChunks(page: {
  messages: TransformedItem[]
  nextCursor: string | null
}): Generator<Buffer> {
  yield Buffer.from('{"messages":[')
  for (let i = 0; i < page.messages.length; i++) {
    yield Buffer.from((i === 0 ? '' : ',') + JSON.stringify(page.messages[i]))
  }
  yield Buffer.from(`],"nextCursor":${JSON.stringify(page.nextCursor)}}`)
}

// Unpaginated path stays inlined so the stream-pipe PR can still land on `return c.json(transformed)`.
// GET /api/agents/:id/sessions/:sessionId/messages - Get messages for a session
agents.get('/:id/sessions/:sessionId/messages', AgentRead(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const actor = agentRegistry.get(agentSlug)

    const rawLimit = c.req.query('limit')
    const rawCursor = c.req.query('cursor')
    const rawAfter = c.req.query('after')
    const rawMedia = c.req.query('media')
    const rawMaxBytes = c.req.query('max_bytes')
    // `media` and `max_bytes` select the paginated branch too: they are only
    // honored there, so leaving them out would silently serve the full
    // transcript to a client that asked for refs or for a bounded response —
    // and skip validating the value at all.
    const paginated =
      rawLimit !== undefined ||
      rawCursor !== undefined ||
      rawAfter !== undefined ||
      rawMedia !== undefined ||
      rawMaxBytes !== undefined

    if (!(await actor.sessions.exists(sessionId))) {
      // A live session whose first turn has not persisted anything yet: the
      // CLI creates the transcript on its first written line, seconds after
      // createSession returns on a cold agent, and the creating client has
      // already navigated in and asked for messages by then. That is an empty
      // transcript, not a missing one — answer the empty page so the client
      // keeps showing the running turn and picks the lines up as they land.
      // (sessionIsKnown keeps the containment guarantee for the id.)
      if ((await actor.sessions.live(sessionId)).isActive && (await actor.sessions.isKnown(sessionId))) {
        return paginated ? c.json({ messages: [], nextCursor: null }) : c.json([])
      }
      // No JSONL transcript on disk — e.g. it was deleted by the CLI's
      // retention cleanup while the metadata entry lingers in the nav. Signal
      // this distinctly from an empty (but present) transcript so the UI can
      // show a clear message.
      return c.json({ error: 'Session transcript not found' }, 404)
    }

    if (paginated) {
      const parsed = messagesListQuerySchema.safeParse({
        ...(rawLimit !== undefined ? { limit: rawLimit } : {}),
        ...(rawCursor !== undefined ? { cursor: rawCursor } : {}),
        ...(rawAfter !== undefined ? { after: rawAfter } : {}),
        ...(rawMedia !== undefined ? { media: rawMedia } : {}),
        ...(rawMaxBytes !== undefined ? { maxBytes: rawMaxBytes } : {}),
      })
      if (!parsed.success) {
        return c.json({ error: 'Invalid pagination' }, 400)
      }
      // The renderer aborts superseded refetches; honor that server-side too.
      // The signal threads down to the tail reader so an abandoned request
      // stops paying for transcript reads (multi-second on network volumes)
      // instead of running the full read/parse/serialize pipeline to
      // completion for a client that hung up.
      if (parsed.data.after !== undefined) {
        // Forward delta: upserted items at-or-after the anchor (a live-session
        // refetch only cares about lines appended since the last read). The
        // window is bounded by the active turn near EOF, so this stays a few
        // KB while the full trailing page is multi-MB on long sessions.
        const delta = await actor.messages.delta(sessionId, {
          after: parsed.data.after,
          signal: c.req.raw.signal,
          media: parsed.data.media,
        })
        c.req.raw.signal.throwIfAborted()
        await annotateAndRecoverMessages(delta.messages, agentSlug, sessionId)
        c.req.raw.signal.throwIfAborted()
        return c.json({
          messages: delta.messages,
          anchor: delta.anchor,
          ...(delta.resync ? { resync: true as const } : {}),
        })
      }
      // Without `max_bytes` no budget is passed and the reader's default
      // applies — the same call as before the parameter existed.
      const byteBudget = clampMessagesPageBytes(parsed.data.maxBytes)
      const page = await actor.messages.page(sessionId, {
        limit: capMessagesPageLimit(parsed.data.limit, parsed.data.cursor),
        cursor: parsed.data.cursor,
        signal: c.req.raw.signal,
        media: parsed.data.media,
        ...(byteBudget !== undefined ? { byteBudget } : {}),
      })
      c.req.raw.signal.throwIfAborted()
      await annotateAndRecoverMessages(page.messages, agentSlug, sessionId)
      c.req.raw.signal.throwIfAborted()
      // Serialize item-by-item instead of one JSON.stringify of the whole
      // envelope: pages hold multi-MB tool results, and a monolithic response
      // string was one of the transients that made concurrent page fetches
      // OOM the process. Readable.from pulls lazily, so writes see real
      // backpressure from the socket.
      return c.body(Readable.toWeb(Readable.from(messagesPageJsonChunks(page))) as ReadableStream, 200, {
        'Content-Type': 'application/json',
      })
    }

    const messages = await actor.messages.withCompact(sessionId)
    // The legacy full read above predates abort support (reworked wholesale by
    // the streaming-page follow-up); at least skip transform + serialization
    // when the client is already gone.
    c.req.raw.signal.throwIfAborted()
    const filtered = messages.filter((m) => !('isMeta' in m && m.isMeta))
    const transformed = transformMessages(filtered)
    await attachProviderErrorPresentations(transformed, agentSlug, sessionId)

    // Discover subagent IDs for interrupted Task tool calls that have no result
    await resolveInterruptedSubagents(transformed, agentSlug, sessionId)
    await reconcileOpenToolCalls(transformed, agentSlug, sessionId)

    await annotateIntegrationMessagesBestEffort(transformed, agentSlug, sessionId)

    // In auth mode, annotate user messages with sender info
    if (isAuthMode()) {
      const userMessageIds = transformed
        .filter((m) => m.type === 'user')
        .map((m) => m.id)

      if (userMessageIds.length > 0) {
        const authors = userAuthors(await db
          .select({
            messageId: messageAuthor.id,
            userId: messageAuthor.userId,
          })
          .from(messageAuthor)
          .where(and(eq(messageAuthor.sessionId, sessionId), isNotNull(messageAuthor.userId))))

        const profiles = await getUserSummaries(authors.map(author => author.userId))
        const authorMap = new Map(authors.map(author => [author.messageId, profiles.get(author.userId)]))

        for (const msg of transformed) {
          if (msg.type !== 'user') continue
          const author = authorMap.get(msg.id)
          if (author) {
            msg.sender = author
          }
        }
      }
    }

    const source = Readable.from(transformed)
    const stringify = createJsonArrayStringifyTransform()
    const reportStreamError = (err: unknown) => {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ABORT_ERR' || code === 'ERR_STREAM_PREMATURE_CLOSE') return
      console.error('Failed to stream messages:', err)
      captureException(err, { tags: { component: 'agents', operation: 'stream-messages' } })
    }
    pipeline(source, stringify, (err) => {
      if (err) reportStreamError(err)
    })
    return c.body(Readable.toWeb(stringify) as ReadableStream, 200, {
      'Content-Type': 'application/json',
    })
  } catch (error) {
    // Client hung up mid-request (the renderer aborts superseded refetches):
    // the read path threw AbortError. Nothing receives this response — answer
    // with the conventional 499 instead of logging a failure that isn't one.
    if (c.req.raw.signal.aborted) {
      return new Response(null, { status: 499 })
    }
    console.error('Failed to fetch messages:', error)
    return c.json({ error: 'Failed to fetch messages' }, 500)
  }
})

// GET /api/agents/:id/sessions/:sessionId/media/:ref - Bytes of one image a
// `media=ref` page addressed. Served straight off the transcript as a ranged,
// streaming base64 decode: the row holding it is multi-MB, and none of it is
// materialized here.
agents.get('/:id/sessions/:sessionId/media/:ref', AgentRead(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const actor = agentRegistry.get(agentSlug)
    // Ownership only. There is deliberately no existence preflight here:
    // fileExists() answers false for any stat failure, so EIO/EACCES/EMFILE
    // would 404 — telling the client the image is gone when the truth is that
    // this machine could not look. The media read distinguishes the two, and
    // a genuinely missing transcript surfaces there as 410.
    // isKnown is satisfied by a metadata entry alone, and the media read below
    // opens the transcript by path — so a planted symlink whose metadata the
    // agent also forged would be FOLLOWED to another agent's transcript. The
    // realpath guard (unlike isKnown) refuses that link while still admitting
    // a legitimately deleted transcript, whose bytes are gone and which the
    // media read answers with a 410.
    if (
      !(await actor.sessions.isKnown(sessionId)) ||
      !(await actor.sessions.fileRealPathWithinAgent(sessionId))
    ) {
      return c.json({ error: 'Session transcript not found' }, 404)
    }

    const ref = decodeMediaRef(c.req.param('ref'))
    if (!ref) return c.json({ error: 'Invalid media reference' }, 400)

    const blob = await actor.messages.media(sessionId, ref, c.req.raw.signal)
    // Deletion and retention rewrite transcripts in place, so a ref the client
    // still holds can address bytes that have moved or gone. Gone for good —
    // the client shows a placeholder rather than retrying.
    if (!blob) return c.json({ error: 'Media no longer available' }, 410)

    return c.body(blob.stream, 200, {
      'Content-Type': blob.mimeType,
      'Content-Length': String(blob.bytes),
      // A ref names an immutable byte span: any edit to the transcript
      // invalidates it rather than changing what it points at.
      'Cache-Control': 'private, max-age=31536000, immutable',
      // The type comes from a magic-number sniff, never from the ref — keep
      // the browser from second-guessing it.
      'X-Content-Type-Options': 'nosniff',
    })
  } catch (error) {
    if (c.req.raw.signal.aborted) {
      return new Response(null, { status: 499 })
    }
    console.error('Failed to fetch session media:', error)
    return c.json({ error: 'Failed to fetch media' }, 500)
  }
})

// DELETE /api/agents/:id/sessions/:sessionId/messages/:messageId - Remove a message from history
agents.delete('/:id/sessions/:sessionId/messages/:messageId', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')


    const removed = await agentRegistry.get(agentSlug).messages.remove(sessionId, messageId)
    if (!removed) {
      return c.json({ error: 'Message not found' }, 404)
    }

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to remove message:', error)
    return c.json({ error: 'Failed to remove message' }, 500)
  }
})

// DELETE /api/agents/:id/sessions/:sessionId/tool-calls/:toolCallId - Remove a tool call from history
agents.delete('/:id/sessions/:sessionId/tool-calls/:toolCallId', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const toolCallId = c.req.param('toolCallId')


    const removed = await agentRegistry.get(agentSlug).messages.removeToolCall(sessionId, toolCallId)
    if (!removed) {
      return c.json({ error: 'Tool call not found' }, 404)
    }

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to remove tool call:', error)
    return c.json({ error: 'Failed to remove tool call' }, 500)
  }
})

// GET /api/agents/:id/sessions/:sessionId/subagent/:agentId/messages - Get subagent messages
agents.get('/:id/sessions/:sessionId/subagent/:agentId/messages', AgentRead(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const subagentId = c.req.param('agentId')

    // sessionId and subagentId are unvalidated URL segments; the actor keeps
    // the read inside this agent's own sessions directory and refuses an id
    // that cannot name a transcript. Either refusal is "no such transcript".
    let entries: JsonlEntry[]
    try {
      entries = await agentRegistry.get(agentSlug).sessions.subagentTranscript(sessionId, subagentId)
    } catch (error) {
      if (error instanceof WorkspaceFileError) {
        return c.json({ error: 'Subagent transcript not found' }, 404)
      }
      throw error
    }
    // A fork's transcript opens with what it inherited from the parent.
    const messageEntries = subagentOwnEntries(entries).filter(
      (e): e is JsonlMessageEntry => e.type === 'user' || e.type === 'assistant'
    )
    const transformed = transformMessages(messageEntries)
    await attachProviderErrorPresentations(transformed, agentSlug, sessionId)
    // Fanned out in parallel across all subagent ids by the activity log, so
    // stream the serialization instead of building one JSON string per request.
    return streamJsonArrayResponse(c, transformed, {
      logLabel: 'subagent messages',
      tags: { component: 'agents', operation: 'stream-subagent-messages' },
    })
  } catch (error) {
    console.error('Failed to fetch subagent messages:', error)
    return c.json({ error: 'Failed to fetch subagent messages' }, 500)
  }
})

// GET /api/agents/:id/sessions/:sessionId/raw-log - Get raw JSONL log for a session
agents.get('/:id/sessions/:sessionId/raw-log', AgentRead(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')

    const actor = agentRegistry.get(agentSlug)

    // Ownership + containment first: the transcript is opened by path below,
    // so without the gate a traversal-shaped id throws into the catch (500,
    // not 404) and a planted symlink is followed to another agent's
    // transcript. exists is non-throwing and symlink-aware.
    if (!(await actor.sessions.exists(sessionId))) {
      return c.json({ error: 'Session log not found' }, 404)
    }

    // Transcripts routinely reach tens of MB, so the actor streams the file
    // instead of buffering it whole, bounded to its size at open so the byte
    // count always matches the Content-Length advertised here even while the
    // live transcript keeps growing. Null means the file is gone.
    const raw = await actor.messages.rawLog(sessionId)
    if (raw === null) {
      return c.json({ error: 'Session log not found' }, 404)
    }

    // Same headers the buffered c.text() response carried on the wire.
    return c.body(raw.stream, 200, {
      'Content-Type': 'text/plain; charset=UTF-8',
      'Content-Length': String(raw.size),
    })
  } catch (error) {
    console.error('Failed to fetch raw log:', error)
    return c.json({ error: 'Failed to fetch raw log' }, 500)
  }
})

// GET /api/agents/:id/sessions/:sessionId/usage - Calculate all-time usage for a session
agents.get('/:id/sessions/:sessionId/usage', AgentRead(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const actor = agentRegistry.get(agentSlug)

    if (!(await actor.sessions.exists(sessionId))) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const totals = await actor.sessions.usage(sessionId)
    return c.json(totals)
  } catch (error) {
    console.error('Failed to calculate session usage:', error)
    return c.json({ error: 'Failed to calculate session usage' }, 500)
  }
})

/** In an agent several people can message, name the sender for the agent, as chat integrations do. */
async function attributedForAgent(c: Context, agentSlug: string, text: string): Promise<string> {
  // A slash command or system notice only keeps its meaning at the very start of the text.
  if (!isAuthMode() || text.startsWith('/') || isSystemMessageText(text)) return text
  // Attribution is best-effort: a failed member count sends the message without it.
  try {
    if ((await countMembersWithMinRole(agentSlug, 'user')) < 2) return text
  } catch (error) {
    captureException(error, { tags: { component: 'agents', operation: 'attribute-message' }, level: 'warning' })
    return text
  }
  return formatSenderPrefix((c.get('user' as never) as UserSenderSource).name) + text
}

// POST /api/agents/:id/sessions/:sessionId/messages - Send a message
agents.post('/:id/sessions/:sessionId/messages', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const actor = agentRegistry.get(agentSlug)
    const body = await c.req.json()
    const { content } = body

    if (!content?.trim()) {
      return c.json({ error: 'Content is required' }, 400)
    }

    const runtimeOptions = parseRuntimeOptions(body)

    // The delivery below is keyed by session id alone: an unowned id would
    // cancel another agent's pending input request, re-bind its session to
    // this agent, and inject a spoofed user message into every client watching it.
    if (!(await actor.sessions.isKnown(sessionId))) {
      return c.json({ error: 'Session not found' }, 404)
    }

    // The agent's name is all this route needs of it, and the catalog has it.
    const agent = await getAgentRecord(agentSlug)
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    // Refused before anything is written. A message that opens on a teammate
    // only notifies them: it joins the transcript, and no turn runs.
    const mentions = await readSessionMentions(c, agentSlug, content.trim())
    if ('error' in mentions) return c.json({ error: mentions.error }, 400)
    if (mentions.silent) runtimeOptions.shouldQuery = false

    // Server-generated message uuid (never client-supplied — the uuid keys the
    // messageAuthor attribution row, so a client-chosen value could collide
    // with another user's message and misattribute it). It is forwarded to the
    // container, becomes the JSONL entry id, and is returned in the response
    // so the client can materialize its optimistic copy by exact id match.
    const messageUuid = randomUUID()
    const text = content.trim()

    // Checked before the session's binding is known: a connection the caller
    // cannot bind outright is one it may only continue, and the delivery
    // refuses it unless the session still holds it. An append starts no turn
    // and keeps the session's runtime, so its connection is not looked at.
    const requireStoredProvider = runtimeOptions.shouldQuery !== false && await connectionNeedsAttachment(runtimeOptions.llmProviderId)

    const metadataUpdates: Partial<SessionMetadata> = {}
    if (isAuthMode()) {
      // Alert claim: the device that spoke last in a session is the one
      // awaiting its outcome, so visible pushes follow it. A send with no
      // device identity (web/desktop) CLEARS the claim — the user moved to a
      // surface where a phone alert for this session would be noise (web push
      // covers them there). Explicit null ≠ absent: absent falls back to the
      // creation stamp in ApnsRelayChannel. Stored with the send so a fast
      // turn can't complete ahead of its own claim.
      metadataUpdates.alertDeviceId = getRequestDeviceId(c)
      // The author row goes in before the message reaches anyone; the echo
      // carries the sender to the other members' windows.
      await db.insert(messageAuthor).values({ id: messageUuid, sessionId, agentSlug, userId: getCurrentUserId(c) })
    }

    // A message through this AgentUser route is human-originated: the
    // delivery promotes a hidden automation first, so the host and container
    // agree that a person has joined the session. While the session recovers
    // from a runtime death the message is held for the recovery to send. A
    // transcript-only append (the voice-mode notices) enters the agent's
    // context to be read with its next turn, and no turn starts now.
    let delivery: DeliverResult
    try {
      delivery = await actor.messages.deliver({
        sessionId,
        content: await attributedForAgent(c, agentSlug, text),
        uuid: messageUuid,
        options: runtimeOptions,
        metadataUpdates,
        promote: true,
        requireStoredProvider,
        // An open AskUserQuestion / secret / file request would deadlock the
        // message behind the blocked tool: it is cancelled, so the message
        // starts a fresh turn.
        cancelAwaiting: true,
        coalesce: true,
        ...(isAuthMode() ? { echo: { content: text, sender: toUserSender(c.get('user' as never) as UserSenderSource) } } : {}),
      })
    } catch (error) {
      // A message that certainly never went (refused, or the session is
      // gone) leaves no attribution behind.
      if (isAuthMode() && deliveryFailure(error)?.accepted === false) await deleteMessageAuthorBestEffort(messageUuid)
      throw error
    }
    const queued = delivery.status !== 'sent' || delivery.queued
    if (delivery.status === 'sent' && runtimeOptions.shouldQuery !== false) {
      await nameSessionFromFirstHumanMessage(actor, sessionId, text, agent.name)
    }
    if (mentions.teammates.length > 0) {
      const sessionName = (await actor.sessions.metadata(sessionId))?.name
      await notifySessionMentions(c, mentions, { agentSlug, agentName: agent.name, sessionId, sessionName, messageUuid })
    }
    return c.json({ success: true, uuid: messageUuid, queued, credentialSource: credentialSource(delivery.provider) }, 201)
  } catch (error) {
    if (deliveryFailure(error)?.code === 'provider-not-attached') return new LlmProviderNotFoundError().toHttpResponse()
    const runtimeError = findAgentRuntimeError(error)
    if (runtimeError) return runtimeError.toHttpResponse()
    console.error('Failed to send message:', error)
    return c.json({ error: 'Failed to send message' }, 500)
  }
})

// DELETE /api/agents/:id/sessions/:sessionId/queued-messages/:uuid - Cancel a
// queued (not yet picked up) message. `cancelled: false` means it was already
// picked up (or the session isn't live) — the message will materialize normally.
agents.delete('/:id/sessions/:sessionId/queued-messages/:uuid', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const uuidParam = z.string().uuid().safeParse(c.req.param('uuid'))
    if (!uuidParam.success) {
      return c.json({ error: 'Invalid message uuid' }, 400)
    }

    const actor = agentRegistry.get(agentSlug)
    if (!(await actor.sessions.isKnown(sessionId))) {
      return c.json({ error: 'Session not found' }, 404)
    }

    // A message taken back never ran, so whoever it tagged is not told. The
    // cancel stands either way.
    const withdrawMentions = () => notificationManager.withdrawSessionMentions(uuidParam.data).catch((error) => {
      console.error('Failed to withdraw mentions:', error)
    })
    const cancelled = await actor.messages.cancelQueued(sessionId, uuidParam.data)
    if (cancelled) await withdrawMentions()
    return c.json({ cancelled })
  } catch (error) {
    console.error('Failed to cancel queued message:', error)
    return c.json({ error: 'Failed to cancel queued message' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/typing - Broadcast typing indicator (auth mode only)
agents.post('/:id/sessions/:sessionId/typing', AgentUser(), async (c) => {
  if (!isAuthMode()) return c.json({ ok: true })

  const sessionId = c.req.param('sessionId')

  // Otherwise this puts the caller's name in the typing indicator of a session
  // in someone else's agent.
  if (!(await agentRegistry.get(getAgentId(c)).sessions.isKnown(sessionId))) {
    return c.json({ error: 'Session not found' }, 404)
  }

  await agentRegistry.get(getAgentId(c)).messages.broadcastEvent(sessionId, {
    type: 'user_typing',
    sender: toUserSender(c.get('user' as never) as UserSenderSource),
  })

  return c.json({ ok: true })
})

// GET /api/agents/:id/sessions/:sessionId - Get a single session
agents.get('/:id/sessions/:sessionId', AgentRead(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const actor = agentRegistry.get(agentSlug)

    // One metadata read serves the session, its fork source's name, and the
    // fields below.
    const metadataMap = await actor.sessions.readMetadata()
    const metadataOf = (id: string) => (Object.hasOwn(metadataMap, id) ? metadataMap[id] : null)
    const metadata = metadataOf(sessionId)
    const session = await actor.sessions.get(sessionId, { metadata })

    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const live = await actor.sessions.live(sessionId)
    let effective: Awaited<ReturnType<typeof resolveConnectionRuntimeInherit>> | null = null
    if (getSettings().llmDefault) {
      try {
        effective = await resolveConnectionRuntimeInherit(metadata ?? {}, await readAgentPreferences(agentSlug), getEffectiveModels())
      } catch (error) {
        // History remains readable during provider/configuration outages.
        // A new turn still resolves and validates its runtime before sending.
        console.warn('Could not resolve session display defaults:', error)
      }
    }
    const pendingWake = await getPendingWakeForSession(agentSlug, sessionId)
    const invokingAgent = metadata?.invokedByAgentSlug
      ? await getAgent(metadata.invokedByAgentSlug)
      : null

    return c.json({
      id: session.id,
      agentSlug: session.agentSlug,
      name: session.name,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      isActive: live.isActive,
      // Carried so single-session consumers can gate on the same live/idle
      // condition the session lists use (the breadcrumb context menu hides
      // "Mark as Unread" while a session is working or awaiting input, since
      // no list renders an unread dot in that state).
      isAwaitingInput: live.isAwaitingInput,
      lastUsage: metadata?.lastUsage,
      scheduledTaskId: metadata?.scheduledTaskId,
      scheduledTaskName: metadata?.scheduledTaskName,
      webhookTriggerId: metadata?.webhookTriggerId,
      webhookTriggerName: metadata?.webhookTriggerName,
      invokedByAgentSlug: metadata?.invokedByAgentSlug,
      invokedByAgentName: metadata?.invokedByAgentSlug
        ? invokingAgent?.frontmatter.name ?? metadata.invokedByAgentSlug
        : undefined,
      isWidgetRepair: metadata?.isWidgetRepair,
      widgetRepairSlug: metadata?.widgetRepairSlug,
      forkedFromSessionId: metadata?.forkedFromSessionId,
      forkedFromSessionName: metadata?.forkedFromSessionId
        ? metadataOf(metadata.forkedFromSessionId)?.name
        : undefined,
      effort: metadata?.effort,
      speed: metadata?.speed,
      model: effective?.model ?? metadata?.model,
      llmProviderId: effective?.llmProviderId ?? metadata?.llmProviderId,
      ...(pendingWake
        ? {
            pendingWakeAt: pendingWake.nextExecutionAt.toISOString(),
            pendingWakeTaskId: pendingWake.id,
            pendingWakeNote: pendingWake.prompt,
          }
        : {}),
    })
  } catch (error) {
    console.error('Failed to fetch session:', error)
    return c.json({ error: 'Failed to fetch session' }, 500)
  }
})

// PATCH /api/agents/:id/sessions/:sessionId - Update a session (e.g., rename)
agents.patch('/:id/sessions/:sessionId', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const body = await c.req.json()
    const { name } = body
    const actor = agentRegistry.get(agentSlug)

    // Guard before renaming so an unknown session never gets metadata written
    // for it — the rename below would otherwise register one.
    if (!(await actor.sessions.isKnown(sessionId))) {
      return c.json({ error: 'Session not found' }, 404)
    }

    if (name?.trim()) {
      await actor.sessions.rename(sessionId, name.trim())
    }

    // Read once, after the rename, rather than on both sides of it: renaming
    // touches metadata only, so the pre-rename read differed from this one by
    // exactly the name.
    const updated = await actor.sessions.get(sessionId)

    if (!updated) {
      return c.json({ error: 'Session not found' }, 404)
    }

    return c.json({
      id: updated.id,
      agentSlug: updated.agentSlug,
      name: updated.name,
      createdAt: updated.createdAt,
      lastActivityAt: updated.lastActivityAt,
    })
  } catch (error) {
    console.error('Failed to update session:', error)
    return c.json({ error: 'Failed to update session' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/unread - Re-raise the unread dot
// DELETE the same path clears it (fired when the session is next opened).
//
// Both verbs are AgentRead, unusually for writes under this path. A mark is
// scoped to the acting user: it raises a dot on their sidebar only, and only
// they can clear it. So there is no shared state to protect — a read-only
// viewer marking their own session unread is no more consequential than the
// notification read state they already flip just by opening a session, and
// gating it higher would leave them unable to dismiss their own dot.
//
// `changed` lets the client skip its cache invalidation on a no-op: the clear
// fires on every session open, and the overwhelmingly common case is a mark
// that was never raised.
async function setUnreadFlag(c: Context, sessionId: string, markedUnread: boolean) {
  try {
    const agentSlug = getAgentId(c)

    // Guard first: writing the flag registers metadata under this id, so an
    // unknown session would otherwise be conjured into the map.
    if (!(await agentRegistry.get(agentSlug).sessions.isKnown(sessionId))) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const userId = getCurrentUserId(c)
    const changed = markedUnread
      ? await markSessionUnread(agentSlug, sessionId, userId)
      : await clearSessionUnread(agentSlug, sessionId, userId)
    return c.json({ success: true, markedUnread, changed })
  } catch (error) {
    console.error('Failed to update session unread flag:', error)
    return c.json({ error: 'Failed to update session unread flag' }, 500)
  }
}

agents.post('/:id/sessions/:sessionId/unread', AgentRead(), async (c) => {
  return setUnreadFlag(c, c.req.param('sessionId'), true)
})

agents.delete('/:id/sessions/:sessionId/unread', AgentRead(), async (c) => {
  return setUnreadFlag(c, c.req.param('sessionId'), false)
})

// POST /api/agents/:id/sessions/:sessionId/fork - Fork Session: copy the
// conversation into a new session carrying the full prior context.
agents.post('/:id/sessions/:sessionId/fork', AgentUser(), async (c) => {
  const slug = getAgentId(c)
  const sourceId = c.req.param('sessionId')
  try {
    const opts: ForkSessionOpts = {}
    if (isAuthMode()) {
      opts.createdByUserId = getCurrentUserId(c)
      const deviceId = getRequestDeviceId(c)
      if (deviceId) opts.createdByDeviceId = deviceId
      opts.copyAttribution = true
    }
    return c.json(await forkSession(slug, sourceId, opts), 201)
  } catch (error) {
    const runtimeError = findAgentRuntimeError(error)
    if (runtimeError) return runtimeError.toHttpResponse()
    console.error('Failed to fork session:', error)
    return c.json({ error: 'Failed to fork session' }, 500)
  }
})

// DELETE /api/agents/:id/sessions/:sessionId - Delete a session
agents.delete('/:id/sessions/:sessionId', AgentAdmin(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const actor = agentRegistry.get(agentSlug)

    // Ownership first: the delete lets go of the session's stream, keyed by
    // session id alone, so on a foreign id it would tear down another agent's
    // live message subscription on the way to a 404. This costs no deletability — it accepts
    // exactly the "transcript OR metadata entry exists" condition that
    // deleteSession itself reports success for.
    if (
      !(await actor.sessions.exists(sessionId)) &&
      !(await actor.sessions.isRegistered(sessionId))
    ) {
      return c.json({ error: 'Session not found' }, 404)
    }

    // deleteSession is the authority for existence here: it removes the JSONL
    // transcript and/or a lingering metadata entry and returns false only when
    // neither existed (the session is truly unknown). Deleting directly, rather
    // than gating on a prior read, keeps a dangling session with only one half
    // left (e.g. a metadata entry whose transcript was already removed)
    // removable instead of wrongly reported as not-found.
    const deleted = await actor.sessions.delete(sessionId)
    if (!deleted) {
      return c.json({ error: 'Session not found' }, 404)
    }

    // A pending wake targeting this session would otherwise fire into nothing
    // and be marked failed — cancel it alongside the session.
    await cancelPendingWakeForSession(agentSlug, sessionId).catch((error) => {
      console.error('Failed to cancel pending wake for deleted session:', error)
    })

    // Clean up message author records for this session: people (auth mode)
    // and integrations (every mode).
    await db.delete(messageAuthor).where(eq(messageAuthor.sessionId, sessionId))

    // Clean up notification rows for this session in BOTH modes (notifications
    // are stored regardless of auth mode; userId is nullable), so deleting a
    // session never leaves stale notification history pointing at it.
    await deleteNotificationsBySessionIds([sessionId])
    // A mark left behind would be an unreachable row: nothing lists the
    // session any more, so nothing could ever clear it.
    await deleteSessionUnreadMarks(agentSlug, [sessionId])
    // A Todo board item started in it goes back to Drafts (or, if finished, keeps its place).
    await unlinkTodosFromSessions(agentSlug, [sessionId])

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to delete session:', error)
    return c.json({ error: 'Failed to delete session' }, 500)
  }
})

// GET /api/agents/:id/sessions/:sessionId/stream - SSE stream for real-time message updates
agents.get('/:id/sessions/:sessionId/stream', AgentRead(), async (c) => {
  // Taken before the first await, so a hangup during it is heard (see waitForClientGone).
  const clientSignal = c.req.raw.signal
  const agentSlug = getAgentId(c)
  const sessionId = c.req.param('sessionId')
  const actor = agentRegistry.get(agentSlug)
  if (!(await actor.sessions.isKnown(sessionId))) {
    return c.json({ error: 'Session not found' }, 404)
  }

  return streamSSE(c, async (stream) => {
    // The client left during the awaits above: nothing to set up for it.
    if (clientSignal.aborted) return
    const clientGone = waitForClientGone(clientSignal, stream)
    // The actor catches the client up (the frames it missed since the last id
    // it got, or a snapshot), then sends every event and a keep-alive ping;
    // each event's frame carries its id, which the browser sends back as
    // Last-Event-ID when it reconnects. The stream ending (the client fell too
    // far behind) ends the response, and the browser reconnects.
    const frames = (await actor.messages.follow(sessionId, { after: c.req.header('Last-Event-ID') })).getReader()
    background(clientGone.then(() => frames.cancel()), { name: 'agents-route.cancel-message-stream' })
    try {
      for (let next = await frames.read(); !next.done; next = await frames.read()) {
        await stream.writeSSE({ id: next.value.id, data: next.value.data, event: 'message' })
      }
    } finally {
      await frames.cancel()
    }
  })
})

// POST /api/agents/:id/sessions/:sessionId/interrupt - Interrupt an active session.
// Body `scope`: 'turn' (default) ends the current turn and leaves background
// tasks (backgrounded Bash, background subagents, workflows) running; 'all' is
// the full stop that kills them too.
const interruptSessionBodySchema = z.object({
  scope: z.enum(['turn', 'all']).default('turn'),
})

agents.post('/:id/sessions/:sessionId/interrupt', AgentUser(), async (c) => {
  const agentSlug = getAgentId(c)
  const sessionId = c.req.param('sessionId')

  // Outside the try on purpose. The stop below marks the session stopped on
  // every path and is keyed by session id alone, so an unowned id reaching it
  // would wipe another agent's live session state and tell its viewers it went idle.
  if (!(await agentRegistry.get(agentSlug).sessions.isKnown(sessionId))) {
    return c.json({ error: 'Session not found' }, 404)
  }

  const rawBody = await c.req.text()
  let parsedBody: unknown = {}
  if (rawBody.trim()) {
    try {
      parsedBody = JSON.parse(rawBody)
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
  }
  const body = interruptSessionBodySchema.safeParse(parsedBody)
  if (!body.success) {
    return c.json({ error: 'Invalid interrupt scope' }, 400)
  }
  try {
    // A turn stop that would leave only untracked background work open is a
    // full stop, without asking: there is no keep/kill choice to offer when
    // the task list is empty. A container that is not running (crashed or
    // restarted while the UI still shows the session active), or an
    // interrupt that fails, still marks the session stopped.
    const result = await agentRegistry.get(agentSlug).messages.stop(sessionId, {
      scope: body.data.scope,
      escalateUntracked: true,
      denyReviews: true,
    })
    if (result.escalated) {
      console.log(`[Agents] Session ${sessionId}: only untracked background work is open — stopped everything instead of the turn`)
    }
    if (result.path === 'not-running') return c.json({ success: true, note: 'Container not running, session marked inactive' })
    if (result.path === 'interrupt-failed') return c.json({ success: true, note: 'Error during interrupt, but session marked inactive' })
    return c.json({ success: true, processKept: result.processKept })
  } catch (error) {
    console.error('Failed to interrupt session:', error)
    return c.json({ error: 'Failed to interrupt session' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/tasks/:taskId/stop - Stop one
// background task (backgrounded Bash, background subagent, workflow) by the
// id the stream reported in background_task_started. The runtime answers on
// the stream with the task's terminal signal, which retires it from the
// session's task list — this route only asks.
const taskIdParamSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/)

agents.post('/:id/sessions/:sessionId/tasks/:taskId/stop', AgentUser(), async (c) => {
  const agentSlug = getAgentId(c)
  const sessionId = c.req.param('sessionId')
  const taskIdParam = taskIdParamSchema.safeParse(c.req.param('taskId'))
  if (!taskIdParam.success) {
    return c.json({ error: 'Invalid task id' }, 400)
  }

  const actor = agentRegistry.get(agentSlug)
  if (!(await actor.sessions.isKnown(sessionId))) {
    return c.json({ error: 'Session not found' }, 404)
  }

  const info = await actor.container.status()
  if (info.status !== 'running') {
    return c.json({ error: 'Agent is not running' }, 409)
  }

  try {
    const stopped = await actor.sessions.stopTask(sessionId, taskIdParam.data)
    if (!stopped) {
      return c.json({ error: 'Task could not be stopped' }, 409)
    }
    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to stop background task:', error)
    return c.json({ error: 'Failed to stop background task' }, 500)
  }
})

/**
 * Whether a request — open or recently settled — belongs to the route the
 * decision arrived on. A caller-supplied toolUseId is an unauthenticated
 * pointer into a global, cross-agent registry, so every dimension of the
 * request's identity has to be re-checked against the URL before the route
 * acts on it (or reports on it): its kind, its agent, and its session.
 *
 * agentSlug is matched unconditionally and exactly. A request whose scope
 * carries no agent is unattributable and matches nothing; every registration
 * path (stream handlers, computer-use, recovery) supplies one.
 */
function requestMatchesRoute(
  request: { kind: UserInputRequestKind; scope: UserInputRequestScope },
  kind: UserInputRequestKind,
  agentSlug: string,
  sessionId: string,
): boolean {
  if (request.kind !== kind) return false
  if (!request.scope.agentSlug || request.scope.agentSlug !== agentSlug) return false
  return request.scope.sessionId === sessionId
}

/**
 * The already-settled gate for request-decision routes. A decision proceeds
 * only while the registry holds the request OPEN, with the kind this route
 * handles, for the agent and session the route addresses. Anything else gets a
 * stable, side-effect-free answer — this is what makes decisions idempotent.
 * Without it a duplicate POST (second tab, double-click, card revived from a
 * stale snapshot) re-runs host side effects: run-script re-executes the
 * script, computer-use re-drives the machine, a browser-input decline
 * re-interrupts the session.
 *
 * Returns a Response to send instead of proceeding, or null to proceed.
 */
async function gateRequestDecision(
  c: Context,
  toolUseId: string,
  kind: UserInputRequestKind,
): Promise<Response | null> {
  const agentSlug = getAgentId(c)
  // Every gated route is mounted under /sessions/:sessionId, so the param is
  // always present; '' is an unmatchable placeholder, not a wildcard.
  const sessionId = c.req.param('sessionId') ?? ''
  // The actor only ever hands back this agent's requests: another agent's
  // parked ask, or one with no agent in its scope, reads as unknown here and
  // falls through to the settled shape below with nothing disclosed.
  const open = await agentRegistry.get(agentSlug).inputs.get(toolUseId)
  if (open) {
    if (!requestMatchesRoute(open, kind, agentSlug, sessionId)) {
      // A caller-supplied id must not settle a wait parked for another kind or
      // session — the same guard submitDecision has for review kinds.
      return c.json({ error: 'Request not found' }, 404)
    }
    return null
  }
  // Settled, or never existed (including another agent's). A settled record is
  // still route-bound: report its outcome only to the route that could have
  // decided it, so settling a request can never widen who may read it. A record
  // that fails the match is as good as absent — same 404 an open mismatch gets.
  const settled = await agentRegistry.get(agentSlug).inputs.recentResolution(toolUseId)
  if (settled && !requestMatchesRoute(settled, kind, agentSlug, sessionId)) {
    return c.json({ error: 'Request not found' }, 404)
  }
  // 200 (not an error): the caller's intent is satisfied or moot, and a stale
  // card should dismiss itself exactly like a successful decision. Unknown and
  // rotated-off-the-trail ids are indistinguishable and share this shape,
  // outcome-less.
  return c.json({
    success: true,
    alreadySettled: true,
    ...(settled ? { outcome: settled.outcome } : {}),
  })
}

/** Read/mutate an open request without settling it. */
async function gateOpenRequestAccess(
  c: Context,
  toolUseId: string,
  kind: UserInputRequestKind,
): Promise<Response | null> {
  const open = await agentRegistry.get(getAgentId(c)).inputs.get(toolUseId)
  if (!open || !requestMatchesRoute(
    open,
    kind,
    getAgentId(c),
    c.req.param('sessionId') ?? '',
  )) {
    return c.json({ error: 'Request not found' }, 404)
  }
  return null
}

// POST /api/agents/:id/sessions/:sessionId/provide-secret - Provide or decline a secret request
agents.post('/:id/sessions/:sessionId/provide-secret', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const body = await c.req.json()
    const { toolUseId, secretName, value, decline, declineReason } = body

    if (!toolUseId) {
      return c.json({ error: 'toolUseId is required' }, 400)
    }

    const gated = await gateRequestDecision(c, toolUseId, 'secret')
    if (gated) return gated

    if (!secretName) {
      return c.json({ error: 'secretName is required' }, 400)
    }


    const actor = agentRegistry.get(agentSlug)

    if (decline) {
      const reason = declineReason || 'User declined to provide the secret'

      const rejectResponse = await actor.container.fetch(
        `/inputs/${encodeURIComponent(toolUseId)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        }
      )

      if (!rejectResponse.ok) {
        const error = await rejectResponse.json()
        console.error('Failed to reject secret request:', error)
        return c.json({ error: 'Failed to reject secret request' }, 500)
      }

      await agentRegistry.get(agentSlug).inputs.complete(c.req.param('sessionId'), toolUseId, 'declined')
      trackServerEvent('request_declined', { type: 'secret', withReason: !!declineReason })
      return c.json({ success: true, declined: true })
    }

    if (!value) {
      return c.json({ error: 'value is required when not declining' }, 400)
    }

    // Save the secret to .env file
    await setSecret(agentSlug, {
      key: secretName,
      envVar: secretName,
      value,
    })

    // Set environment variable in container FIRST
    console.log(`[provide-secret] Setting env var ${secretName} in container`)
    const envResponse = await actor.container.fetch('/env', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: secretName, value }),
    })

    if (!envResponse.ok) {
      let errorDetails = 'Unknown error'
      try {
        const error = await envResponse.json()
        errorDetails = JSON.stringify(error)
      } catch {
        errorDetails = await envResponse.text()
      }
      console.error(`[provide-secret] Failed to set env var: ${errorDetails}`)
      return c.json(
        { error: 'Failed to set environment variable in container' },
        500
      )
    }
    console.log(`[provide-secret] Env var ${secretName} set successfully`)

    // Resolve the pending input request
    console.log(`[provide-secret] Resolving pending request ${toolUseId}`)
    const resolveResponse = await actor.container.fetch(
      `/inputs/${encodeURIComponent(toolUseId)}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      }
    )

    if (!resolveResponse.ok) {
      let errorDetails = 'Unknown error'
      try {
        const error = await resolveResponse.json()
        errorDetails = JSON.stringify(error)
      } catch {
        errorDetails = await resolveResponse.text()
      }
      console.error(
        `[provide-secret] Failed to resolve request: ${errorDetails}`
      )
      return c.json({ error: 'Secret saved but failed to notify agent' }, 500)
    }
    console.log(`[provide-secret] Request ${toolUseId} resolved successfully`)
    await agentRegistry.get(agentSlug).inputs.complete(c.req.param('sessionId'), toolUseId, 'answered')

    return c.json({ success: true, saved: true })
  } catch (error) {
    console.error('Failed to provide secret:', error)
    return c.json({ error: 'Failed to provide secret' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/provide-connected-account - Provide or decline a connected account request
agents.post('/:id/sessions/:sessionId/provide-connected-account', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const body = await c.req.json()
    const { toolUseId, toolkit, accountIds, decline, declineReason } = body

    if (!toolUseId) {
      return c.json({ error: 'toolUseId is required' }, 400)
    }

    const gated = await gateRequestDecision(c, toolUseId, 'connected_account')
    if (gated) return gated

    if (!toolkit) {
      return c.json({ error: 'toolkit is required' }, 400)
    }


    const actor = agentRegistry.get(agentSlug)

    if (decline) {
      const reason = declineReason || 'User declined to provide access'

      const rejectResponse = await actor.container.fetch(
        `/inputs/${encodeURIComponent(toolUseId)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        }
      )

      if (!rejectResponse.ok) {
        const error = await rejectResponse.json()
        console.error('Failed to reject connected account request:', error)
        return c.json({ error: 'Failed to reject request' }, 500)
      }

      await agentRegistry.get(agentSlug).inputs.complete(c.req.param('sessionId'), toolUseId, 'declined')
      trackServerEvent('request_declined', { type: 'connected_account', withReason: !!declineReason })
      return c.json({ success: true, declined: true })
    }

    if (!accountIds || accountIds.length === 0) {
      return c.json(
        { error: 'accountIds is required when not declining' },
        400
      )
    }

    // Get the selected accounts (scoped to user in auth mode)
    const accounts = await db
      .select()
      .from(connectedAccounts)
      .where(and(
        inArray(connectedAccounts.id, accountIds),
        ownerScope(c, connectedAccounts.userId)
      ))

    if (accounts.length === 0) {
      return c.json({ error: 'No valid accounts found' }, 400)
    }

    // Filter to accounts matching the toolkit
    const validAccounts = accounts.filter((a) => a.toolkitSlug === toolkit)
    if (validAccounts.length === 0) {
      return c.json(
        { error: `No accounts found for toolkit '${toolkit}'` },
        400
      )
    }

    // Map accounts to agent (if not already mapped)
    const now = new Date()
    for (const account of validAccounts) {
      try {
        await db.insert(agentConnectedAccounts).values({
          id: crypto.randomUUID(),
          agentSlug,
          connectedAccountId: account.id,
          createdAt: now,
        })
      } catch {
        // Ignore duplicate mapping errors
      }
    }

    // Update CONNECTED_ACCOUNTS metadata in container (no raw tokens)
    console.log(
      `[provide-connected-account] Updating CONNECTED_ACCOUNTS metadata in container`
    )
    // A grant to a session that is waiting on it: the push must happen (a
    // cached "stopped" can be stale) and succeed. Logs the container's refusal itself.
    if (!(await actor.container.syncConnectionEnvironment('connected-accounts', { confirm: true }))) {
      console.error('[provide-connected-account] Failed to update metadata')
      return c.json(
        { error: 'Failed to update account metadata in container' },
        500
      )
    }
    console.log(
      `[provide-connected-account] CONNECTED_ACCOUNTS metadata updated`
    )

    // Resolve the pending input request
    console.log(
      `[provide-connected-account] Resolving pending request ${toolUseId}`
    )
    const accountNames = validAccounts.map((a) => a.displayName)
    const resolveResponse = await actor.container.fetch(
      `/inputs/${encodeURIComponent(toolUseId)}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          value: `Access granted to ${accountNames.length} account(s): ${accountNames.join(', ')}`,
        }),
      }
    )

    if (!resolveResponse.ok) {
      let errorDetails = 'Unknown error'
      try {
        const error = await resolveResponse.json()
        errorDetails = JSON.stringify(error)
      } catch {
        errorDetails = await resolveResponse.text()
      }
      console.error(
        `[provide-connected-account] Failed to resolve request: ${errorDetails}`
      )
      return c.json({ error: 'Accounts mapped but failed to notify agent' }, 500)
    }
    console.log(
      `[provide-connected-account] Request ${toolUseId} resolved successfully`
    )
    await agentRegistry.get(agentSlug).inputs.complete(c.req.param('sessionId'), toolUseId, 'answered')

    return c.json({
      success: true,
      accountsProvided: validAccounts.length,
    })
  } catch (error: unknown) {
    console.error('Failed to provide connected account:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return c.json(
      { error: 'Failed to provide connected account', details: message },
      500
    )
  }
})

// POST /api/agents/:id/sessions/:sessionId/answer-question - Answer or decline a question request
agents.post('/:id/sessions/:sessionId/answer-question', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const body = await c.req.json()
    const { toolUseId, answers, decline, declineReason } = body

    if (!toolUseId) {
      return c.json({ error: 'toolUseId is required' }, 400)
    }

    const gated = await gateRequestDecision(c, toolUseId, 'question')
    if (gated) return gated


    const actor = agentRegistry.get(agentSlug)

    if (decline) {
      const reason = declineReason || 'User declined to answer'

      const rejectResponse = await actor.container.fetch(
        `/inputs/${encodeURIComponent(toolUseId)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        }
      )

      if (!rejectResponse.ok) {
        const error = await rejectResponse.json()
        console.error('Failed to reject question request:', error)
        return c.json({ error: 'Failed to reject question request' }, 500)
      }

      await agentRegistry.get(agentSlug).inputs.complete(c.req.param('sessionId'), toolUseId, 'declined')
      trackServerEvent('request_declined', { type: 'question', withReason: !!declineReason })
      return c.json({ success: true, declined: true })
    }

    if (!answers || typeof answers !== 'object') {
      return c.json({ error: 'answers is required when not declining' }, 400)
    }

    // Resolve the pending input request with the answers
    console.log(`[answer-question] Resolving pending request ${toolUseId}`)
    const resolveResponse = await actor.container.fetch(
      `/inputs/${encodeURIComponent(toolUseId)}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: answers }),
      }
    )

    if (!resolveResponse.ok) {
      let errorDetails = 'Unknown error'
      try {
        const error = await resolveResponse.json()
        errorDetails = JSON.stringify(error)
      } catch {
        errorDetails = await resolveResponse.text()
      }
      console.error(`[answer-question] Failed to resolve request: ${errorDetails}`)
      return c.json({ error: 'Failed to submit answers' }, 500)
    }
    console.log(`[answer-question] Request ${toolUseId} resolved successfully`)
    await agentRegistry.get(agentSlug).inputs.complete(c.req.param('sessionId'), toolUseId, 'answered')

    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to answer question:', error)
    return c.json({ error: 'Failed to answer question' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/capability-review - Approve or block a
// subagent/workflow launch paused by a 'review' policy. Approve resolves the
// container's pending input ({ scope: 'once' | 'session' }); block rejects it
// (the reason becomes the deny message the model adapts to).
agents.post('/:id/sessions/:sessionId/capability-review', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const body = await c.req.json()
    const { toolUseId, capability, decline, declineReason } = body
    const scope = body.scope === 'session' ? 'session' : 'once'

    if (!toolUseId) {
      return c.json({ error: 'toolUseId is required' }, 400)
    }
    if (capability !== 'subagents' && capability !== 'workflows') {
      return c.json({ error: 'capability must be subagents or workflows' }, 400)
    }

    const gated = await gateRequestDecision(c, toolUseId, 'capability_review')
    if (gated) return gated

    const actor = agentRegistry.get(agentSlug)

    if (decline) {
      const reason = declineReason || 'User declined'

      const rejectResponse = await actor.container.fetch(
        `/inputs/${encodeURIComponent(toolUseId)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        }
      )

      if (!rejectResponse.ok) {
        const error = await rejectResponse.json()
        console.error('Failed to reject capability launch:', error)
        return c.json({ error: 'Failed to reject capability launch' }, 500)
      }

      await agentRegistry.get(agentSlug).inputs.completeCapabilityReview(sessionId, toolUseId, 'declined')
      trackServerEvent('request_declined', { type: 'capability_review', capability, withReason: !!declineReason })
      return c.json({ success: true, declined: true })
    }

    const resolveResponse = await actor.container.fetch(
      `/inputs/${encodeURIComponent(toolUseId)}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: { scope } }),
      }
    )

    if (!resolveResponse.ok) {
      let errorDetails = 'Unknown error'
      try {
        const error = await resolveResponse.json()
        errorDetails = JSON.stringify(error)
      } catch {
        errorDetails = await resolveResponse.text()
      }
      console.error(`[capability-review] Failed to resolve request: ${errorDetails}`)
      return c.json({ error: 'Failed to approve launch' }, 500)
    }

    // Mirror the container's grant so later launches in this session don't
    // produce review cards nothing is waiting on.
    if (scope === 'session') {
      await agentRegistry.get(agentSlug).sessions.grantCapability(sessionId, capability)
    }
    await agentRegistry.get(agentSlug).inputs.completeCapabilityReview(sessionId, toolUseId, 'answered')

    trackServerEvent('capability_launch_approved', { capability, scope })
    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to handle capability review:', error)
    return c.json({ error: 'Failed to handle capability review' }, 500)
  }
})

async function readCredentialBrowserUrl(agentSlug: string, sessionId: string): Promise<string> {
  const actor = agentRegistry.get(agentSlug)
  const response = await actor.container.fetch(
    `/browser/credential-context?sessionId=${encodeURIComponent(sessionId)}`,
  )
  if (!response.ok) throw new CredentialBrokerError('provider_error', 'The active browser page is unavailable')
  const parsed = credentialContextResponseSchema.safeParse(
    await response.json().catch(() => null),
  )
  if (!parsed.success) {
    throw new CredentialBrokerError('provider_error', 'The active browser page is unavailable')
  }
  return parsed.data.url
}

function credentialBrokerErrorResponse(
  c: Context,
  error: unknown,
  fallbackMessage = 'Credential autofill failed',
): Response {
  if (!(error instanceof CredentialBrokerError)) {
    return c.json({ error: fallbackMessage }, 500)
  }
  const status = error.code === 'invalid_url' ? 400
    : error.code === 'provider_error' ? 502
      : 409
  return c.json({ error: error.message, code: error.code }, status)
}

function configuredPasswordManagers(): string[] {
  const configured = getSettings().app?.configuredPasswordManagers
  return Array.isArray(configured)
    ? configured.filter((provider): provider is string => typeof provider === 'string')
    : []
}

function passwordManagerIsConfigured(provider: string): boolean {
  return configuredPasswordManagers().includes(provider)
}

const BROWSER_CONTEXT_TTL_MS = 30_000
const credentialContextResponseSchema = z.object({
  url: z.string().min(1),
})
const credentialFillResponseSchema = z.object({
  usernameFilled: z.boolean(),
  passwordFilled: z.boolean(),
})
const credentialErrorResponseSchema = z.object({
  error: z.string(),
  reason: z.enum(['origin_changed', 'no_password_field']).optional(),
})
const browserInputContextSchema = z.object({
  url: z.string().min(1),
  capturedAt: z.number().finite(),
})
const browserCredentialCheckBodySchema = z.object({
  toolUseId: z.string().min(1),
  provider: z.string().min(1),
}).strict()
const browserCredentialVerifyBodySchema = browserCredentialCheckBodySchema.extend({
  code: z.string().regex(/^\d{6}$/, 'Enter the six-digit verification code'),
}).strict()
const browserCredentialAutofillBodySchema = z.object({
  toolUseId: z.string().min(1),
  credentialId: z.string().min(1),
}).strict()

async function capturedBrowserInputUrl(agentSlug: string, toolUseId: string, now = Date.now()): Promise<string | null> {
  const request = await agentRegistry.get(agentSlug).inputs.get(toolUseId)
  if (!request || request.kind !== 'browser_input') return null
  const parsed = browserInputContextSchema.safeParse(request.payload.browserContext)
  if (!parsed.success) return null
  const age = now - parsed.data.capturedAt
  return age >= 0 && age <= BROWSER_CONTEXT_TTL_MS ? parsed.data.url : null
}

async function refreshBrowserInputUrl(
  agentSlug: string,
  sessionId: string,
  toolUseId: string,
): Promise<string> {
  const url = await readCredentialBrowserUrl(agentSlug, sessionId)
  await agentRegistry.get(agentSlug).inputs.enrich(toolUseId, 'browser_input', {
    browserContext: { url, capturedAt: Date.now() },
  })
  return url
}

/**
 * The open request a password-manager lookup belongs to: a browser hand-off,
 * or a sign-in form (request_login), whose fields' frame is the page.
 */
async function gateCredentialRequest(c: Context, toolUseId: string): Promise<Response | 'browser_input' | 'login'> {
  const open = await agentRegistry.get(getAgentId(c)).inputs.get(toolUseId)
  const kind = open?.kind === 'login' ? 'login' : 'browser_input'
  return (await gateOpenRequestAccess(c, toolUseId, kind)) ?? kind
}

/** The sign-in form's context when it can be read now; null while it cannot. */
async function loginRequestContext(agentSlug: string, toolUseId: string): Promise<LoginContext | null> {
  const read = await readLoginContext(agentSlug, toolUseId)
  return read.ok ? read.context : null
}

// GET /api/agents/:id/sessions/:sessionId/browser-credentials - Metadata-only suggestions
agents.get('/:id/sessions/:sessionId/browser-credentials', IsAdmin(), async (c) => {
  const toolUseId = c.req.query('toolUseId')
  if (!toolUseId) return c.json({ error: 'toolUseId is required' }, 400)
  const kind = await gateCredentialRequest(c, toolUseId)
  if (kind instanceof Response) return kind

  const agentSlug = getAgentId(c)
  const sessionId = c.req.param('sessionId')
  try {
    let url: string
    if (kind === 'login') {
      const context = await loginRequestContext(agentSlug, toolUseId)
      if (!context) return c.json({ error: 'The sign-in form is not ready yet' }, 409)
      url = context.url
    } else {
      // New requests carry a harness-probed URL. Explicit refreshes and stale or
      // recovered requests re-probe the live browser and replace that context.
      const forceRefresh = c.req.query('refresh') === 'true'
      url = (!forceRefresh && await capturedBrowserInputUrl(agentSlug, toolUseId)) ||
        await refreshBrowserInputUrl(agentSlug, sessionId, toolUseId)
    }
    const result = await credentialBroker.suggest(
      { agentSlug, sessionId, toolUseId },
      url,
      configuredPasswordManagers(),
    )
    return c.json(result)
  } catch (error) {
    return credentialBrokerErrorResponse(c, error, 'Credential lookup failed')
  }
})

// POST .../browser-credentials/check - Start the configured provider's ephemeral session.
agents.post(
  '/:id/sessions/:sessionId/browser-credentials/check',
  IsAdmin(),
  zValidator('json', browserCredentialCheckBodySchema),
  async (c) => {
  try {
    const body = c.req.valid('json')
    const gated = await gateCredentialRequest(c, body.toolUseId)
    if (gated instanceof Response) return gated
    if (!passwordManagerIsConfigured(body.provider)) {
      return c.json({ error: 'Configure this password manager in Browser Use settings' }, 409)
    }
    const status = await credentialBroker.beginPairing(body.provider)
    return c.json({
      success: true,
      status: status.status === 'ready' ? 'connected' : 'verification_required',
      ...(status.status === 'pin_required'
        ? {
            verification: {
              type: 'numeric_code',
              length: 6,
              message: 'Enter the code shown by your password manager.',
            },
          }
        : {}),
    })
  } catch (error) {
    return credentialBrokerErrorResponse(c, error, 'Password manager check failed')
  }
  },
)

// POST .../browser-credentials/verify - Complete the active password-manager check.
agents.post(
  '/:id/sessions/:sessionId/browser-credentials/verify',
  IsAdmin(),
  zValidator('json', browserCredentialVerifyBodySchema),
  async (c) => {
  try {
    const body = c.req.valid('json')
    const gated = await gateCredentialRequest(c, body.toolUseId)
    if (gated instanceof Response) return gated
    if (!passwordManagerIsConfigured(body.provider)) {
      return c.json({ error: 'Configure this password manager in Browser Use settings' }, 409)
    }
    await credentialBroker.completePairing(body.provider, body.code)
    return c.json({ success: true, status: 'connected' })
  } catch (error) {
    return credentialBrokerErrorResponse(c, error, 'Password manager verification failed')
  }
  },
)

// POST /api/agents/:id/sessions/:sessionId/autofill-browser-credential - Privileged JIT fill
agents.post(
  '/:id/sessions/:sessionId/autofill-browser-credential',
  IsAdmin(),
  zValidator('json', browserCredentialAutofillBodySchema),
  async (c) => {
  let claimed: { id: string; token: string } | null = null
  try {
    const body = c.req.valid('json')
    const gated = await gateOpenRequestAccess(c, body.toolUseId, 'browser_input')
    if (gated) return gated
    const claim = await agentRegistry.get(getAgentId(c)).inputs.claim(body.toolUseId)
    if (!claim) {
      return c.json({ error: 'This browser request is already being handled' }, 409)
    }
    claimed = { id: body.toolUseId, token: claim.token }

    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const url = await readCredentialBrowserUrl(agentSlug, sessionId)
    const retrieved = await credentialBroker.retrieve(
      { agentSlug, sessionId, toolUseId: body.toolUseId },
      body.credentialId,
      url,
    )
    const credential = retrieved.credential

    const actor = agentRegistry.get(agentSlug)
    const fillResponse = await actor.container.fetch('/browser/fill-credential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        username: credential.username,
        password: credential.password,
        expectedOrigin: retrieved.expectedOrigin,
      }),
    })
    if (!fillResponse.ok) {
      const fillError = credentialErrorResponseSchema.safeParse(
        await fillResponse.json().catch(() => null),
      )
      if (fillResponse.status === 409 && fillError.success &&
          fillError.data.reason === 'no_password_field') {
        // Keep the browser request open so the user can paste the values and
        // complete the step themselves. This is intentionally limited to the
        // stable-origin, missing-field case; never disclose on navigation or
        // an unclassified browser failure.
        c.header('Cache-Control', 'no-store')
        return c.json({
          error: fillError.data.error,
          reason: fillError.data.reason,
          manualCredential: {
            username: credential.username,
            password: credential.password,
          },
        }, 409)
      }
      return c.json({
        error: fillError.success ? fillError.data.error : 'Credential autofill failed',
      }, fillResponse.status === 409 ? 409 : 502)
    }
    const parsedFill = credentialFillResponseSchema.safeParse(
      await fillResponse.json().catch(() => null),
    )
    if (!parsedFill.success) {
      throw new CredentialBrokerError('provider_error', 'The browser returned an invalid autofill result')
    }

    // Autofill is the successful answer to this browser-input request. Resume
    // the parked tool with explicit next-step guidance instead of making the
    // user click Done after they already selected a credential.
    const resolveResponse = await actor.container.fetch(
      `/inputs/${encodeURIComponent(body.toolUseId)}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'credentials_filled' }),
      },
    )
    const requestSettled = resolveResponse.ok
    if (requestSettled) {
      await agentRegistry.get(agentSlug).inputs.complete(sessionId, body.toolUseId, 'answered')
    } else {
      console.error('[autofill-browser-credential] Credentials filled but browser input could not be resolved')
    }

    return c.json({
      success: true,
      usernameFilled: parsedFill.data.usernameFilled,
      passwordFilled: parsedFill.data.passwordFilled,
      requestSettled,
    })
  } catch (error) {
    return credentialBrokerErrorResponse(c, error)
  } finally {
    if (claimed) await agentRegistry.get(getAgentId(c)).inputs.releaseClaim(claimed.id, claimed.token)
  }
  },
)

// ── Sign-in requests (request_login) ────────────────────────────────────────
// The agent maps a page's sign-in fields; the host answers from the user's
// vault when it can (browser-vault/login-host), and otherwise the user types
// the values into the app's form. Values only go to the container's page
// writer: never logged, echoed, or stored except, sealed, in the vault.

/**
 * A form for this app itself, at any of its addresses (see isOwnOrigin):
 * signing the agent's browser in there would hand it the user's session here.
 */
function signsInToThisApp(c: Context, origin: string): boolean {
  return isOwnOrigin(origin, [c.req.header('origin'), c.req.url])
}

function thisAppProblem(origin: string) {
  return {
    error: 'This sign-in form is for this app itself',
    // The form offers no way around it: not even signing in on the page by hand.
    reason: 'this_app' as const,
    problems: [`The fields are on ${origin}, this app's own address: the agent's browser is not signed in to it.`],
  }
}

// GET /api/agents/:id/sessions/:sessionId/login-request - Where the fields are
agents.get('/:id/sessions/:sessionId/login-request', AgentUser(), async (c) => {
  const toolUseId = c.req.query('toolUseId')
  if (!toolUseId) return c.json({ error: 'toolUseId is required' }, 400)
  const gated = await gateOpenRequestAccess(c, toolUseId, 'login')
  if (gated) return gated

  const read = await readLoginContext(getAgentId(c), toolUseId)
  if (!read.ok) return c.json({ error: read.error, problems: read.problems }, read.status)
  if (signsInToThisApp(c, read.context.origin)) return c.json(thisAppProblem(read.context.origin), 409)
  return c.json(read.context)
})

// GET /api/agents/:id/sessions/:sessionId/login-request/vault - The viewer's saved accounts for the request's site
agents.get('/:id/sessions/:sessionId/login-request/vault', AgentUser(), async (c) => {
  c.header('Cache-Control', 'no-store')
  const toolUseId = c.req.query('toolUseId')
  if (!toolUseId) return c.json({ error: 'toolUseId is required' }, 400)
  const gated = await gateOpenRequestAccess(c, toolUseId, 'login')
  if (gated) return gated

  // The vault is the person's own: a meeting page's credential never reads it.
  if (getMeetingParticipant(c)) return c.json({ error: 'Forbidden' }, 403)

  const agentSlug = getAgentId(c)
  const read = await readLoginContext(agentSlug, toolUseId)
  if (!read.ok) return c.json({ error: read.error }, read.status)
  const pageOrigin = read.context.origin
  const site = siteOfOrigin(pageOrigin)
  if (!site || signsInToThisApp(c, pageOrigin)) return c.json({ error: 'This sign-in form has no site to save accounts for' }, 409)
  const viewer = getViewerUserId(c)
  const [accounts, providerAccounts, otherMembers] = await Promise.all([
    listOwnedAccountsOnSite(viewer, site),
    listOwnedAccountsElsewhere(viewer, site),
    isAuthMode() ? countOtherMembers(agentSlug, viewer) : Promise.resolve(0),
  ])
  const granted = new Set(await listGrantedAccountIds(agentSlug, [...accounts, ...providerAccounts].map((account) => account.id)))
  const offer = (account: VaultAccount) => {
    const view = accountView(account)
    return {
      ...view,
      id: account.id,
      via: view.via && account.via ? { ...view.via, id: account.via.id } : null,
      granted: granted.has(account.id),
      // Its saved parts go into this page (none saved on https go to plain HTTP).
      fillsHere: vaultFillsInto(account.origin, pageOrigin),
    }
  }
  return c.json({
    site,
    otherMembers,
    identity: recentSignInIdentity(agentSlug, c.req.param('sessionId'), site),
    accounts: accounts.map(offer),
    providerAccounts: providerAccounts.map((account) => ({
      ...offer(account),
      site: account.site,
      providerName: providerName(account.site),
      providerId: providerOf(account.site)?.id ?? null,
    })),
    // Never the site's own: not GitHub on github.com's sign-in page.
    providers: SIGN_IN_PROVIDERS.filter((provider) => provider.site !== registrableDomain(site)),
  })
})

/** Let the agent sign in with the account, logged when it is new. */
async function grantToAgent(viewer: VaultOwner, agentSlug: string, accountId: string): Promise<void> {
  if (await grantAccount({ accountId, agentSlug, grantedBy: viewer })) {
    await logAuditEvent({ userId: viewer, object: 'browser_account', objectId: accountId, action: 'assigned', details: { agentSlug } })
  }
}

/** What the user entered, saved to their account on the site (made, or its parts added), for the agent to use. */
async function saveAndGrant(
  viewer: VaultOwner,
  agentSlug: string,
  input: { site: string; origin: string; username: string; values: Record<string, string> },
): Promise<VaultAccount> {
  const result = await saveAccount({ owner: viewer, ...input })
  await logAuditEvent({ userId: viewer, object: 'browser_account', objectId: result.account.id, action: result.created ? 'created' : 'updated', details: { site: input.site } })
  await grantToAgent(viewer, agentSlug, result.account.id)
  return result.account
}

// POST /api/agents/:id/sessions/:sessionId/fill-login - Write the user's values into the page
agents.post('/:id/sessions/:sessionId/fill-login', AgentUser(), async (c) => {
  let claimed: { id: string; token: string } | null = null
  c.header('Cache-Control', 'no-store')
  try {
    // Parsed by hand: a validator's error response could quote the values.
    const parsed = fillLoginBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid sign-in request' }, 400)
    const body = parsed.data
    const gated = await gateRequestDecision(c, body.toolUseId, 'login')
    if (gated) return gated

    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const actor = agentRegistry.get(agentSlug)
    // The values go only to the origin the browser reported and the form
    // showed — never to one the client names.
    const read = await readLoginContext(agentSlug, body.toolUseId)
    if (!read.ok || read.context.origin !== body.origin) {
      return c.json({ error: 'The sign-in form changed. Reload it and try again.' }, 409)
    }
    const context = read.context
    if (signsInToThisApp(c, context.origin)) return c.json({ error: thisAppProblem(context.origin).error }, 409)
    const site = siteOfOrigin(context.origin)
    if (!site || context.fields.length === 0) return c.json({ error: 'This sign-in request has no field to fill' }, 409)
    const heldValues = body.heldValues ?? []
    if (body.values.length !== context.fields.length || heldValues.length > context.held.length) {
      return c.json({ error: 'One value per field is required' }, 400)
    }
    const viewer = getViewerUserId(c)
    const request = await actor.inputs.get(body.toolUseId)
    const vault = loginVaultPayloadSchema.safeParse(request?.payload.vault)

    // A saved account fills what the user left empty: the one the host left
    // the request for (for the parts it lacks), one this agent may use, or
    // one of the user's own, which using here grants. The host's one may have
    // been deleted or revoked since: the form then asks for every field.
    const hostsAccount = vault.success && vault.data.mode === 'complete' && vault.data.accountId === body.accountId
    let account: VaultAccount | null = null
    let grantsAccount = false
    if (body.accountId) {
      account = (await isAccountGranted(agentSlug, body.accountId)) ? await getAccount(body.accountId) : null
      if (!account && !hostsAccount) {
        account = await getOwnedAccount(viewer, body.accountId)
        grantsAccount = account !== null
      }
      if (!account || account.site !== site) {
        return c.json({ error: 'That saved account is no longer available here. Enter the details instead.', reason: 'account_unavailable' }, 409)
      }
    }
    const typedUsername = context.fields.findIndex((field) => field.kind === 'username')
    const identity = (typedUsername >= 0 ? body.values[typedUsername]?.trim() : '') ||
      account?.username ||
      body.username ||
      (vault.success ? vault.data.username : undefined) ||
      recentSignInIdentity(agentSlug, sessionId, site) ||
      null
    if (body.save && !identity) return c.json({ error: 'Enter the username of this account to save it' }, 400)
    if (body.save && identity && identity.length > MAX_USERNAME) return c.json({ error: 'That username is too long to save' }, 400)
    const held = usableHeld(heldLoginFor(agentSlug, sessionId, site, identity ?? undefined), context.origin)
    const saved = account && vaultFillsInto(account.origin, context.origin) ? await readAccountValues(account.id) : {}
    const fallback = valuesFor(context.fields, identity, { ...saved, ...(held?.values ?? {}) })
    const values = body.values.map((value, index) => value || fallback[index])
    // A field the form left to the vault that it cannot fill now (what was
    // held for this step expired, the account no longer holds it): the user
    // is asked for it, rather than the page getting it empty.
    const needed = values.flatMap((value, index) => (value ? [] : [index]))
    if (needed.length > 0) return c.json({ error: 'Enter what the saved account could not fill.', reason: 'fields_needed', fields: needed }, 409)
    // Held parts this fill uses (the fields the user left for them), and the
    // ones the user typed over: theirs is newer, so the held one goes.
    const heldPart = (index: number) => {
      const part = partKeyOf(context.fields[index])
      return part && held?.values[part] ? part : null
    }
    const fromHeld = context.fields.flatMap((_, index) => (!body.values[index] && heldPart(index) ? [heldPart(index)!] : []))
    const typedOverHeld = context.fields.flatMap((_, index) => (body.values[index] && heldPart(index) ? [heldPart(index)!] : []))
    // The user picked a saved account the site had turned down, as it is.
    const usesSavedPassword = context.fields.some((field, index) => field.kind === 'password' && !body.values[index] && !held?.values.password && Boolean(saved.password))
    if (body.save || grantsAccount) {
      const refused = await sharedAgentRefusal(c, agentSlug, body.sharedAgentAcknowledged)
      if (refused) return refused
    }

    const claim = await actor.inputs.claim(body.toolUseId)
    if (!claim) return c.json({ error: 'This sign-in request is already being handled' }, 409)
    claimed = { id: body.toolUseId, token: claim.token }

    const heldParts = partsFrom(context.held, heldValues)
    const heldLabels = context.held.filter((field, index) => heldValues[index] && heldParts[partKeyOf(field) ?? '']).map((field) => field.label)
    const saving = Boolean(body.save && identity)

    const shown = noteUsername(identity)
    const filled = await fillLoginInContainer(agentSlug, sessionId, body.toolUseId, context, values, {
      ...(shown ? { username: shown } : {}),
      site,
      // A saved account the user picked, as it is: the agent is told it by name.
      source: account && !body.values.some(Boolean) ? 'vault' : 'user',
      saved: saving,
      held: heldLabels,
    })
    // The browser that showed the form closed while the user was away (a
    // Browserbase session ends long before they come back): nothing can go
    // into a page now, and the user is not asked twice. The agent is told
    // to open the page again, and its next try signs in with what the user
    // did here: the account they picked, now granted; what they entered,
    // saved to their vault when they chose to, else held here a while.
    if (!filled.ok && filled.browserClosed) {
      if (grantsAccount && account) await grantToAgent(viewer, agentSlug, account.id)
      // This step's values and the next step's go by this step's choice;
      // what earlier steps held, by theirs.
      const entered = { ...partsFrom(context.fields, body.values), ...heldParts }
      const earlier = held?.values ?? {}
      let kept: { how: 'saved' | 'picked' | 'vault' | 'held'; username?: string } | null = null
      if (saving && identity) {
        try {
          const savedNow = await saveAndGrant(viewer, agentSlug, { site, origin: context.origin, username: identity, values: { ...(held?.save ? earlier : {}), ...entered } })
          kept = { how: 'saved', username: savedNow.username }
          if (held?.save) forgetHeldLogin(agentSlug, sessionId, site)
        } catch (error) {
          // Held instead, below: the agent's next try still needs no one.
          console.error('[fill-login] Saving the account failed:', error instanceof Error ? error.message : 'Unknown error')
        }
      }
      if (!kept && Object.keys({ ...earlier, ...entered }).length > 0) {
        holdLoginValues(agentSlug, sessionId, site, {
          username: identity,
          values: { ...earlier, ...entered },
          origin: held && Object.keys(entered).length === 0 ? held.origin : context.origin,
          // Nothing typed now: the earlier step's choice stands. Typed now without saving: nothing is saved.
          save: Object.keys(entered).length === 0 ? held?.save ?? null : null,
        })
        kept = { how: 'held', ...(shown ? { username: shown } : {}) }
      }
      // The account itself: one the user picked, or the one the host was signing in with.
      if (!kept && account) kept = { how: hostsAccount ? 'vault' : 'picked', username: account.username }
      const answered = await answerLoginRequest(agentSlug, body.toolUseId, { type: 'browser_closed', site, ...(kept ? { kept } : {}) })
      if (!answered) return c.json({ error: 'The agent could not be told. Try again.' }, 502)
      await actor.inputs.complete(sessionId, body.toolUseId, 'answered')
      claimed = null
      if (identity) rememberSignInIdentity(agentSlug, sessionId, site, identity)
      trackServerEvent('login_request_browser_closed', { kept: kept?.how ?? 'nothing' })
      return c.json({ success: true, browserClosed: true, ...(kept ? { kept: { how: kept.how, username: kept.username ?? null } } : {}) })
    }
    // Still open on failure: the user can try again or sign in on the page.
    // Nothing is saved, granted or held for a step that never went in.
    if (!filled.ok) return c.json({ error: filled.error }, filled.status)
    claimed = null

    let savedAccount: VaultAccount | null = null
    let saveError: string | undefined
    if (saving && identity) {
      try {
        // What the user typed here, by part: the username is the account itself.
        savedAccount = await saveAndGrant(viewer, agentSlug, { site, origin: context.origin, username: identity, values: partsFrom(context.fields, body.values) })
      } catch (error) {
        // The page has the values either way; the user is told it was not saved.
        console.error('[fill-login] Saving the account failed:', error instanceof Error ? error.message : 'Unknown error')
        saveError = error instanceof VaultConflictError ? error.message : 'The account could not be saved'
      }
    }
    if (grantsAccount && account) await grantToAgent(viewer, agentSlug, account.id)
    // Only what went into the page counts: the browser may have written none of it.
    const wentIn = fieldsWentIn(filled.result, context.fields.length)
    const passwordWentIn = context.fields.some((field, index) => field.kind === 'password' && wentIn[index])
    // The step that was held is done before the next one is held.
    const usedHeld = fromHeld.filter((part) => context.fields.some((field, index) => partKeyOf(field) === part && wentIn[index]))
    if (held) await settleHeldParts({ agentSlug, sessionId, site, held, used: usedHeld, username: identity })
    if (typedOverHeld.length) releaseHeldValues(agentSlug, sessionId, site, typedOverHeld)
    if (account?.rejectedAt && usesSavedPassword && passwordWentIn && !hostsAccount) await clearAccountRejected(account.id)
    if (heldLabels.length) {
      holdLoginValues(agentSlug, sessionId, site, {
        username: identity,
        values: heldParts,
        origin: context.origin,
        save: body.save ? { owner: viewer, origin: context.origin } : null,
      })
    }
    if (identity) rememberSignInIdentity(agentSlug, sessionId, site, identity)
    // The account the values were for, and whether its password went in: a
    // password tried counts toward how often the vault fills it without the user.
    const usedAccount = savedAccount ?? account
    if (usedAccount && wentIn.some(Boolean)) {
      await recordAccountUse({ agentSlug, accountId: usedAccount.id, sessionId, userId: viewer, password: passwordWentIn, by: 'user' })
    }
    trackServerEvent('login_request_filled', {
      submitted: filled.result.submitted,
      filled: filled.result.filled,
      failed: filled.result.failed,
      source: account ? 'form_with_vault' : 'form',
      saved: savedAccount !== null,
      held: heldLabels.length,
    })
    return c.json({
      ...filled.result,
      ...(savedAccount ? { saved: { username: savedAccount.username, site } } : {}),
      ...(saveError ? { saveError } : {}),
    })
  } catch (error) {
    if (error instanceof VaultConflictError) return c.json({ error: error.message }, 409)
    console.error('[fill-login] Failed:', error instanceof Error ? error.message : 'Unknown error')
    return c.json({ error: 'The sign-in form could not be filled' }, 500)
  } finally {
    if (claimed) await agentRegistry.get(getAgentId(c)).inputs.releaseClaim(claimed.id, claimed.token)
  }
})

// POST /api/agents/:id/sessions/:sessionId/login-via - "Or sign in with Google, …"
agents.post('/:id/sessions/:sessionId/login-via', AgentUser(), zValidator('json', loginViaBodySchema), async (c) => {
  let claimed: { id: string; token: string } | null = null
  try {
    const body = c.req.valid('json')
    const gated = await gateRequestDecision(c, body.toolUseId, 'login')
    if (gated) return gated

    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const actor = agentRegistry.get(agentSlug)
    const read = await readLoginContext(agentSlug, body.toolUseId)
    if (!read.ok || read.context.origin !== body.origin) {
      return c.json({ error: 'The sign-in form changed. Reload it and try again.' }, 409)
    }
    const context = read.context
    if (signsInToThisApp(c, context.origin)) return c.json({ error: thisAppProblem(context.origin).error }, 409)
    const site = siteOfOrigin(context.origin)
    if (!site) return c.json({ error: 'This sign-in form has no site to save accounts for' }, 409)
    const viewer = getViewerUserId(c)

    // The provider account: one of the user's saved accounts, or a known provider and a username.
    let provider: VaultAccount | null = null
    let known: (typeof SIGN_IN_PROVIDERS)[number] | undefined
    if ('accountId' in body.provider) {
      provider = await getOwnedAccount(viewer, body.provider.accountId)
      if (!provider) return c.json({ error: 'That saved account was not found' }, 404)
    } else {
      known = SIGN_IN_PROVIDERS.find((candidate) => candidate.id === (body.provider as { providerId: string }).providerId)
      if (!known) return c.json({ error: 'Unknown sign-in provider' }, 400)
    }
    const providerSite = provider?.site ?? known!.site
    const providerUsername = provider?.username ?? (body.provider as { username: string }).username
    if (registrableDomain(providerSite) === registrableDomain(site)) return c.json({ error: 'An account cannot sign in through its own site' }, 400)
    if (providerUsername.length > MAX_USERNAME) return c.json({ error: 'That username is too long to save' }, 400)
    // Granting needs the user to have seen who else can use the agent — not
    // when this agent may already use the site account.
    const existing = (await listOwnedAccountsOnSite(viewer, site)).find((account) => usernameKey(account.username) === usernameKey(providerUsername))
    if (!existing || !(await isAccountGranted(agentSlug, existing.id))) {
      const refused = await sharedAgentRefusal(c, agentSlug, body.sharedAgentAcknowledged)
      if (refused) return refused
    }
    // The provider account by name: the one saved on its sign-in site, or a
    // new one with no value yet (its password is saved where its form is).
    provider ??= await findOwnedProviderAccount(viewer, providerSite, providerUsername)
    if (!provider) {
      provider = (await saveAccount({ owner: viewer, site: providerSite, origin: `https://${providerSite}`, username: providerUsername })).account
      await logAuditEvent({ userId: viewer, object: 'browser_account', objectId: provider.id, action: 'created', details: { site: providerSite } })
    }

    const claim = await actor.inputs.claim(body.toolUseId)
    if (!claim) return c.json({ error: 'This sign-in request is already being handled' }, 409)
    claimed = { id: body.toolUseId, token: claim.token }

    // An account that had a password signs in through the provider from now
    // on: the password goes, or the vault would keep filling it.
    const { account, created } = existing
      ? { account: await switchAccountToVia({ owner: viewer, accountId: existing.id, viaAccountId: provider.id }), created: false }
      : await saveAccount({ owner: viewer, site, origin: context.origin, username: provider.username, viaAccountId: provider.id })
    await logAuditEvent({ userId: viewer, object: 'browser_account', objectId: account.id, action: created ? 'created' : 'updated', details: { site, via: provider.site } })
    if (await grantAccount({ accountId: account.id, agentSlug, grantedBy: viewer })) {
      await logAuditEvent({ userId: viewer, object: 'browser_account', objectId: account.id, action: 'assigned', details: { agentSlug } })
    }
    const answered = await answerLoginRequest(agentSlug, body.toolUseId, {
      type: 'via',
      site,
      username: account.username,
      provider: { site: provider.site, username: provider.username, name: providerName(provider.site) },
      saved: true,
    })
    if (!answered) return c.json({ error: 'The agent could not be told. Try again.' }, 502)
    await actor.inputs.complete(sessionId, body.toolUseId, 'answered')
    claimed = null
    trackServerEvent('login_request_via', { provider: providerOf(provider.site)?.id ?? 'other' })
    return c.json({ success: true, account: { username: account.username, site }, provider: { site: provider.site, username: provider.username } })
  } catch (error) {
    if (error instanceof VaultConflictError) return c.json({ error: error.message }, 409)
    console.error('[login-via] Failed:', error instanceof Error ? error.message : 'Unknown error')
    return c.json({ error: 'The account could not be saved' }, 500)
  } finally {
    if (claimed) await agentRegistry.get(getAgentId(c)).inputs.releaseClaim(claimed.id, claimed.token)
  }
})

// POST /api/agents/:id/sessions/:sessionId/fill-login-credential - A saved login from the
// host's password manager, straight into the page: the secret never reaches the renderer.
agents.post(
  '/:id/sessions/:sessionId/fill-login-credential',
  IsAdmin(),
  zValidator('json', fillLoginCredentialBodySchema),
  async (c) => {
  let claimed: { id: string; token: string } | null = null
  c.header('Cache-Control', 'no-store')
  try {
    const body = c.req.valid('json')
    const gated = await gateRequestDecision(c, body.toolUseId, 'login')
    if (gated) return gated

    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const context = await loginRequestContext(agentSlug, body.toolUseId)
    if (!context) return c.json({ error: 'The sign-in form is not ready yet' }, 409)
    if (signsInToThisApp(c, context.origin)) return c.json({ error: thisAppProblem(context.origin).error }, 409)
    // A saved login holds an identifier and a password, nothing else.
    if (!context.fields.every((field) => field.kind === 'username' || field.kind === 'password')) {
      return c.json({ error: 'This form asks for more than a saved login holds' }, 409)
    }
    if (body.save) {
      const refused = await sharedAgentRefusal(c, agentSlug, body.sharedAgentAcknowledged)
      if (refused) return refused
    }
    const claim = await agentRegistry.get(agentSlug).inputs.claim(body.toolUseId)
    if (!claim) return c.json({ error: 'This sign-in request is already being handled' }, 409)
    claimed = { id: body.toolUseId, token: claim.token }

    const { credential, expectedOrigin } = await credentialBroker.retrieve(
      { agentSlug, sessionId, toolUseId: body.toolUseId },
      body.credentialId,
      context.url,
    )
    if (expectedOrigin !== context.origin) {
      return c.json({ error: 'The saved login is for a different site than the sign-in form' }, 409)
    }
    const viewer = getViewerUserId(c)
    const site = siteOfOrigin(context.origin)
    // The login's own username, else whose account the last step went in as.
    const identity = credential.username.trim() || (site ? recentSignInIdentity(agentSlug, sessionId, site) : null) || null
    // "Save for later" copies the whole login into the vault, also on a step
    // that shows only the username: the next step then needs no one.
    const saving = Boolean(body.save && site && identity && credential.password)
    const shown = noteUsername(identity)
    const values = context.fields.map((field) => (field.kind === 'username' ? credential.username : credential.password))
    const filled = await fillLoginInContainer(agentSlug, sessionId, body.toolUseId, context, values, site
      ? { ...(shown ? { username: shown } : {}), site, source: 'user', saved: saving, held: [] }
      : undefined)
    // The browser closed while the user was away: the login they picked is
    // saved when they chose to, else held a while, and the agent's next try
    // signs in with it without asking again.
    if (!filled.ok && filled.browserClosed) {
      let kept: { how: 'saved' | 'held'; username?: string } | null = null
      if (saving && site && identity) {
        try {
          const savedNow = await saveAndGrant(viewer, agentSlug, { site, origin: context.origin, username: identity, values: { password: credential.password } })
          kept = { how: 'saved', username: savedNow.username }
        } catch (error) {
          // Held instead, below: the agent's next try still needs no one.
          console.error('[fill-login-credential] Saving the account failed:', error instanceof Error ? error.message : 'Unknown error')
        }
      }
      if (!kept && site !== null && context.fields.some((field) => field.kind === 'password') && credential.password.length > 0) {
        holdLoginValues(agentSlug, sessionId, site, { username: identity, values: { password: credential.password }, origin: context.origin, save: null })
        kept = { how: 'held', ...(shown ? { username: shown } : {}) }
      }
      const answered = await answerLoginRequest(agentSlug, body.toolUseId, { type: 'browser_closed', site: site ?? context.origin, ...(kept ? { kept } : {}) })
      if (!answered) return c.json({ error: 'The agent could not be told. Try again.' }, 502)
      await agentRegistry.get(agentSlug).inputs.complete(sessionId, body.toolUseId, 'answered')
      claimed = null
      if (site && identity) rememberSignInIdentity(agentSlug, sessionId, site, identity)
      trackServerEvent('login_request_browser_closed', { kept: kept?.how ?? 'nothing' })
      return c.json({ success: true, browserClosed: true, ...(kept ? { kept: { how: kept.how, username: kept.username ?? null } } : {}) })
    }
    if (!filled.ok) return c.json({ error: filled.error }, filled.status)
    claimed = null

    let savedAccount: VaultAccount | null = null
    let saveError: string | undefined
    if (saving && site && identity) {
      try {
        savedAccount = await saveAndGrant(viewer, agentSlug, { site, origin: context.origin, username: identity, values: { password: credential.password } })
      } catch (error) {
        // The page has the login either way; the user is told it was not saved.
        console.error('[fill-login-credential] Saving the account failed:', error instanceof Error ? error.message : 'Unknown error')
        saveError = error instanceof VaultConflictError ? error.message : 'The account could not be saved'
      }
    } else if (body.save) {
      saveError = identity ? 'The saved login has no password to save' : 'The saved login has no username, so it was not saved'
    }
    if (site && identity) rememberSignInIdentity(agentSlug, sessionId, site, identity)
    // The user signed in with the account themselves: what the vault may fill without them counts from here.
    const wentIn = fieldsWentIn(filled.result, context.fields.length)
    if (savedAccount && wentIn.some(Boolean)) {
      const passwordWentIn = context.fields.some((field, index) => field.kind === 'password' && wentIn[index])
      await recordAccountUse({ agentSlug, accountId: savedAccount.id, sessionId, userId: viewer, password: passwordWentIn, by: 'user' })
    }
    trackServerEvent('login_request_filled', {
      submitted: filled.result.submitted,
      filled: filled.result.filled,
      failed: filled.result.failed,
      source: 'password_manager',
      saved: savedAccount !== null,
    })
    return c.json({
      ...filled.result,
      ...(savedAccount && site ? { saved: { username: savedAccount.username, site } } : {}),
      ...(saveError ? { saveError } : {}),
    })
  } catch (error) {
    return credentialBrokerErrorResponse(c, error)
  } finally {
    if (claimed) await agentRegistry.get(getAgentId(c)).inputs.releaseClaim(claimed.id, claimed.token)
  }
  },
)

// POST /api/agents/:id/sessions/:sessionId/complete-login - Signed in on the page instead, or declined
agents.post('/:id/sessions/:sessionId/complete-login', AgentUser(), zValidator('json', completeLoginBodySchema), async (c) => {
  let claimed: { id: string; token: string } | null = null
  try {
    const body = c.req.valid('json')
    const gated = await gateRequestDecision(c, body.toolUseId, 'login')
    if (gated) return gated

    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const actor = agentRegistry.get(agentSlug)
    const claim = await actor.inputs.claim(body.toolUseId)
    if (!claim) return c.json({ error: 'This sign-in request is already being handled' }, 409)
    claimed = { id: body.toolUseId, token: claim.token }

    const response = body.action === 'manual'
      ? await actor.container.fetch(`/inputs/${encodeURIComponent(body.toolUseId)}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: JSON.stringify({ type: 'manual' }) }),
        })
      : await actor.container.fetch(`/inputs/${encodeURIComponent(body.toolUseId)}/reject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: body.reason || 'The user declined to sign in' }),
        })
    if (!response.ok) {
      console.error(`[complete-login] The container did not accept the ${body.action} answer (HTTP ${response.status})`)
      return c.json({ error: 'Failed to answer the sign-in request' }, 500)
    }

    // Declined, or signed in by hand: what the user typed for a later step
    // goes. The site is on the request's located context, read before it settles.
    const located = loginContextSchema.safeParse(claim.request.payload.login)
    await actor.inputs.complete(sessionId, body.toolUseId, body.action === 'manual' ? 'answered' : 'declined')
    claimed = null
    const site = located.success ? siteOfOrigin(located.data.origin) : null
    if (site) forgetHeldLogin(agentSlug, sessionId, site)
    if (body.action === 'decline') {
      // As with a browser hand-off: stop the turn so the user can talk to the agent.
      await actor.messages.stop(sessionId, { scope: 'turn' })
      trackServerEvent('request_declined', { type: 'login', withReason: !!body.reason })
    }
    return c.json({ success: true })
  } catch (error) {
    console.error('[complete-login] Failed:', error instanceof Error ? error.message : 'Unknown error')
    return c.json({ error: 'Failed to answer the sign-in request' }, 500)
  } finally {
    if (claimed) await agentRegistry.get(getAgentId(c)).inputs.releaseClaim(claimed.id, claimed.token)
  }
})

// POST /api/agents/:id/sessions/:sessionId/complete-browser-input - Complete or cancel a browser input request
agents.post('/:id/sessions/:sessionId/complete-browser-input', AgentUser(), async (c) => {
  let claimed: { id: string; token: string } | null = null
  try {
    const agentSlug = getAgentId(c)
    const body = await c.req.json()
    const { toolUseId, decline, declineReason } = body

    if (!toolUseId) {
      return c.json({ error: 'toolUseId is required' }, 400)
    }

    const gated = await gateRequestDecision(c, toolUseId, 'browser_input')
    if (gated) return gated
    const claim = await agentRegistry.get(agentSlug).inputs.claim(toolUseId)
    if (!claim) {
      return c.json({ error: 'This browser request is already being handled' }, 409)
    }
    claimed = { id: toolUseId, token: claim.token }

    const actor = agentRegistry.get(agentSlug)

    if (decline) {
      const reason = declineReason || 'User wants to chat with the agent'

      const rejectResponse = await actor.container.fetch(
        `/inputs/${encodeURIComponent(toolUseId)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        }
      )

      if (!rejectResponse.ok) {
        let errorDetails = 'Unknown error'
        try {
          const error = await rejectResponse.json()
          errorDetails = JSON.stringify(error)
        } catch {
          errorDetails = await rejectResponse.text()
        }
        console.error(`[complete-browser-input] Failed to reject: ${errorDetails}`)
        return c.json({ error: 'Failed to reject browser input request' }, 500)
      }

      const sessionId = c.req.param('sessionId')
      await agentRegistry.get(agentSlug).inputs.complete(sessionId, toolUseId, 'declined')

      // Stop the turn so the user can chat directly with the agent.
      // Background tasks are not the user's target here, so they stay.
      await actor.messages.stop(sessionId, { scope: 'turn' })

      trackServerEvent('request_declined', { type: 'browser_input', withReason: !!declineReason })
      return c.json({ success: true, declined: true })
    }

    // User completed the browser interaction
    const resolveResponse = await actor.container.fetch(
      `/inputs/${encodeURIComponent(toolUseId)}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'completed' }),
      }
    )

    if (!resolveResponse.ok) {
      let errorDetails = 'Unknown error'
      try {
        const error = await resolveResponse.json()
        errorDetails = JSON.stringify(error)
      } catch {
        errorDetails = await resolveResponse.text()
      }
      console.error(`[complete-browser-input] Failed to resolve: ${errorDetails}`)
      return c.json({ error: 'Failed to complete browser input request' }, 500)
    }

    await agentRegistry.get(agentSlug).inputs.complete(c.req.param('sessionId'), toolUseId, 'answered')
    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to complete browser input:', error)
    return c.json({ error: 'Failed to complete browser input' }, 500)
  } finally {
    if (claimed) await agentRegistry.get(getAgentId(c)).inputs.releaseClaim(claimed.id, claimed.token)
  }
})

// What a run's outcome means to the client that approved it.
function hostRunResponse(c: Context, outcome: HostRunOutcome, what: 'script run' | 'computer use'): Response {
  switch (outcome.status) {
    case 'resolved':
      return c.json({ success: true })
    case 'claimed':
      return c.json({ error: `This ${what} request is already being handled` }, 409)
    case 'missing_permissions':
      return c.json({ success: false, missingPermissions: outcome.permissions }, 428)
    case 'failed':
      // The agent got the error as its tool's result; the approval itself went through.
      return c.json({ success: true, error: outcome.error })
    case 'undeliverable':
      console.error(`[${what}] Failed to resolve: ${outcome.detail}`)
      return c.json({ error: `Failed to resolve ${what} request` }, 500)
  }
}

const GRANT_TYPES: readonly PermissionGrantType[] = ['once', 'timed', 'always']
const grantTypeOf = (value: unknown): PermissionGrantType | undefined =>
  GRANT_TYPES.includes(value as PermissionGrantType) ? (value as PermissionGrantType) : undefined

/**
 * Decline a script-run or computer-use request: fail the agent's call with the
 * user's reason, then settle the request. Claimed first, so a decline cannot
 * race an approval of the same card.
 */
async function declineHostRun(
  c: Context,
  toolUseId: string,
  reason: string,
  settle: () => Promise<void>,
  what: 'script run' | 'computer use',
): Promise<Response> {
  const actor = agentRegistry.get(getAgentId(c))
  const claim = await actor.inputs.claim(toolUseId)
  if (!claim) {
    return c.json({ error: `This ${what} request is already being handled` }, 409)
  }
  try {
    const rejectResponse = await rejectInput(actor, toolUseId, reason)
    if (!rejectResponse.ok) {
      console.error(`[${what}] Failed to reject: ${rejectResponse.status} ${await rejectResponse.text().catch(() => '')}`)
      return c.json({ error: `Failed to reject ${what} request` }, 500)
    }
    await settle()
    return c.json({ success: true, declined: true })
  } finally {
    await actor.inputs.releaseClaim(toolUseId, claim.token)
  }
}

// POST /api/agents/:id/sessions/:sessionId/run-script - Run or deny a script execution request
agents.post('/:id/sessions/:sessionId/run-script', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const body = await c.req.json()
    const { toolUseId, script, scriptType, decline, declineReason } = body

    if (!toolUseId) {
      return c.json({ error: 'toolUseId is required' }, 400)
    }

    const gated = await gateRequestDecision(c, toolUseId, 'script_run')
    if (gated) return gated

    const actor = agentRegistry.get(agentSlug)

    if (decline) {
      return await declineHostRun(c, toolUseId, declineReason || 'User denied script execution', async () => {
        await actor.inputs.complete(sessionId, toolUseId, 'declined')
        trackServerEvent('request_declined', { type: 'script_run', withReason: !!declineReason })
      }, 'script run')
    }

    if (!script || !scriptType) {
      return c.json({ error: 'script and scriptType are required' }, 400)
    }
    if (!VALID_SCRIPT_TYPES[process.platform]?.includes(scriptType)) {
      return c.json({ error: `Script type "${scriptType}" is not supported on ${process.platform}` }, 400)
    }

    // The permission is ComputerUsePermissionManager's (use_host_shell level);
    // an "Allow" in the app records the grant with this run.
    const outcome = await actor.inputs.computerUse.runScript({
      sessionId,
      toolUseId,
      script,
      scriptType,
      grantType: grantTypeOf(body.grantType),
    })
    return hostRunResponse(c, outcome, 'script run')
  } catch (error) {
    console.error('Failed to run script:', error)
    return c.json({ error: 'Failed to run script' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/computer-use - Execute or deny a computer use request
agents.post('/:id/sessions/:sessionId/computer-use', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')
    const body = await c.req.json()
    const { toolUseId, method, params, permissionLevel, appName, grantType, decline, declineReason } = body

    if (!toolUseId) {
      return c.json({ error: 'toolUseId is required' }, 400)
    }

    const gated = await gateRequestDecision(c, toolUseId, 'computer_use')
    if (gated) return gated

    const actor = agentRegistry.get(agentSlug)
    if (!(await actor.sessions.isKnown(sessionId))) {
      return c.json({ error: 'Session not found' }, 404)
    }

    if (decline) {
      return await declineHostRun(c, toolUseId, declineReason || 'User denied computer use request', async () => {
        await actor.inputs.computerUse.clearPending(sessionId, toolUseId, 'declined')
        trackServerEvent('request_declined', { type: 'computer_use', method, withReason: !!declineReason })
      }, 'computer use')
    }

    if (!method) {
      return c.json({ error: 'method is required for execution' }, 400)
    }

    const outcome = await actor.inputs.computerUse.run({
      sessionId,
      toolUseId,
      method,
      params: params || {},
      permissionLevel: permissionLevel || 'use_application',
      appName,
      grantType: grantTypeOf(grantType),
    })
    return hostRunResponse(c, outcome, 'computer use')
  } catch (error) {
    console.error('Failed to execute computer use:', error)
    return c.json({ error: 'Failed to execute computer use' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/computer-use/revoke - Ungrab window and revoke permission for the app
agents.post('/:id/sessions/:sessionId/computer-use/revoke', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')

    if (!(await agentRegistry.get(agentSlug).sessions.isKnown(sessionId))) {
      return c.json({ error: 'Session not found' }, 404)
    }

    // Forgets the grab, revokes use_application for the app and tells the
    // session's viewers. Before the ungrab: the app revoked is the one the
    // user saw, not one grabbed while the ungrab ran.
    const { appName } = await agentRegistry.get(agentSlug).inputs.computerUse.releaseGrab(sessionId)
    await ungrabAC()

    return c.json({ success: true, revoked: appName || true })
  } catch (error) {
    console.error('Failed to revoke computer use:', error)
    return c.json({ error: 'Failed to revoke computer use' }, 500)
  }
})

const BRAIN_UPKEEP_NAME = 'Brain upkeep'
const BRAIN_UPKEEP_PROMPT = 'Run the maintain-brain skill (scheduled upkeep). Follow your system prompt. If no brain location is set up yet, end quietly without a message or a sync summary.'

const brainUpkeepBodySchema = z.object({ scheduleExpression: z.string().trim().min(1, 'scheduleExpression is required') })

// POST /api/agents/:id/team-brain/upkeep - Schedule the Team Brain's upkeep at
// set-up, so it never depends on the agent's first turn. Once only.
agents.post('/:id/team-brain/upkeep', AgentUser(), zValidator('json', brainUpkeepBodySchema), async (c) => {
  const slug = getAgentId(c)
  if (getTeamBrain()?.agentSlug !== slug) return c.json({ error: 'This agent is not the Team Brain' }, 400)
  const { scheduleExpression } = c.req.valid('json')
  if (!validateCronExpression(scheduleExpression).valid) return c.json({ error: 'Invalid cron expression' }, 400)
  try {
    const existing = (await listPendingScheduledTasks(slug)).find((task) => task.name === BRAIN_UPKEEP_NAME)
    if (existing) return c.json({ taskId: existing.id })
    const taskId = await createScheduledTask({
      agentSlug: slug,
      scheduleType: 'cron',
      scheduleExpression,
      prompt: BRAIN_UPKEEP_PROMPT,
      name: BRAIN_UPKEEP_NAME,
      createdByUserId: getCurrentUserId(c),
      timezone: await resolveTimezoneForAgent(slug),
    })
    globalFeed.publish({ type: 'scheduled_task_created', taskId, agentSlug: slug })
    return c.json({ taskId }, 201)
  } catch (error) {
    console.error('Failed to schedule Brain upkeep:', error)
    return c.json({ error: 'Failed to schedule Brain upkeep' }, 500)
  }
})

// GET /api/agents/:id/scheduled-tasks - List scheduled tasks for an agent
agents.get('/:id/scheduled-tasks', AgentRead(), async (c) => {
  try {
    const slug = getAgentId(c)
    const status = c.req.query('status') // Optional: filter by status (e.g., 'pending')


    let tasks
    if (status === 'pending') {
      tasks = await listPendingScheduledTasks(slug)
    } else if (status === 'cancelled') {
      tasks = await listCancelledScheduledTasks(slug)
    } else {
      tasks = await listScheduledTasks(slug)
    }

    // Session wakes are session-scoped (surfaced on the session row/banner),
    // not agent-level automations — keep them out of this list.
    tasks = tasks.filter((t) => !t.resumeSessionId)

    return c.json(tasks)
  } catch (error) {
    console.error('Failed to fetch scheduled tasks:', error)
    return c.json({ error: 'Failed to fetch scheduled tasks' }, 500)
  }
})

// GET /api/agents/:id/scheduled-tasks/completed-sessions - List settled
// sessions created by completed one-time scheduled tasks. These sessions are
// intentionally hidden from the agent's ordinary session list, so this is the
// discoverable history path for one-off automations.
agents.get('/:id/scheduled-tasks/completed-sessions', AgentRead(), async (c) => {
  try {
    const slug = getAgentId(c)
    const actor = agentRegistry.get(slug)
    const tasks = await listCompletedOneTimeTasks(slug)
    const metadata = await actor.sessions.readMetadata()
    const live = await actor.live()
    const active = new Set(live.activeSessionIds)
    const awaiting = new Set(live.awaitingSessionIds)

    const completedSessionIds = tasks
      .map((task) => task.lastSessionId)
      .filter((sessionId): sessionId is string => {
        if (!sessionId) return false
        // Missing status is a legacy completed run. A persisted `running` run
        // is still in flight only while its session is live; after an app
        // restart, or during the tiny idle-event/metadata-write race, the same
        // inactive run is settled. This mirrors activity-stats semantics.
        return metadata[sessionId]?.automationStatus !== 'running' || !active.has(sessionId)
      })

    const sessions = await actor.sessions.listByIds(completedSessionIds)
    const sessionsWithStatus = sessions.map((session) => ({
      ...session,
      isActive: active.has(session.id),
      isAwaitingInput: awaiting.has(session.id),
    }))
    sessionsWithStatus.sort(
      (a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime()
    )

    return c.json(sessionsWithStatus)
  } catch (error) {
    console.error('Failed to fetch completed one-time sessions:', error)
    return c.json({ error: 'Failed to fetch completed one-time sessions' }, 500)
  }
})

// GET /api/agents/:id/webhook-triggers - List webhook triggers for an agent
agents.get('/:id/webhook-triggers', AgentRead(), async (c) => {
  try {
    const slug = getAgentId(c)
    const status = c.req.query('status')

    const triggers = status === 'active'
      ? await listActiveWebhookTriggers(slug)
      : status === 'cancelled'
      ? await listCancelledWebhookTriggers(slug)
      : await listWebhookTriggers(slug)
    const role = getAuthorizedAgentRole(c)
    return c.json(triggers.map((trigger) => toPublicWebhookTrigger(trigger, role)))
  } catch (error) {
    console.error('Failed to fetch webhook triggers:', error)
    return c.json({ error: 'Failed to fetch webhook triggers' }, 500)
  }
})

// TODO(2026-12-01): Delete this legacy list route; use /api/agent-integrations/agents/:id.
agents.get('/:id/chat-integrations', AgentRead(), listAgentIntegrationsHandler)

function secretsErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof WorkspaceFileError && error.code === 'not-a-file') {
    return 'Cannot access secrets: workspace .env is a directory; a regular file is required.'
  }
  return fallback
}

// GET /api/agents/:id/secrets - List secrets for an agent
agents.get('/:id/secrets', AgentRead(), async (c) => {
  try {
    const slug = getAgentId(c)

    // Only user-managed secrets — reserved runtime vars (e.g. CONNECTED_ACCOUNTS)
    // that the container writes into the same .env are system-managed and must
    // not surface as user-editable secrets (SUP-239 bug 3).
    const secrets = await listUserSecrets(slug)
    const response = secrets.map((secret) => ({
      id: secret.envVar,
      key: secret.key,
      envVar: secret.envVar,
      hasValue: true,
    }))

    return c.json(response)
  } catch (error) {
    console.error('Failed to fetch secrets:', error)
    return c.json({ error: secretsErrorMessage(error, 'Failed to fetch secrets') }, 500)
  }
})

function isRetryableAuditWriteError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== 'object' || current === null) return false
    const code = 'code' in current ? current.code : undefined
    if (
      typeof code === 'string' &&
      (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
    ) {
      return true
    }
    current = 'cause' in current ? current.cause : undefined
  }
  return false
}

// GET /api/agents/:id/secrets/:secretId/value - Reveal the raw value of a single secret
agents.get('/:id/secrets/:secretId/value', AgentAdmin(), async (c) => {
  try {
    const slug = getAgentId(c)
    const envVar = c.req.param('secretId')

    // Reserved runtime vars are system-managed and hidden from the secrets
    // list (SUP-239 bug 3), so they don't exist as user secrets here either —
    // 404 rather than confirming the var and leaking e.g. CONNECTED_ACCOUNTS.
    const secret = isReservedEnvVar(envVar) ? null : await getSecret(slug, envVar)
    if (!secret) {
      return c.json({ error: 'Secret not found' }, 404)
    }

    // Revealing plaintext is fail-closed on audit storage: the endpoint must
    // never disclose a value unless its durable `revealed` row was written.
    await logAuditEventOrThrow({ userId: getCurrentUserId(c), object: 'secret', objectId: `${slug}/${envVar}`, action: 'revealed' })
    return c.json(
      { value: secret.value },
      200,
      { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    )
  } catch (error) {
    console.error('Failed to reveal secret:', error)
    if (isRetryableAuditWriteError(error)) {
      return c.json(
        { error: 'The audit log is temporarily busy. Please try revealing the secret again.' },
        503,
        { 'Retry-After': '1' },
      )
    }
    return c.json({ error: secretsErrorMessage(error, 'Failed to reveal secret') }, 500)
  }
})

// POST /api/agents/:id/secrets - Create or update a secret
agents.post('/:id/secrets', AgentUser(), async (c) => {
  try {
    const slug = getAgentId(c)
    const parsedBody = createSecretRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!parsedBody.success) {
      return c.json({ error: 'Invalid request body' }, 400)
    }
    const { key, value } = parsedBody.data

    if (!key.trim()) {
      return c.json({ error: 'Key is required' }, 400)
    }
    if (!value) {
      return c.json({ error: 'Value is required' }, 400)
    }

    const envVar = keyToEnvVar(key.trim())
    if (!envVar) {
      return c.json({ error: 'Key must contain at least one letter or number' }, 400)
    }

    // A secret is just an env var injected into the container, so it must obey
    // the same reserved-runtime-var rule as global custom env vars (SUP-210 /
    // SUP-239 bug 2): reject names that would clobber required runtime wiring.
    if (isReservedEnvVar(envVar)) {
      return c.json(
        { error: `"${envVar}" is a reserved runtime variable and cannot be used as a secret` },
        400
      )
    }

    const existing = await getSecret(slug, envVar)

    await setSecret(slug, {
      key: key.trim(),
      envVar,
      value,
    })

    await logAuditEvent({ userId: getCurrentUserId(c), object: 'secret', objectId: `${slug}/${envVar}`, action: existing ? 'updated' : 'created', details: { key: key.trim() } })
    return c.json({ id: envVar, key: key.trim(), envVar, hasValue: true }, 201)
  } catch (error) {
    console.error('Failed to create secret:', error)
    return c.json({ error: secretsErrorMessage(error, 'Failed to create secret') }, 500)
  }
})

// PUT /api/agents/:id/secrets/:secretId - Update a secret
agents.put('/:id/secrets/:secretId', AgentUser(), async (c) => {
  try {
    const slug = getAgentId(c)
    const envVar = c.req.param('secretId')
    const parsedBody = updateSecretRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!parsedBody.success) {
      return c.json({ error: 'Invalid request body' }, 400)
    }
    const { key, value } = parsedBody.data

    const result = await updateSecret(slug, envVar, { key, value })
    if (result.status === 'not_found') {
      return c.json({ error: 'Secret not found' }, 404)
    }
    if (result.status === 'invalid_key') {
      return c.json({ error: 'Key must contain at least one letter or number' }, 400)
    }
    if (result.status === 'reserved') {
      return c.json(
        { error: `"${result.envVar}" is a reserved runtime variable and cannot be used as a secret` },
        400
      )
    }
    if (result.status === 'conflict') {
      return c.json(
        { error: `A secret with env var "${result.envVar}" already exists` },
        409,
      )
    }

    const updated = result.secret
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'secret', objectId: `${slug}/${updated.envVar}`, action: 'updated', details: { key: updated.key } })
    return c.json({ id: updated.envVar, key: updated.key, envVar: updated.envVar, hasValue: true })
  } catch (error) {
    console.error('Failed to update secret:', error)
    return c.json({ error: secretsErrorMessage(error, 'Failed to update secret') }, 500)
  }
})

// DELETE /api/agents/:id/secrets/:secretId - Delete a secret
agents.delete('/:id/secrets/:secretId', AgentUser(), async (c) => {
  try {
    const slug = getAgentId(c)
    const envVar = c.req.param('secretId')


    const deleted = await deleteSecret(slug, envVar)

    if (!deleted) {
      return c.json({ error: 'Secret not found' }, 404)
    }

    await logAuditEvent({ userId: getCurrentUserId(c), object: 'secret', objectId: `${slug}/${envVar}`, action: 'deleted' })
    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to delete secret:', error)
    return c.json({ error: secretsErrorMessage(error, 'Failed to delete secret') }, 500)
  }
})

// GET /api/agents/:id/connected-accounts - List agent's connected accounts
agents.get('/:id/connected-accounts', AgentRead(), async (c) => {
  try {
    const slug = getAgentId(c)
    const viewerUserId = getViewerUserId(c)

    const mappings = await db
      .select({
        mapping: agentConnectedAccounts,
        account: connectedAccounts,
      })
      .from(agentConnectedAccounts)
      .innerJoin(
        connectedAccounts,
        eq(agentConnectedAccounts.connectedAccountId, connectedAccounts.id)
      )
      .where(eq(agentConnectedAccounts.agentSlug, slug))

    const accounts = mappings.map(({ mapping, account }) =>
      toAgentConnectedAccountDto(
        mapping,
        account,
        viewerUserId,
        getProvider(account.toolkitSlug),
      ))

    return c.json({ accounts })
  } catch (error) {
    console.error('Failed to fetch agent connected accounts:', error)
    return c.json({ error: 'Failed to fetch agent connected accounts' }, 500)
  }
})

// POST /api/agents/:id/connected-accounts - Map account(s) to agent
agents.post('/:id/connected-accounts', AgentUser(), async (c) => {
  try {
    const slug = getAgentId(c)
    const viewerUserId = getViewerUserId(c)
    const body = await c.req.json()
    const { accountIds } = body as { accountIds: string[] }

    if (!accountIds || !Array.isArray(accountIds) || accountIds.length === 0) {
      return c.json(
        { error: 'Missing required field: accountIds (array)' },
        400
      )
    }

    // Verify ownership of accounts in auth mode
    const ownedAccounts = await db
      .select()
      .from(connectedAccounts)
      .where(and(
        inArray(connectedAccounts.id, accountIds),
        ownerScope(c, connectedAccounts.userId)
      ))
    const ownedAccountIds = new Set(ownedAccounts.map(a => a.id))
    const validAccountIds = accountIds.filter(id => ownedAccountIds.has(id))

    if (validAccountIds.length === 0) {
      return c.json({ error: 'No valid accounts found' }, 400)
    }

    const now = new Date()
    const newMappings = validAccountIds.map((accountId) => ({
      id: crypto.randomUUID(),
      agentSlug: slug,
      connectedAccountId: accountId,
      createdAt: now,
    }))

    const insertedAccountIds: string[] = []
    for (const mapping of newMappings) {
      try {
        await db.insert(agentConnectedAccounts).values(mapping)
        insertedAccountIds.push(mapping.connectedAccountId)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : ''
        if (!message.includes('UNIQUE constraint failed')) {
          throw error
        }
      }
    }

    const updatedMappings = await db
      .select({
        mapping: agentConnectedAccounts,
        account: connectedAccounts,
      })
      .from(agentConnectedAccounts)
      .innerJoin(
        connectedAccounts,
        eq(agentConnectedAccounts.connectedAccountId, connectedAccounts.id)
      )
      .where(eq(agentConnectedAccounts.agentSlug, slug))

    const accounts = updatedMappings.map(({ mapping, account }) =>
      toAgentConnectedAccountDto(
        mapping,
        account,
        viewerUserId,
        getProvider(account.toolkitSlug),
      ))

    for (const accountId of insertedAccountIds) { await logAuditEvent({ userId: getCurrentUserId(c), object: 'account', objectId: accountId, action: 'assigned', details: { agentSlug: slug } }) }
    const liveRefresh = await agentRegistry.get(slug).container.syncConnectionEnvironment('connected-accounts')
    return c.json({ accounts, liveRefresh })
  } catch (error) {
    console.error('Failed to map connected accounts to agent:', error)
    return c.json({ error: 'Failed to map connected accounts to agent' }, 500)
  }
})

// DELETE /api/agents/:id/connected-accounts/:accountId - Remove account mapping from agent
agents.delete('/:id/connected-accounts/:accountId', AgentUser(), async (c) => {
  try {
    const slug = getAgentId(c)
    const accountId = c.req.param('accountId')

    // Owner-scope the account in auth mode: a co-tenant with `user` role on a
    // shared agent must NOT be able to sever another user's account link just
    // by knowing its id. Mirrors the POST sibling's ownerScope guard.
    const [found] = await db
      .select({ id: agentConnectedAccounts.id })
      .from(agentConnectedAccounts)
      .innerJoin(connectedAccounts, eq(agentConnectedAccounts.connectedAccountId, connectedAccounts.id))
      .where(and(
        eq(agentConnectedAccounts.agentSlug, slug),
        eq(agentConnectedAccounts.connectedAccountId, accountId),
        ownerScope(c, connectedAccounts.userId),
      ))
      .limit(1)

    if (!found) {
      return c.json({ error: 'Account mapping not found' }, 404)
    }

    await db
      .delete(agentConnectedAccounts)
      .where(eq(agentConnectedAccounts.id, found.id))

    await logAuditEvent({ userId: getCurrentUserId(c), object: 'account', objectId: accountId, action: 'unassigned', details: { agentSlug: slug } })
    const liveRefresh = await agentRegistry.get(slug).container.syncConnectionEnvironment('connected-accounts')
    return c.json({ success: true, liveRefresh })
  } catch (error) {
    console.error('Failed to remove account mapping:', error)
    return c.json({ error: 'Failed to remove account mapping' }, 500)
  }
})

// DELETE /api/agents/:id/connected-accounts/mapping/:mappingId - Unlink by link id
//
// The sibling route above is keyed on the ACCOUNT id and owner-scoped, so it
// can only ever sever a link to the caller's own account. An agent owner also
// has to be able to drop a connection another member shared onto the agent —
// without being handed that account's id, which the foreign DTO deliberately
// withholds. So this route is keyed on the LINK id instead, and gated on
// AgentAdmin(): owning the agent is what authorizes it, not owning the account.
// A `user` on the agent still cannot reach it. Only the mapping row dies; the
// account itself stays with its owner.
agents.delete('/:id/connected-accounts/mapping/:mappingId', AgentAdmin(), async (c) => {
  try {
    const slug = getAgentId(c)
    const mappingId = c.req.param('mappingId')

    // Matched on BOTH columns: a link id is an unauthenticated pointer into a
    // global table, so owning agent A must not unlink agent B's connection by
    // sending B's mapping id to A's URL.
    const [found] = await db
      .select({
        id: agentConnectedAccounts.id,
        connectedAccountId: agentConnectedAccounts.connectedAccountId,
      })
      .from(agentConnectedAccounts)
      .where(and(
        eq(agentConnectedAccounts.id, mappingId),
        eq(agentConnectedAccounts.agentSlug, slug),
      ))
      .limit(1)

    if (!found) {
      return c.json({ error: 'Account mapping not found' }, 404)
    }

    await db
      .delete(agentConnectedAccounts)
      .where(eq(agentConnectedAccounts.id, found.id))

    await logAuditEvent({ userId: getCurrentUserId(c), object: 'account', objectId: found.connectedAccountId, action: 'unassigned', details: { agentSlug: slug } })
    const liveRefresh = await agentRegistry.get(slug).container.syncConnectionEnvironment('connected-accounts')
    return c.json({ success: true, liveRefresh })
  } catch (error) {
    console.error('Failed to remove account mapping:', error)
    return c.json({ error: 'Failed to remove account mapping' }, 500)
  }
})

// GET /api/agents/:id/remote-mcps - List remote MCP servers assigned to this agent
agents.get('/:id/remote-mcps', AgentRead(), async (c) => {
  try {
    const slug = getAgentId(c)
    const viewerUserId = getViewerUserId(c)
    const mappings = await db
      .select({ mcp: remoteMcpServers, mapping: agentRemoteMcps })
      .from(agentRemoteMcps)
      .innerJoin(
        remoteMcpServers,
        eq(agentRemoteMcps.remoteMcpId, remoteMcpServers.id)
      )
      .where(eq(agentRemoteMcps.agentSlug, slug))

    return c.json({
      mcps: mappings.map(({ mcp, mapping }) =>
        toAgentRemoteMcpDto(mapping, mcp, viewerUserId)),
    })
  } catch (error) {
    console.error('Failed to fetch agent remote MCPs:', error)
    return c.json({ error: 'Failed to fetch agent remote MCPs' }, 500)
  }
})

// POST /api/agents/:id/remote-mcps - Assign remote MCP server(s) to agent
agents.post('/:id/remote-mcps', AgentUser(), async (c) => {
  try {
    const slug = getAgentId(c)
    const body = await c.req.json<{ mcpIds: string[] }>()

    if (!Array.isArray(body.mcpIds) || body.mcpIds.length === 0) {
      return c.json({ error: 'mcpIds array is required' }, 400)
    }

    // In auth mode, the caller may only attach remote MCPs they own. Without this,
    // a user with access to any agent could attach another user's remote MCP
    // (and its stored bearer/OAuth credentials) by ID. See SUP-199.
    let validMcpIds = body.mcpIds
    if (isAuthMode()) {
      const userId = getCurrentUserId(c)
      const ownedMcps = await db
        .select({ id: remoteMcpServers.id })
        .from(remoteMcpServers)
        .where(and(
          inArray(remoteMcpServers.id, body.mcpIds),
          eq(remoteMcpServers.userId, userId)
        ))
      const ownedMcpIds = new Set(ownedMcps.map((m) => m.id))
      validMcpIds = body.mcpIds.filter((id) => ownedMcpIds.has(id))

      if (validMcpIds.length === 0) {
        return c.json({ error: 'No valid remote MCPs found' }, 400)
      }
    }

    // Check which MCPs are already assigned to avoid phantom audit events
    const existingMappings = await db
      .select({ remoteMcpId: agentRemoteMcps.remoteMcpId })
      .from(agentRemoteMcps)
      .where(eq(agentRemoteMcps.agentSlug, slug))
    const alreadyAssigned = new Set(existingMappings.map(m => m.remoteMcpId))
    const newMcpIds = validMcpIds.filter(id => !alreadyAssigned.has(id))

    const now = new Date()
    const values = validMcpIds.map((mcpId) => ({
      id: crypto.randomUUID(),
      agentSlug: slug,
      remoteMcpId: mcpId,
      createdAt: now,
    }))

    await db.insert(agentRemoteMcps).values(values).onConflictDoNothing()

    for (const mcpId of newMcpIds) { await logAuditEvent({ userId: getCurrentUserId(c), object: 'mcp', objectId: mcpId, action: 'assigned', details: { agentSlug: slug } }) }
    const liveRefresh = await agentRegistry.get(slug).container.syncConnectionEnvironment('remote-mcps')
    return c.json({ success: true, added: newMcpIds.length, liveRefresh })
  } catch (error) {
    console.error('Failed to assign remote MCPs to agent:', error)
    return c.json({ error: 'Failed to assign remote MCPs to agent' }, 500)
  }
})

// DELETE /api/agents/:id/remote-mcps/:mcpId - Remove remote MCP from agent
agents.delete('/:id/remote-mcps/:mcpId', AgentUser(), async (c) => {
  try {
    const slug = getAgentId(c)
    const mcpId = c.req.param('mcpId')

    // Owner-scope the server in auth mode (see connected-accounts DELETE): a
    // shared agent's co-tenant must not unlink another user's MCP server.
    const [mapping] = await db
      .select({ id: agentRemoteMcps.id })
      .from(agentRemoteMcps)
      .innerJoin(remoteMcpServers, eq(agentRemoteMcps.remoteMcpId, remoteMcpServers.id))
      .where(
        and(
          eq(agentRemoteMcps.agentSlug, slug),
          eq(agentRemoteMcps.remoteMcpId, mcpId),
          ownerScope(c, remoteMcpServers.userId)
        )
      )
      .limit(1)

    if (!mapping) {
      return c.json({ error: 'MCP mapping not found' }, 404)
    }

    await db.delete(agentRemoteMcps).where(eq(agentRemoteMcps.id, mapping.id))
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'mcp', objectId: mcpId, action: 'unassigned', details: { agentSlug: slug } })
    const liveRefresh = await agentRegistry.get(slug).container.syncConnectionEnvironment('remote-mcps')
    return c.json({ success: true, liveRefresh })
  } catch (error) {
    console.error('Failed to remove remote MCP from agent:', error)
    return c.json({ error: 'Failed to remove remote MCP from agent' }, 500)
  }
})

// DELETE /api/agents/:id/remote-mcps/mapping/:mappingId - Unlink by link id
// The connected-accounts twin above carries the full rationale.
agents.delete('/:id/remote-mcps/mapping/:mappingId', AgentAdmin(), async (c) => {
  try {
    const slug = getAgentId(c)
    const mappingId = c.req.param('mappingId')

    const [mapping] = await db
      .select({ id: agentRemoteMcps.id, remoteMcpId: agentRemoteMcps.remoteMcpId })
      .from(agentRemoteMcps)
      .where(and(
        eq(agentRemoteMcps.id, mappingId),
        eq(agentRemoteMcps.agentSlug, slug),
      ))
      .limit(1)

    if (!mapping) {
      return c.json({ error: 'MCP mapping not found' }, 404)
    }

    await db.delete(agentRemoteMcps).where(eq(agentRemoteMcps.id, mapping.id))
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'mcp', objectId: mapping.remoteMcpId, action: 'unassigned', details: { agentSlug: slug } })
    const liveRefresh = await agentRegistry.get(slug).container.syncConnectionEnvironment('remote-mcps')
    return c.json({ success: true, liveRefresh })
  } catch (error) {
    console.error('Failed to remove remote MCP from agent:', error)
    return c.json({ error: 'Failed to remove remote MCP from agent' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/provide-remote-mcp - Handle user approval of runtime MCP request
agents.post('/:id/sessions/:sessionId/provide-remote-mcp', AgentUser(), async (c) => {
  try {
    const slug = getAgentId(c)
    const body = await c.req.json<{
      toolUseId: string
      remoteMcpId?: string
      remoteMcpIds?: string[]
      decline?: boolean
      declineReason?: string
    }>()
    const requestedMcpIds = Array.from(
      new Set((body.remoteMcpIds && body.remoteMcpIds.length > 0 ? body.remoteMcpIds : body.remoteMcpId ? [body.remoteMcpId] : []).filter(Boolean))
    )

    if (!body.toolUseId) {
      return c.json({ error: 'toolUseId is required' }, 400)
    }
    if (!body.decline && requestedMcpIds.length === 0) {
      return c.json({ error: 'remoteMcpId or remoteMcpIds is required when not declining' }, 400)
    }

    const gated = await gateRequestDecision(c, body.toolUseId, 'remote_mcp')
    if (gated) return gated

    // In auth mode, only allow providing remote MCPs the caller owns before
    // mapping them to the agent. Otherwise a user could approve another user's
    // remote MCP (and its stored credentials) for the agent's proxy. See SUP-199.
    if (!body.decline && isAuthMode()) {
      const userId = getCurrentUserId(c)
      const ownedMcps = await db
        .select({ id: remoteMcpServers.id })
        .from(remoteMcpServers)
        .where(and(
          inArray(remoteMcpServers.id, requestedMcpIds),
          eq(remoteMcpServers.userId, userId)
        ))
      const ownedMcpIds = new Set(ownedMcps.map((m) => m.id))
      if (requestedMcpIds.some((mcpId) => !ownedMcpIds.has(mcpId))) {
        return c.json({ error: 'One or more remote MCPs are not owned by the current user' }, 403)
      }
    }

    const actor = agentRegistry.get(slug)

    if (body.decline) {
      // Decline the request
      const rejectResponse = await actor.container.fetch(`/inputs/${encodeURIComponent(body.toolUseId)}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: body.declineReason || 'User declined to provide MCP access',
        }),
      })
      if (!rejectResponse.ok) {
        console.error('Failed to reject remote MCP request:', await rejectResponse.text())
        return c.json({ error: 'Failed to decline the request in container' }, 502)
      }
      await agentRegistry.get(getAgentId(c)).inputs.complete(c.req.param('sessionId'), body.toolUseId, 'declined')
      trackServerEvent('request_declined', { type: 'remote_mcp', withReason: !!body.declineReason })
      return c.json({ success: true, status: 'declined' })
    }

    // Reject non-active servers instead of resolving a no-op grant: the env
    // update below filters to status 'active', so a stale server (e.g. expired
    // OAuth → 'auth_required') would be silently dropped while the agent is
    // still told access was granted and waits for tools that never appear.
    const requestedServers = await db
      .select({
        id: remoteMcpServers.id,
        name: remoteMcpServers.name,
        status: remoteMcpServers.status,
      })
      .from(remoteMcpServers)
      .where(inArray(remoteMcpServers.id, requestedMcpIds))
    const inactiveServers = requestedServers.filter((s) => s.status !== 'active')
    if (inactiveServers.length > 0) {
      const names = inactiveServers.map((s) => s.name).join(', ')
      return c.json(
        {
          error: `MCP server${inactiveServers.length > 1 ? 's' : ''} ${names} need${inactiveServers.length > 1 ? '' : 's'} re-authentication. Reconnect before granting access.`,
          needsReauth: true,
          inactiveMcpIds: inactiveServers.map((s) => s.id),
        },
        409
      )
    }

    // Map MCP to agent if not already mapped
    const existingMapping = await db
      .select()
      .from(agentRemoteMcps)
      .where(
        and(
          eq(agentRemoteMcps.agentSlug, slug),
          inArray(agentRemoteMcps.remoteMcpId, requestedMcpIds)
        )
      )
    const existingMappedIds = new Set(existingMapping.map((mapping) => mapping.remoteMcpId))

    const newMappings = requestedMcpIds
      .filter((mcpId) => !existingMappedIds.has(mcpId))
      .map((mcpId) => ({
        id: crypto.randomUUID(),
        agentSlug: slug,
        remoteMcpId: mcpId,
        createdAt: new Date(),
      }))

    if (newMappings.length > 0) {
      await db.insert(agentRemoteMcps).values(newMappings)
    }

    // Update container env var
    // A grant to a session that is waiting on it: the push must happen (a
    // cached "stopped" can be stale) and succeed. Logs the container's refusal itself.
    if (!(await actor.container.syncConnectionEnvironment('remote-mcps', { confirm: true }))) {
      console.error('Failed to update REMOTE_MCPS env var')
      return c.json({ error: 'Failed to update container environment' }, 502)
    }

    // Resolve the pending input request
    const resolveResponse = await actor.container.fetch(`/inputs/${encodeURIComponent(body.toolUseId)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: requestedMcpIds }),
    })
    if (!resolveResponse.ok) {
      console.error('Failed to resolve remote MCP request:', await resolveResponse.text())
      return c.json({ error: 'Failed to resolve the request in container' }, 502)
    }

    await agentRegistry.get(getAgentId(c)).inputs.complete(c.req.param('sessionId'), body.toolUseId, 'answered')
    return c.json({ success: true, status: 'provided' })
  } catch (error) {
    console.error('Failed to provide remote MCP:', error)
    return c.json({ error: 'Failed to provide remote MCP' }, 500)
  }
})

// GET /api/agents/:id/mcp-audit-log - Get MCP audit log for an agent
agents.get('/:id/mcp-audit-log', AgentAdmin(), async (c) => {
  try {
    const slug = getAgentId(c)
    const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100)
    const offset = parseInt(c.req.query('offset') || '0', 10)

    const entries = await db
      .select()
      .from(mcpAuditLog)
      .where(eq(mcpAuditLog.agentSlug, slug))
      .orderBy(desc(mcpAuditLog.createdAt))
      .limit(limit)
      .offset(offset)

    const [totalResult] = await db
      .select({ count: count() })
      .from(mcpAuditLog)
      .where(eq(mcpAuditLog.agentSlug, slug))

    return c.json({
      entries,
      total: totalResult?.count || 0,
      limit,
      offset,
    })
  } catch (error) {
    console.error('Failed to fetch MCP audit log:', error)
    return c.json({ error: 'Failed to fetch MCP audit log' }, 500)
  }
})

// GET /api/agents/:id/skills - Get skills for an agent (with status info)
agents.get('/:id/skills', AgentRead(), async (c) => {
  try {
    const id = getAgentId(c)
    const skills = await getAgentSkillsWithStatus(id, getConfiguredSkillsets())
    return c.json({ skills })
  } catch (error) {
    console.error('Failed to fetch skills:', error)
    return c.json({ error: 'Failed to fetch skills' }, 500)
  }
})

// GET /api/agents/:id/discoverable-skills - Get available skills from skillsets
agents.get('/:id/discoverable-skills', AgentRead(), async (c) => {
  try {
    const id = getAgentId(c)
    const skills = await getDiscoverableSkills(id, getConfiguredSkillsets())
    return c.json({ skills })
  } catch (error) {
    console.error('Failed to fetch discoverable skills:', error)
    return c.json({ error: 'Failed to fetch discoverable skills' }, 500)
  }
})

// POST /api/agents/:id/skills/install - Install a skill from a skillset
agents.post('/:id/skills/install', AgentAdmin(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const { skillsetId, skillPath, skillName, skillVersion } = await c.req.json()

    if (!skillsetId || !skillPath) {
      return c.json({ error: 'skillsetId and skillPath are required' }, 400)
    }

    const config = getConfiguredSkillsets().find(s => s.id === skillsetId)
    if (!config) {
      return c.json({ error: 'Skillset not found' }, 404)
    }

    await installSkillFromSkillset(
      agentSlug,
      toSkillsetRef(config),
      skillPath,
      skillName || skillPath,
      skillVersion || '0.0.0',
    )

    await logAuditEvent({ userId: getCurrentUserId(c), object: 'skill', objectId: `${agentSlug}/${skillPath}`, action: 'created', details: { skillsetId, skillName: skillName || skillPath } })
    return c.json({ installed: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to install skill'
    console.error('Failed to install skill:', error)
    return c.json({ error: message }, 500)
  }
})

// POST /api/agents/:id/skills/:dir/update - Update an installed skill
agents.post('/:id/skills/:dir/update', AgentAdmin(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const skillDir = c.req.param('dir')
    const result = await updateSkillFromSkillset(agentSlug, skillDir)
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'skill', objectId: `${agentSlug}/${skillDir}`, action: 'updated' })
    return c.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update skill'
    console.error('Failed to update skill:', error)
    return c.json({ error: message }, 500)
  }
})

// GET /api/agents/:id/skills/:dir/pr-info - Get info for PR dialog
agents.get('/:id/skills/:dir/pr-info', AgentAdmin(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const skillDir = c.req.param('dir')
    const info = await getSkillPRInfo(agentSlug, skillDir)
    return c.json(info)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get PR info'
    console.error('Failed to get PR info:', error)
    return c.json({ error: message }, 500)
  }
})

// POST /api/agents/:id/skills/:dir/create-pr - Create PR for local changes
agents.post('/:id/skills/:dir/create-pr', AgentAdmin(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const skillDir = c.req.param('dir')
    const { title, body, newVersion } = await c.req.json()

    if (!title || !body) {
      return c.json({ error: 'title and body are required' }, 400)
    }

    const result = await createSkillPR(agentSlug, skillDir, { title, body, newVersion })
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'skill', objectId: `${agentSlug}/${skillDir}`, action: 'exported', details: { method: 'pr', title } })
    return c.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create PR'
    console.error('Failed to create PR:', error)
    return c.json({ error: message }, 500)
  }
})

// GET /api/agents/:id/skills/:dir/publish-info - Get info for publishing a local skill
agents.get('/:id/skills/:dir/publish-info', AgentAdmin(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const skillDir = c.req.param('dir')
    const skillsetId = c.req.query('skillsetId')

    if (!skillsetId) {
      return c.json({ error: 'skillsetId query parameter is required' }, 400)
    }

    const config = getConfiguredSkillsets().find(s => s.id === skillsetId)
    if (!config) {
      return c.json({ error: 'Skillset not found' }, 404)
    }

    const info = await getSkillPublishInfo(agentSlug, skillDir, config)
    return c.json(info)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get publish info'
    console.error('Failed to get publish info:', error)
    return c.json({ error: message }, 500)
  }
})

// POST /api/agents/:id/skills/:dir/publish - Publish a local skill to a skillset
agents.post('/:id/skills/:dir/publish', AgentAdmin(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const skillDir = c.req.param('dir')
    const { skillsetId, title, body, newVersion } = await c.req.json()

    if (!skillsetId || !title || !body) {
      return c.json({ error: 'skillsetId, title, and body are required' }, 400)
    }

    const config = getConfiguredSkillsets().find(s => s.id === skillsetId)
    if (!config) {
      return c.json({ error: 'Skillset not found' }, 404)
    }

    const result = await publishSkillToSkillset(agentSlug, skillDir, config, {
      title, body, newVersion,
    })
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'skill', objectId: `${agentSlug}/${skillDir}`, action: 'exported', details: { method: 'publish', skillsetId, title } })
    return c.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to publish skill'
    console.error('Failed to publish skill:', error)
    return c.json({ error: message }, 500)
  }
})

// ============================================================
// Agent Template endpoints
// ============================================================

/**
 * Download response for a branded .agent/.skill package. octet-stream (not
 * application/zip) so browsers keep the branded extension instead of
 * "correcting" the filename to .zip; the filename carries the human-readable
 * display name (slugs are opaque minted ids), encoded per the same quoted +
 * RFC 5987 `filename*` convention as workspace-file downloads.
 */
function packageDownloadResponse(body: Readable | Buffer, filename: string): Response {
  const encoded = encodeURIComponent(filename)
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
  }
  if (Buffer.isBuffer(body)) {
    headers['Content-Length'] = body.byteLength.toString()
  }
  const nodeStream = Buffer.isBuffer(body) ? Readable.from(body) : body
  return new Response(Readable.toWeb(nodeStream) as ReadableStream, { status: 200, headers })
}

// Lock lives on the stream ('close' releases it). Destroy if Response construction throws.
function sendLockedExportStream(zipStream: Readable, build: () => Response): Response {
  try {
    return build()
  } catch (err) {
    zipStream.destroy()
    throw err
  }
}

function exportRouteError(c: Context, error: unknown, fallback: string) {
  if (error instanceof Error && error.name === 'ExportInProgressError') {
    return c.json({ error: error.message }, 409)
  }
  const message = error instanceof Error ? error.message : fallback
  console.error(fallback, error)
  return c.json({ error: message }, 500)
}

// POST /api/agents/:id/export-template - Export agent as ZIP download
agents.post('/:id/export-template', AgentAdmin(), async (c) => {
  try {
    const slug = getAgentId(c)
    const agent = await getAgent(slug)
    const zipStream = await exportAgentTemplate(slug, c.req.raw.signal)
    return sendLockedExportStream(zipStream, () => {
      background(logAuditEvent({ userId: getCurrentUserId(c), object: 'agent', objectId: slug, action: 'exported', details: { type: 'template' } }), { name: 'agents-route.audit-export' })
      return packageDownloadResponse(zipStream, `${agent?.frontmatter.name || slug}-template${AGENT_PACKAGE_EXTENSION}`)
    })
  } catch (error) {
    return exportRouteError(c, error, 'Failed to export template')
  }
})

// POST /api/agents/:id/export-full - Export full agent as ZIP download (includes .env, data, etc.)
agents.post('/:id/export-full', AgentAdmin(), async (c) => {
  try {
    const slug = getAgentId(c)
    const agent = await getAgent(slug)
    const zipStream = await exportAgentFull(slug, c.req.raw.signal)
    return sendLockedExportStream(zipStream, () => {
      background(logAuditEvent({ userId: getCurrentUserId(c), object: 'agent', objectId: slug, action: 'exported', details: { type: 'full' } }), { name: 'agents-route.audit-export' })
      return packageDownloadResponse(zipStream, `${agent?.frontmatter.name || slug}-full${AGENT_PACKAGE_EXTENSION}`)
    })
  } catch (error) {
    return exportRouteError(c, error, 'Failed to export agent')
  }
})

// GET /api/agents/:id/template-status - Get skillset status
agents.get('/:id/template-status', AgentRead(), async (c) => {
  try {
    const slug = getAgentId(c)
    const status = await getAgentTemplateStatus(slug, getConfiguredSkillsets())
    return c.json(status)
  } catch (error) {
    console.error('Failed to get template status:', error)
    return c.json({ error: 'Failed to get template status' }, 500)
  }
})

// POST /api/agents/:id/template-update - Update from skillset
agents.post('/:id/template-update', AgentAdmin(), async (c) => {
  try {
    const slug = getAgentId(c)
    const result = await updateAgentFromSkillset(slug)
    return c.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update template'
    console.error('Failed to update template:', error)
    return c.json({ error: message }, 500)
  }
})

// GET /api/agents/:id/template-pr-info - Get AI-suggested PR info
agents.get('/:id/template-pr-info', AgentRead(), async (c) => {
  try {
    const slug = getAgentId(c)
    const info = await getAgentPRInfo(slug)
    return c.json(info)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get PR info'
    console.error('Failed to get template PR info:', error)
    return c.json({ error: message }, 500)
  }
})

// POST /api/agents/:id/template-create-pr - Create PR for modifications
agents.post('/:id/template-create-pr', AgentAdmin(), async (c) => {
  try {
    const slug = getAgentId(c)
    const { title, body, newVersion } = await c.req.json()

    if (!title || !body) {
      return c.json({ error: 'title and body are required' }, 400)
    }

    const result = await createAgentPR(slug, { title, body, newVersion })
    return c.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create PR'
    console.error('Failed to create template PR:', error)
    return c.json({ error: message }, 500)
  }
})

// GET /api/agents/:id/template-publish-info - Get publish info
agents.get('/:id/template-publish-info', AgentRead(), async (c) => {
  try {
    const slug = getAgentId(c)
    const skillsetId = c.req.query('skillsetId')

    if (!skillsetId) {
      return c.json({ error: 'skillsetId query parameter is required' }, 400)
    }

    const config = getConfiguredSkillsets().find(s => s.id === skillsetId)
    if (!config) {
      return c.json({ error: 'Skillset not found' }, 404)
    }

    const info = await getAgentPublishInfo(slug, config)
    return c.json(info)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get publish info'
    console.error('Failed to get template publish info:', error)
    return c.json({ error: message }, 500)
  }
})

// POST /api/agents/:id/template-publish - Publish to skillset
agents.post('/:id/template-publish', AgentAdmin(), async (c) => {
  try {
    const slug = getAgentId(c)
    const { skillsetId, title, body, newVersion } = await c.req.json()

    if (!skillsetId || !title || !body) {
      return c.json({ error: 'skillsetId, title, and body are required' }, 400)
    }

    const config = getConfiguredSkillsets().find(s => s.id === skillsetId)
    if (!config) {
      return c.json({ error: 'Skillset not found' }, 404)
    }

    const result = await publishAgentToSkillset(slug, config, { title, body, newVersion })
    return c.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to publish template'
    console.error('Failed to publish template:', error)
    return c.json({ error: message }, 500)
  }
})

// POST /api/agents/:id/template-refresh - Refresh status
agents.post('/:id/template-refresh', AgentUser(), async (c) => {
  try {
    const skillsets = getConfiguredSkillsets()
    await refreshAgentTemplates(skillsets, { background: c.req.query('background') === '1' })
    const slug = getAgentId(c)
    const status = await getAgentTemplateStatus(slug, skillsets)
    return c.json(status)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to refresh template'
    console.error('Failed to refresh template:', error)
    return c.json({ error: message }, 500)
  }
})

// POST /api/agents/:id/skills/refresh - Refresh skillset caches and reconcile skill status
agents.post('/:id/skills/refresh', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const skillsets = getConfiguredSkillsets()
    await refreshAgentSkills(agentSlug, skillsets, { background: c.req.query('background') === '1' })
    const skills = await getAgentSkillsWithStatus(agentSlug, skillsets)
    return c.json({ skills })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to refresh skills'
    console.error('Failed to refresh skills:', error)
    return c.json({ error: message }, 500)
  }
})

// POST /api/agents/:id/skills/:dir/export - Export a skill as ZIP download
agents.post('/:id/skills/:dir/export', AgentAdmin(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const dir = c.req.param('dir')
    const { zipBuffer, skillName } = await exportSkill(agentSlug, dir)

    await logAuditEvent({ userId: getCurrentUserId(c), object: 'skill', objectId: `${agentSlug}/${dir}`, action: 'exported', details: { type: 'zip' } })
    return packageDownloadResponse(zipBuffer, `${skillName || dir}${SKILL_PACKAGE_EXTENSION}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to export skill'
    console.error('Failed to export skill:', error)
    return c.json({ error: message }, 500)
  }
})

// DELETE /api/agents/:id/skills/:dir - Delete an installed skill from an agent
agents.delete('/:id/skills/:dir', AgentAdmin(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const dir = c.req.param('dir')
    await deleteSkill(agentSlug, dir)

    await logAuditEvent({ userId: getCurrentUserId(c), object: 'skill', objectId: `${agentSlug}/${dir}`, action: 'deleted' })
    return c.body(null, 204)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete skill'
    console.error('Failed to delete skill:', error)
    return c.json({ error: message }, 500)
  }
})

// POST /api/agents/:id/skills/import-zip - Import a skill from uploaded ZIP
agents.post('/:id/skills/import-zip', AgentAdmin(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const formData = await c.req.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return c.json({ error: 'No file provided' }, 400)
    }

    if (file.size > SKILL_MAX_COMPRESSED_SIZE) {
      return c.json({ error: formatUploadTooLargeMessage(file.size, SKILL_MAX_COMPRESSED_SIZE) }, 413)
    }

    const arrayBuffer = await file.arrayBuffer()
    const zipBuffer = Buffer.from(arrayBuffer)

    if (zipBuffer.length > SKILL_MAX_COMPRESSED_SIZE) {
      return c.json({ error: formatUploadTooLargeMessage(zipBuffer.length, SKILL_MAX_COMPRESSED_SIZE) }, 413)
    }

    const result = await importSkillFromZip(agentSlug, zipBuffer)
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'skill', objectId: `${agentSlug}/${result.skillDir}`, action: 'created', details: { skillName: result.skillName, source: 'zip-import' } })
    return c.json(result, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to import skill'
    console.error('Failed to import skill:', error)
    return c.json({ error: message }, 500)
  }
})

/** The workspace path of an installed skill's directory. `dir` is validated by the route. */
function skillWorkspaceDir(dir: string): string {
  return joinWorkspacePath('.claude/skills', dir)
}

/**
 * The workspace path of a file inside a skill directory, or null when
 * `filePath` would reach outside it (absolute, `..`, or otherwise invalid).
 * The actor keeps paths inside the workspace; this keeps them inside the skill.
 */
function resolveSkillFilePath(dir: string, filePath: string): string | null {
  if (path.isAbsolute(filePath) || filePath.startsWith('/')) return null
  const skillDir = skillWorkspaceDir(dir)
  let target: string
  try {
    target = joinWorkspacePath(skillDir, filePath)
  } catch (error) {
    if (error instanceof WorkspaceFileError) return null
    throw error
  }
  return target.startsWith(`${skillDir}/`) ? target : null
}

// GET /api/agents/:id/skills/:dir/files - List all files in a skill directory
agents.get('/:id/skills/:dir/files', AgentAdmin(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const dir = c.req.param('dir')

    if (!dir || dir.includes('/') || dir.includes('\\') || dir.includes('..')) {
      return c.json({ error: 'Invalid skill directory name' }, 400)
    }

    const actor = agentRegistry.get(agentSlug)
    const skillDir = skillWorkspaceDir(dir)

    const skillStat = await actor.files.stat(skillDir)
    if (!skillStat || skillStat.kind !== 'directory') {
      return c.json({ error: 'Skill directory not found' }, 404)
    }

    const files: Array<{ path: string; type: 'file' | 'directory' }> = []

    // The actor never lists a symbolic link, so one inside a skill does not
    // appear here (the plain directory read listed it as a file). A link
    // only gets into a skill by hand or by the agent: a zip import and a
    // skillset install both write the linked file itself in its place.
    const walk = async (currentDir: string, prefix: string) => {
      for (const entry of await actor.files.list(currentDir)) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.kind === 'directory') {
          files.push({ path: relativePath, type: 'directory' })
          await walk(entry.path, relativePath)
        } else {
          files.push({ path: relativePath, type: 'file' })
        }
      }
    }

    await walk(skillDir, '')
    files.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.path.localeCompare(b.path)
    })

    return c.json({ files })
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      return c.json({ error: error.status === 404 ? 'Skill directory not found' : error.message }, error.status)
    }
    console.error('Failed to list skill files:', error)
    return c.json({ error: 'Failed to list skill files' }, 500)
  }
})

// GET /api/agents/:id/skills/:dir/files/content - Read a skill file
agents.get('/:id/skills/:dir/files/content', AgentAdmin(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const dir = c.req.param('dir')
    const filePath = c.req.query('path')

    if (!dir || dir.includes('/') || dir.includes('\\') || dir.includes('..')) {
      return c.json({ error: 'Invalid skill directory name' }, 400)
    }
    if (!filePath) {
      return c.json({ error: 'path query parameter is required' }, 400)
    }

    const target = resolveSkillFilePath(dir, filePath)
    if (!target) {
      return c.json({ error: 'Invalid file path' }, 400)
    }

    const bytes = await agentRegistry.get(agentSlug).files.getDoc(target)
    if (!bytes) {
      return c.json({ error: 'File not found' }, 404)
    }
    return c.json({ content: new TextDecoder().decode(bytes), path: filePath })
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      return c.json({ error: error.status === 400 ? 'Invalid file path' : error.message }, error.status)
    }
    console.error('Failed to read skill file:', error)
    return c.json({ error: 'Failed to read skill file' }, 500)
  }
})

// PUT /api/agents/:id/skills/:dir/files/content - Write a skill file
agents.put('/:id/skills/:dir/files/content', AgentAdmin(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const dir = c.req.param('dir')
    const { path: filePath, content } = await c.req.json()

    if (!dir || dir.includes('/') || dir.includes('\\') || dir.includes('..')) {
      return c.json({ error: 'Invalid skill directory name' }, 400)
    }
    if (!filePath || typeof filePath !== 'string' || typeof content !== 'string') {
      return c.json({ error: 'path and content are required' }, 400)
    }

    const target = resolveSkillFilePath(dir, filePath)
    if (!target) {
      return c.json({ error: 'Invalid file path' }, 400)
    }

    await agentRegistry.get(agentSlug).files.putDoc(target, content)
    return c.json({ saved: true })
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      return c.json({ error: error.status === 400 ? 'Invalid file path' : error.message }, error.status)
    }
    console.error('Failed to write skill file:', error)
    return c.json({ error: 'Failed to write skill file' }, 500)
  }
})

// GET /api/agents/:id/audit-log - Get combined proxy + MCP audit log for agent
agents.get('/:id/audit-log', AgentAdmin(), async (c) => {
  try {
    const slug = getAgentId(c)

    const { offset, limit } = parsePagination(c.req.query('offset'), c.req.query('limit'))

    // Fetch a window from each table (offset+limit from each, already sorted by time desc)
    // then merge, sort, and slice for the requested page
    const window = offset + limit
    const [proxyEntries, proxyTotal, mcpEntries, mcpTotal] = await Promise.all([
      db
        .select()
        .from(proxyAuditLog)
        .where(eq(proxyAuditLog.agentSlug, slug))
        .orderBy(desc(proxyAuditLog.createdAt))
        .limit(window),
      db
        .select({ count: count() })
        .from(proxyAuditLog)
        .where(eq(proxyAuditLog.agentSlug, slug)),
      db
        .select()
        .from(mcpAuditLog)
        .where(eq(mcpAuditLog.agentSlug, slug))
        .orderBy(desc(mcpAuditLog.createdAt))
        .limit(window),
      db
        .select({ count: count() })
        .from(mcpAuditLog)
        .where(eq(mcpAuditLog.agentSlug, slug)),
    ])

    // Normalize to the shared request-log shape used by connection logs too.
    const normalized = [
      ...proxyEntries.map(normalizeProxyRequestLog),
      ...mcpEntries.map(normalizeMcpRequestLog),
    ]

    // Sort by time descending, then paginate
    normalized.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    const total = (proxyTotal[0]?.count ?? 0) + (mcpTotal[0]?.count ?? 0)
    const entries = await withRuleNames(normalized.slice(offset, offset + limit))

    return c.json({ entries, total })
  } catch (error) {
    console.error('Failed to fetch audit log:', error)
    return c.json({ error: 'Failed to fetch audit log' }, 500)
  }
})

const UPLOADS_DIR = 'uploads'

/** The workspace path an upload lands at, always inside `uploads/`. */
function resolveUploadDestPath(filename: string, relativePath?: string): string {
  // If relativePath is provided (folder upload), preserve directory structure
  let uploadPath: string
  if (relativePath) {
    const normalized = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '')
    uploadPath = `${UPLOADS_DIR}/${normalized}`
  } else {
    // Single-file upload: collapse the untrusted name to a safe basename
    // (shared with the chat-attachment write path). The check below is the
    // defense-in-depth backstop.
    uploadPath = `${UPLOADS_DIR}/${withUploadTimestamp(sanitizeUploadFilename(filename))}`
  }

  // Security: the actor keeps the write inside the workspace; this keeps it
  // inside the one folder uploads are allowed into.
  if (!normalizeWorkspacePath(uploadPath).startsWith(`${UPLOADS_DIR}/`)) {
    throw new Error('Invalid file path')
  }

  return uploadPath
}

async function writeUploadedFileFromPath(agentSlug: string, filename: string, srcPath: string, relativePath?: string) {
  const uploadPath = resolveUploadDestPath(filename, relativePath)
  // `srcPath` is the assembled chunk file in this machine's temp dir, not a
  // workspace file: it is moved into the workspace, a rename when the two
  // share a filesystem, so the bytes are not written a second time.
  const { size } = await moveHostFileIntoWorkspace(agentRegistry.get(agentSlug).files, srcPath, uploadPath)
  return {
    success: true,
    path: `/workspace/${uploadPath}`,
    filename,
    size,
  }
}

async function handleFileUpload(agentSlug: string, file: File, relativePath?: string) {
  if (file.size > MAX_UPLOAD_TOTAL_SIZE) {
    throw new UploadTooLargeError(file.size, MAX_UPLOAD_TOTAL_SIZE)
  }
  const uploadPath = resolveUploadDestPath(file.name, relativePath)

  // Stream into the workspace instead of Buffer.from(await file.arrayBuffer()) —
  // avoids a second full in-memory copy of the file on top of formData()'s
  // buffering. A write that fails part-way leaves nothing behind.
  await agentRegistry.get(agentSlug).files.write(uploadPath, file.stream() as ReadableStream<Uint8Array>)

  return {
    success: true,
    path: `/workspace/${uploadPath}`,
    filename: file.name,
    size: file.size,
  }
}

// Shared by both upload-file routes. When a `chunk` field is present, persist it
// and only write the final file once every chunk has arrived. Returns
// `{ pending }` (a Response to return immediately — either a 400/413 or the interim
// `chunk_received` ack) or `{ uploadResult }` once the file is fully assembled.
type ChunkedFileUploadOutcome = {
  pending: Response | null
  uploadResult?: Awaited<ReturnType<typeof writeUploadedFileFromPath>>
}

async function handleChunkedFileUpload(c: Context, agentSlug: string, formData: FormData, chunk: File): Promise<ChunkedFileUploadOutcome> {
  const parsed = parseChunkFields(formData)
  if (!parsed.ok) return { pending: c.json({ error: parsed.error }, 400) }

  const filename = (formData.get('filename') as string | null) || 'upload'
  const relativePath = formData.get('relativePath') as string | null

  const result = await storeUploadChunk(
    parsed.uploadId,
    parsed.chunkIndex,
    parsed.totalChunks,
    Buffer.from(await chunk.arrayBuffer()),
    MAX_UPLOAD_TOTAL_SIZE,
  )

  if (result.status === 'received') {
    return { pending: c.json({ status: 'chunk_received', chunkIndex: parsed.chunkIndex }) }
  }

  try {
    const uploadResult = await writeUploadedFileFromPath(agentSlug, filename, result.filePath, relativePath || undefined)
    return { pending: null, uploadResult }
  } finally {
    try {
      await fs.promises.unlink(result.filePath)
    } catch (err) {
      // The assembled file is read, not moved; ENOENT means it is already gone.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn('[agents] failed to unlink assembled file upload:', err)
        captureException(err, {
          tags: { component: 'agents', operation: 'unlink-assembled-upload' },
          extra: { filePath: result.filePath, agentSlug },
        })
      }
    }
  }
}

// Shared handler for both agent-level and session-level upload-file routes.
// Supports single-request uploads (`file` field) and chunked uploads (`chunk`
// field) so files above Cloudflare's 100MB request-body limit go through in
// <100MB slices.
async function respondUploadFile(c: Context) {
  try {
    const agentSlug = getAgentId(c)
    if (!agentSlug) return c.json({ error: 'Missing agent id' }, 400)
    const formData = await c.req.formData()

    const chunk = formData.get('chunk') as File | null
    if (chunk) {
      const outcome = await handleChunkedFileUpload(c, agentSlug, formData, chunk)
      if (outcome.pending) return outcome.pending
      const result = outcome.uploadResult!
      await logAuditEvent({ userId: getCurrentUserId(c), object: 'file', objectId: `${agentSlug}/${result.filename}`, action: 'uploaded' })
      return c.json(result)
    }

    const file = formData.get('file') as File | null
    const relativePath = formData.get('relativePath') as string | null
    if (!file) {
      return c.json({ error: 'No file provided' }, 400)
    }

    const result = await handleFileUpload(agentSlug, file, relativePath || undefined)
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'file', objectId: `${agentSlug}/${result.filename}`, action: 'uploaded' })
    return c.json(result)
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      return c.json({ error: error.message }, 413)
    }
    console.error('Failed to upload file:', error)
    captureException(error, { tags: { component: 'agents', operation: 'upload-file' }, extra: { agentSlug: getAgentId(c) } })
    return c.json({ error: 'Failed to upload file' }, 500)
  }
}

// Per-request body cap for the upload-file routes. formData() buffers the whole
// multipart body in memory, so without this any client (curl, proxies) could
// POST a single multi-GB body and the server would hold it all in RAM. The web
// client splits files above 50MB into chunks, so no legitimate request body
// exceeds ~50MB plus multipart framing; 64MB leaves comfortable headroom.
// Content-Length requests are rejected from the header alone; bodies without a
// length (chunked transfer-encoding) are counted and cut off at the cap.
const MAX_UPLOAD_REQUEST_SIZE = 64 * 1024 * 1024

const uploadRequestBodyLimit = bodyLimit({
  maxSize: MAX_UPLOAD_REQUEST_SIZE,
  onError: (c) =>
    c.json(
      { error: `Request body too large (max ${MAX_UPLOAD_REQUEST_SIZE / 1024 / 1024}MB per request); use chunked upload for larger files` },
      413,
    ),
})

// POST /api/agents/:id/upload-file - Upload a file to the agent workspace (no session required)
agents.post('/:id/upload-file', AgentUser(), uploadRequestBodyLimit, respondUploadFile)

// POST /api/agents/:id/sessions/:sessionId/upload-file - Upload a file to the agent workspace
agents.post('/:id/sessions/:sessionId/upload-file', AgentUser(), uploadRequestBodyLimit, respondUploadFile)

// The Mac App Store build reaches only folders picked in its open panel, and a
// dropped folder arrives through the web upload instead.
const FOLDER_BY_PATH_UNAVAILABLE = 'Copying a folder by its path is not available in the Mac App Store edition'

async function handleFolderUpload(agentSlug: string, sourcePath: string) {
  // `sourcePath` is a folder on this machine, chosen in the Electron file
  // picker. Walk it with fs and copy each regular file into the workspace;
  // symbolic links are skipped rather than followed.
  const stat = await fs.promises.stat(sourcePath)
  if (!stat.isDirectory()) {
    throw new Error('Source is not a directory')
  }

  const folderName = path.basename(sourcePath)
  const destRoot = joinWorkspacePath(UPLOADS_DIR, folderName)

  // Security: ensure dest doesn't escape uploads directory
  if (!destRoot.startsWith(`${UPLOADS_DIR}/`)) {
    throw new Error('Invalid path')
  }

  const actor = agentRegistry.get(agentSlug)
  const copyDirectory = async (hostDir: string, destDir: string) => {
    // Created up front so an empty folder still arrives.
    await actor.files.mkdir(destDir)
    for (const entry of await fs.promises.readdir(hostDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const hostEntry = path.join(hostDir, entry.name)
      const destEntry = joinWorkspacePath(destDir, entry.name)
      if (entry.isDirectory()) {
        await copyDirectory(hostEntry, destEntry)
      } else if (entry.isFile()) {
        await copyHostFileIntoWorkspace(actor.files, hostEntry, destEntry)
      }
    }
  }
  await copyDirectory(sourcePath, destRoot)

  return {
    success: true,
    path: `/workspace/uploads/${folderName}/`,
    folderName,
  }
}

// POST /api/agents/:id/upload-folder - Copy a local folder to the agent workspace (Electron only)
agents.post('/:id/upload-folder', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const { sourcePath } = await c.req.json<{ sourcePath: string }>()
    if (!sourcePath) return c.json({ error: 'No source path provided' }, 400)
    if (!readsHostFolders(getServerFacts())) return c.json({ error: FOLDER_BY_PATH_UNAVAILABLE }, 400)
    const result = await handleFolderUpload(agentSlug, sourcePath)
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'file', objectId: `${agentSlug}/${result.folderName}`, action: 'uploaded' })
    return c.json(result)
  } catch (error) {
    console.error('Failed to upload folder:', error)
    captureException(error, { tags: { component: 'agents', operation: 'upload-folder' }, extra: { agentSlug: getAgentId(c) } })
    return c.json({ error: 'Failed to upload folder' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/upload-folder - Copy a local folder to the agent workspace (Electron only)
agents.post('/:id/sessions/:sessionId/upload-folder', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const { sourcePath } = await c.req.json<{ sourcePath: string }>()
    if (!sourcePath) return c.json({ error: 'No source path provided' }, 400)
    if (!readsHostFolders(getServerFacts())) return c.json({ error: FOLDER_BY_PATH_UNAVAILABLE }, 400)
    const result = await handleFolderUpload(agentSlug, sourcePath)
    await logAuditEvent({ userId: getCurrentUserId(c), object: 'file', objectId: `${agentSlug}/${result.folderName}`, action: 'uploaded' })
    return c.json(result)
  } catch (error) {
    console.error('Failed to upload folder:', error)
    captureException(error, { tags: { component: 'agents', operation: 'upload-folder' }, extra: { agentSlug: getAgentId(c) } })
    return c.json({ error: 'Failed to upload folder' }, 500)
  }
})

// --- Mount CRUD endpoints ---

// GET /api/agents/:id/mounts - List mounts with health status
agents.get('/:id/mounts', AgentRead(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const mounts = await getMountsWithHealth(agentSlug)
    return c.json(mounts)
  } catch (error) {
    console.error('Failed to list mounts:', error)
    return c.json({ error: 'Failed to list drives' }, 500)
  }
})

// POST /api/agents/:id/mounts - Add a mount
agents.post('/:id/mounts', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    let mount
    let restart: boolean | undefined
    try {
      const input = addMountSchema.parse(await c.req.json())
      restart = input.restart
      mount = 'volumeId' in input
        ? await attachMount(agentSlug, input.volumeId, volumeViewer(c), { readOnly: input.readOnly })
        : await addMount(agentSlug, input.type, input.config, volumeViewer(c), { name: input.name, visibility: input.visibility })
    } catch (err) {
      if (err instanceof VolumeError) return c.json({ error: err.message }, err.status)
      if (err instanceof z.ZodError || err instanceof SyntaxError) return c.json({ error: 'Invalid drive configuration' }, 400)
      throw err
    }
    const summary = { ...volumeSummary(mount), volumeId: mount.volumeId, volumeName: mount.volumeName }

    await afterMountChange(agentSlug, restart)

    await logAuditEvent({ userId: getCurrentUserId(c), object: 'mount', objectId: `${agentSlug}/${mount.id}`, action: 'created', details: { type: summary.type, name: summary.name, hostPath: summary.hostPath, readOnly: mount.readOnly } })
    return c.json(summary, 201)
  } catch (error) {
    console.error('Failed to add mount:', error)
    return c.json({ error: 'Failed to add drive' }, 500)
  }
})

// PATCH /api/agents/:id/mounts/:mountId - Set read only
agents.patch('/:id/mounts/:mountId', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const mountId = c.req.param('mountId')
    const parsed = updateMountSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid drive update' }, 400)
    if (!(await setMountReadOnly(agentSlug, mountId, parsed.data.readOnly))) {
      return c.json({ error: 'Drive not found' }, 404)
    }
    await afterMountChange(agentSlug)

    await logAuditEvent({ userId: getCurrentUserId(c), object: 'mount', objectId: `${agentSlug}/${mountId}`, action: 'updated', details: { readOnly: parsed.data.readOnly } })
    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to update mount:', error)
    return c.json({ error: 'Failed to update drive' }, 500)
  }
})

// DELETE /api/agents/:id/mounts/:mountId - Remove a mount
agents.delete('/:id/mounts/:mountId', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const mountId = c.req.param('mountId')
    const restart = c.req.query('restart') === 'true'

    if (!(await removeMount(agentSlug, mountId))) {
      return c.json({ error: 'Drive not found' }, 404)
    }

    await afterMountChange(agentSlug, restart)

    await logAuditEvent({ userId: getCurrentUserId(c), object: 'mount', objectId: `${agentSlug}/${mountId}`, action: 'deleted' })
    return c.json({ success: true })
  } catch (error) {
    console.error('Failed to remove mount:', error)
    return c.json({ error: 'Failed to remove drive' }, 500)
  }
})

// GET /api/agents/:id/folders - Lazily list one level of a bookmarked workspace folder
agents.get('/:id/folders', AgentRead(), async (c) => {
  const agentSlug = getAgentId(c)
  const rawRoot = c.req.query('root')
  const rawCurrentPath = c.req.query('path') ?? rawRoot
  if (!rawRoot || !rawCurrentPath) {
    return c.json({ error: 'root and path are required' }, 400)
  }

  // Explicit folder bookmarks are shareable with viewers. The built-in full
  // workspace browser is an owner-only surface and must not become an API-level
  // directory enumeration capability for shared users.
  if (normalizeWorkspaceContainerPath(rawRoot) === '/workspace' && getAuthorizedAgentRole(c) !== 'owner') {
    return c.json({ error: 'Forbidden' }, 403)
  }

  try {
    // The resolver has already stat'ed the path (and refused one reached
    // through a link); this only asks what is there.
    const { rootPath, currentPath, stat } = await resolveBookmarkedWorkspacePath(
      agentSlug,
      rawRoot,
      rawCurrentPath,
    )
    if (!stat || stat.kind !== 'directory') {
      return c.json({ error: 'Folder not found' }, 404)
    }

    // One level only; the actor never lists symbolic links.
    const entries = (await agentRegistry.get(agentSlug).files.list(currentPath))
      .map(entry => ({
        name: entry.name,
        path: path.posix.join(currentPath, entry.name),
        type: entry.kind,
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })

    return c.json({
      root: rootPath,
      path: currentPath,
      entries: entries.slice(0, MAX_FOLDER_ENTRIES),
      truncated: entries.length > MAX_FOLDER_ENTRIES,
    })
  } catch (error) {
    const accessError = error instanceof WorkspaceFolderAccessError
      ? error
      : workspaceFolderFsError(error)
    if (accessError) return c.json({ error: accessError.message }, accessError.status)
    console.error('Failed to list bookmarked folder:', error)
    return c.json({ error: 'Failed to list folder' }, 500)
  }
})

// PATCH /api/agents/:id/folders/file - Rename a regular file inside a bookmarked folder
agents.patch('/:id/folders/file', AgentAdmin(), async (c) => {
  const parsed = RenameWorkspaceFolderFileSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'Invalid file rename request', issues: parsed.error.issues }, 400)
  }

  const agentSlug = getAgentId(c)
  try {
    const resolved = await resolveBookmarkedWorkspaceEntry(
      agentSlug,
      parsed.data.root,
      parsed.data.path,
    )
    const destinationContainerPath = path.posix.join(
      path.posix.dirname(resolved.currentPath),
      parsed.data.name,
    )
    if (!isContainerPathWithin(resolved.rootPath, destinationContainerPath)) {
      throw new WorkspaceFolderAccessError('Invalid file path', 400)
    }

    const result = await requestContainerWorkspaceMutation<{ path: string; name: string }>(
      agentSlug,
      'PATCH',
      { path: resolved.currentPath, name: parsed.data.name, type: 'file' },
    )
    return c.json(result)
  } catch (error) {
    const accessError = error instanceof WorkspaceFolderAccessError
      ? error
      : workspaceFolderFsError(error)
    if (accessError) return c.json({ error: accessError.message }, accessError.status)
    console.error('Failed to rename bookmarked folder file:', error)
    return c.json({ error: 'Failed to rename file' }, 500)
  }
})

// DELETE /api/agents/:id/folders/file - Delete a regular file inside a bookmarked folder
agents.delete('/:id/folders/file', AgentAdmin(), async (c) => {
  const parsed = WorkspaceFolderFileSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'Invalid file delete request', issues: parsed.error.issues }, 400)
  }

  const agentSlug = getAgentId(c)
  try {
    const resolved = await resolveBookmarkedWorkspaceEntry(
      agentSlug,
      parsed.data.root,
      parsed.data.path,
    )
    const result = await requestContainerWorkspaceMutation<{ success: true }>(
      agentSlug,
      'DELETE',
      { path: resolved.currentPath, type: 'file' },
    )
    return c.json(result)
  } catch (error) {
    const accessError = error instanceof WorkspaceFolderAccessError
      ? error
      : workspaceFolderFsError(error)
    if (accessError) return c.json({ error: accessError.message }, accessError.status)
    console.error('Failed to delete bookmarked folder file:', error)
    return c.json({ error: 'Failed to delete file' }, 500)
  }
})

// PATCH /api/agents/:id/folders/directory - Rename a directory inside a browser root
agents.patch('/:id/folders/directory', AgentAdmin(), async (c) => {
  const parsed = RenameWorkspaceFolderFileSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'Invalid directory rename request', issues: parsed.error.issues }, 400)
  }

  const agentSlug = getAgentId(c)
  try {
    const resolved = await resolveBookmarkedWorkspaceEntry(
      agentSlug,
      parsed.data.root,
      parsed.data.path,
    )
    if (resolved.currentPath === resolved.rootPath) {
      throw new WorkspaceFolderAccessError('The browser root cannot be renamed', 400)
    }

    const destinationContainerPath = path.posix.join(
      path.posix.dirname(resolved.currentPath),
      parsed.data.name,
    )
    if (!isContainerPathWithin(resolved.rootPath, destinationContainerPath)) {
      throw new WorkspaceFolderAccessError('Invalid directory path', 400)
    }

    const result = await requestContainerWorkspaceMutation<{ path: string; name: string }>(
      agentSlug,
      'PATCH',
      { path: resolved.currentPath, name: parsed.data.name, type: 'directory' },
    )
    return c.json(result)
  } catch (error) {
    const accessError = error instanceof WorkspaceFolderAccessError
      ? error
      : workspaceFolderFsError(error)
    if (accessError) return c.json({ error: accessError.message }, accessError.status)
    console.error('Failed to rename bookmarked folder directory:', error)
    return c.json({ error: 'Failed to rename directory' }, 500)
  }
})

// DELETE /api/agents/:id/folders/directory - Recursively delete a directory
agents.delete('/:id/folders/directory', AgentAdmin(), async (c) => {
  const parsed = WorkspaceFolderFileSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'Invalid directory delete request', issues: parsed.error.issues }, 400)
  }

  const agentSlug = getAgentId(c)
  try {
    const resolved = await resolveBookmarkedWorkspaceEntry(
      agentSlug,
      parsed.data.root,
      parsed.data.path,
    )
    if (resolved.currentPath === resolved.rootPath) {
      throw new WorkspaceFolderAccessError('The browser root cannot be deleted', 400)
    }

    const result = await requestContainerWorkspaceMutation<{ success: true }>(
      agentSlug,
      'DELETE',
      { path: resolved.currentPath, type: 'directory' },
    )
    return c.json(result)
  } catch (error) {
    const accessError = error instanceof WorkspaceFolderAccessError
      ? error
      : workspaceFolderFsError(error)
    if (accessError) return c.json({ error: accessError.message }, accessError.status)
    console.error('Failed to delete bookmarked folder directory:', error)
    return c.json({ error: 'Failed to delete directory' }, 500)
  }
})

// POST /api/agents/:id/folders/reveal-path - Resolve an entry to its local host path.
// The renderer only exposes this action in Electron; keeping resolution here
// preserves the same root-containment and symlink protections as browsing.
agents.post('/:id/folders/reveal-path', AgentAdmin(), async (c) => {
  const parsed = WorkspaceFolderFileSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'Invalid reveal request', issues: parsed.error.issues }, 400)
  }

  const agentSlug = getAgentId(c)
  try {
    const resolved = await resolveBookmarkedWorkspacePath(
      agentSlug,
      parsed.data.root,
      parsed.data.path,
    )
    // The resolver has confirmed the entry sits inside the workspace and was
    // not reached through a link. Where it is on this machine is then a host
    // question, as it is for open-directory.
    if (!resolved.stat) {
      throw new WorkspaceFolderAccessError('File or directory not found', 404)
    }
    const hostPath = path.join(
      containerHost.workspaceHostPath(agentSlug),
      ...normalizeWorkspacePath(resolved.currentPath).split('/').filter(Boolean),
    )
    const sourceStat = await fs.promises.lstat(hostPath)
    if (sourceStat.isSymbolicLink() || (!sourceStat.isDirectory() && !sourceStat.isFile())) {
      throw new WorkspaceFolderAccessError('File or directory not found', 404)
    }
    return c.json({ hostPath: await fs.promises.realpath(hostPath) })
  } catch (error) {
    const accessError = error instanceof WorkspaceFolderAccessError
      ? error
      : workspaceFolderFsError(error)
    if (accessError) return c.json({ error: accessError.message }, accessError.status)
    console.error('Failed to resolve folder entry for reveal:', error)
    return c.json({ error: 'Failed to reveal file or directory' }, 500)
  }
})

const HEIC_EXTENSIONS = new Set(['.heic', '.heif'])
const HEIC_PREVIEW_CACHE_BYTES = 64 * 1024 * 1024
const HEIC_PREVIEW_MAX_PIXELS = 50_000_000
const HEIC_PREVIEW_TIMEOUT_MS = 30_000
const heicPreviewCache = new Map<string, Uint8Array>()
let heicPreviewCacheBytes = 0
let heicPreviewQueue: Promise<void> = Promise.resolve()

function cachedHeicPreview(key: string): Uint8Array | undefined {
  const preview = heicPreviewCache.get(key)
  if (!preview) return undefined
  heicPreviewCache.delete(key)
  heicPreviewCache.set(key, preview)
  return preview
}

function cacheHeicPreview(key: string, preview: Uint8Array) {
  if (preview.byteLength > HEIC_PREVIEW_CACHE_BYTES) return
  const existing = heicPreviewCache.get(key)
  if (existing) {
    heicPreviewCache.delete(key)
    heicPreviewCacheBytes -= existing.byteLength
  }
  while (heicPreviewCacheBytes + preview.byteLength > HEIC_PREVIEW_CACHE_BYTES) {
    const oldest = heicPreviewCache.entries().next().value as [string, Uint8Array] | undefined
    if (!oldest) break
    heicPreviewCache.delete(oldest[0])
    heicPreviewCacheBytes -= oldest[1].byteLength
  }
  heicPreviewCache.set(key, preview)
  heicPreviewCacheBytes += preview.byteLength
}

function heicPreviewWorkerUrl(): URL {
  try {
    // Electron emits CommonJS; the web build and unbundled source use ESM.
    const filename = process.versions.electron ? './heic-preview-worker.cjs' : './heic-preview-worker.mjs'
    return new URL(filename, import.meta.url)
  } catch (error) {
    throw new Error('Failed to resolve HEIC preview worker', { cause: error })
  }
}

function runHeicPreviewWorker(input: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const inputBuffer = input.buffer as ArrayBuffer
    const worker = new Worker(heicPreviewWorkerUrl(), {
      workerData: {
        input: inputBuffer,
        maxPixels: HEIC_PREVIEW_MAX_PIXELS,
        quality: 85,
      },
      transferList: [inputBuffer],
      resourceLimits: {
        maxOldGenerationSizeMb: 384,
        maxYoungGenerationSizeMb: 64,
        stackSizeMb: 4,
      },
    })
    let settled = false
    let timedOut = false
    let workerError: Error | undefined
    let result: { output?: ArrayBuffer; error?: string } | undefined
    const timeout = setTimeout(() => {
      if (settled) return
      timedOut = true
      background(worker.terminate().catch((error) => {
        if (settled) return
        settled = true
        reject(error)
      }), { name: 'heic-preview.terminate-worker' })
    }, HEIC_PREVIEW_TIMEOUT_MS)

    worker.once('message', (message: { output?: ArrayBuffer; error?: string }) => {
      result = message
    })
    worker.once('error', (error) => {
      workerError = error
    })
    worker.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (timedOut) reject(new Error('HEIC preview conversion timed out'))
      else if (workerError) reject(workerError)
      else if (code !== 0) reject(new Error(`HEIC preview worker exited with code ${code}`))
      else if (result?.error) reject(new Error(result.error))
      else if (result?.output) resolve(new Uint8Array(result.output))
      else reject(new Error('HEIC preview worker returned no image'))
    })
  })
}

function queueHeicPreview<T>(task: () => Promise<T>): Promise<T> {
  const queued = heicPreviewQueue.then(task)
  heicPreviewQueue = queued.then(() => undefined, () => undefined)
  return queued
}

async function renderHeicPreview(actor: AgentActor, resolvedPath: string, stat: FileStat): Promise<Uint8Array> {
  if (stat.size > HEIC_PREVIEW_MAX_SOURCE_BYTES) {
    throw new Error('HEIC file exceeds the preview size limit')
  }

  return queueHeicPreview(async () => {
    const reader = (await actor.files.read(resolvedPath)).getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    let done = false
    while (!done) {
      const read = await reader.read()
      if (read.done) {
        done = true
        continue
      }
      const value = read.value
      size += value.byteLength
      if (size > HEIC_PREVIEW_MAX_SOURCE_BYTES) {
        await reader.cancel()
        throw new Error('HEIC file exceeds the preview size limit')
      }
      chunks.push(value)
    }

    const input = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      input.set(chunk, offset)
      offset += chunk.byteLength
    }
    const digest = createHash('sha256').update(input).digest('base64url')
    const key = `${actor.slug}\0${resolvedPath}\0${digest}`
    const cached = cachedHeicPreview(key)
    if (cached) return cached

    const preview = await runHeicPreviewWorker(input)
    cacheHeicPreview(key, preview)
    return preview
  })
}

// GET /api/agents/:id/files/* - Download a file from the agent workspace
agents.get('/:id/files/*', AgentRead(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    // Extract file path from URL - wildcard param can be unreliable in sub-routers.
    // The prefix must use the RAW :id route param (the display slug as it appears in
    // the URL), NOT the resolved canonical agentSlug — otherwise startsWith() fails on
    // a display-slug route and the path comes back empty (400). The resolved id is
    // only for locating the workspace dir below.
    const urlPath = new URL(c.req.url).pathname
    const filesPrefix = `/api/agents/${c.req.param('id')}/files/`
    const filePath = urlPath.startsWith(filesPrefix)
      ? decodeURIComponent(urlPath.slice(filesPrefix.length))
      : ''

    if (!filePath) {
      return c.json({ error: 'File path is required' }, 400)
    }

    // Security: lexical containment is the actor's; a path that would leave
    // the workspace fails as a WorkspaceFileError, answered as 400 in the
    // catch below. The file is then served by its real location, as it
    // always was: a link is followed only while it stays inside the
    // workspace, and one that leaves it is the same 400.
    const actor = agentRegistry.get(agentSlug)
    const resolved = await actor.files.resolve(filePath)
    const stat = resolved === null ? null : await actor.files.stat(resolved)
    if (resolved === null || !stat || stat.kind !== 'file') {
      return c.json({ error: 'File not found' }, 404)
    }

    const filename = path.basename(filePath)
    const encodedFilename = encodeURIComponent(filename)
    const inline = new URL(c.req.url).searchParams.get('inline') === 'true'
    const heicPreview = inline && HEIC_EXTENSIONS.has(path.extname(filename).toLowerCase())
    if (inline) {
      c.header('Content-Disposition', `inline; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`)
      c.header('Content-Type', heicPreview ? 'image/jpeg' : guessMimeType(filename))
    } else {
      c.header('Content-Disposition', `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`)
      c.header('Content-Type', 'application/octet-stream')
    }

    // Workspace files are mutable (the agent rewrites and redelivers them) and
    // per-user authorized. Without an explicit directive an intermediary CDN
    // applies its own default TTL by file extension — Cloudflare was serving
    // 4-hour-old .mp4 renders as cf-cache-status: HIT, and a shared cache holding
    // an authorized response is a leak as well as a staleness bug. `private`
    // keeps it out of shared caches, `no-store` out of the browser's too.
    //
    // `no-store` over `no-cache` is deliberate, and it is the strict choice: it
    // costs re-fetches (a seek past the media element's buffer below, an inline
    // markdown image on remount) to buy an unconditional guarantee that no cache
    // anywhere holds these bytes. Reclaiming those bytes means serving a
    // validator — an mtime/size ETag plus If-None-Match → 304 — which is worth
    // doing, but not as an unvalidated rider on a leak fix.
    c.header('Cache-Control', 'private, no-store, max-age=0')

    if (heicPreview) {
      if (c.req.method === 'HEAD') return c.body(null)
      try {
        const preview = await renderHeicPreview(actor, resolved, stat)
        c.header('Content-Length', String(preview.byteLength))
        return c.body(new Uint8Array(preview))
      } catch (error) {
        console.error('Failed to render HEIC preview:', error)
        captureException(error, {
          tags: { component: 'agents', operation: 'render-heic-preview' },
          extra: { agentSlug, filePath },
        })
        return c.json({ error: 'Failed to preview image' }, 422)
      }
    }

    const served = servedRange(c.req.header('range'), stat.size)

    // Hono has no HEAD routing: its dispatcher answers a HEAD by running the
    // GET handler and dropping the body (`new Response(null, await dispatch(…,
    // 'GET'))`). A stream opened below would therefore be constructed, never
    // read and never closed — Node's stream only closes its descriptor once the
    // consumer drains or destroys it, so every HEAD of a file past the 64KB
    // high-water mark leaks one fd for the life of the process. The headers are
    // the entire answer to a HEAD anyway; return before opening anything.
    // (`c.req.method` is the real method — the dispatcher overrides its routing
    // key, not the request.)
    if (served.status === 416 || c.req.method === 'HEAD') return c.body(null, served.status, served.headers)
    return c.body(await actor.files.read(resolved, served.range ?? undefined), served.status, served.headers)
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      return c.json({ error: error.status === 400 ? 'Invalid path' : error.message }, error.status)
    }
    console.error('Failed to download file:', error)
    return c.json({ error: 'Failed to download file' }, 500)
  }
})

// POST /api/agents/:id/sessions/:sessionId/provide-file - Provide or decline a file request
agents.post('/:id/sessions/:sessionId/provide-file', AgentUser(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const body = await c.req.json()
    const { toolUseId, filePath, decline, declineReason } = body

    if (!toolUseId) {
      return c.json({ error: 'toolUseId is required' }, 400)
    }

    const gated = await gateRequestDecision(c, toolUseId, 'file')
    if (gated) return gated


    const actor = agentRegistry.get(agentSlug)

    if (decline) {
      const reason = declineReason || 'User declined to provide the file'

      const rejectResponse = await actor.container.fetch(
        `/inputs/${encodeURIComponent(toolUseId)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        }
      )

      if (!rejectResponse.ok) {
        const error = await rejectResponse.json()
        console.error('Failed to reject file request:', error)
        return c.json({ error: 'Failed to reject file request' }, 500)
      }

      await agentRegistry.get(agentSlug).inputs.complete(c.req.param('sessionId'), toolUseId, 'declined')
      trackServerEvent('request_declined', { type: 'file', withReason: !!declineReason })
      return c.json({ success: true, declined: true })
    }

    if (!filePath) {
      return c.json({ error: 'filePath is required when not declining' }, 400)
    }

    // Resolve the pending input request with the file path
    console.log(`[provide-file] Resolving pending request ${toolUseId} with path ${filePath}`)
    const resolveResponse = await actor.container.fetch(
      `/inputs/${encodeURIComponent(toolUseId)}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: filePath }),
      }
    )

    if (!resolveResponse.ok) {
      let errorDetails = 'Unknown error'
      try {
        const error = await resolveResponse.json()
        errorDetails = JSON.stringify(error)
      } catch {
        errorDetails = await resolveResponse.text()
      }
      console.error(`[provide-file] Failed to resolve request: ${errorDetails}`)
      return c.json({ error: 'Failed to notify agent of uploaded file' }, 500)
    }
    console.log(`[provide-file] Request ${toolUseId} resolved successfully`)
    await agentRegistry.get(agentSlug).inputs.complete(c.req.param('sessionId'), toolUseId, 'answered')

    return c.json({ success: true, filePath })
  } catch (error) {
    console.error('Failed to provide file:', error)
    return c.json({ error: 'Failed to provide file' }, 500)
  }
})

// ============================================================
// Dashboard / Artifacts endpoints
// ============================================================

// GET /api/agents/:id/artifacts - List dashboards for an agent
agents.get('/:id/artifacts', AgentRead(), async (c) => {
  try {
    const slug = getAgentId(c)


    // Always read name/description from host filesystem (source of truth for metadata)
    const fsDashboards = await listArtifactsFromFilesystem(slug)

    // Try to merge with running container data (provides live status + port)
    try {
      const actor = agentRegistry.get(slug)
      // Use cached status to avoid spawning docker process
      const info = await agentRegistry.get(slug).container.status()

      if (info.status === 'running') {
        const response = await actor.container.fetch('/artifacts')
        if (response.ok) {
          const containerDashboards = await response.json() as ArtifactInfo[]
          const fsMap = new Map(fsDashboards.map(d => [d.slug, d]))

          // Use container status/port but filesystem name/description
          const merged = containerDashboards.map(cd => {
            const fs = fsMap.get(cd.slug)
            return fs
              ? { ...cd, name: fs.name, description: fs.description }
              : cd
          })
          // Include any filesystem-only dashboards (not yet tracked by container)
          for (const fsd of fsDashboards) {
            if (!containerDashboards.some(cd => cd.slug === fsd.slug)) {
              merged.push(fsd)
            }
          }
          return c.json(merged)
        }
      }
    } catch {
      // Container not running, fall through to filesystem-only data
    }

    return c.json(fsDashboards)
  } catch (error) {
    console.error('Failed to fetch artifacts:', error)
    return c.json({ error: 'Failed to fetch artifacts' }, 500)
  }
})

// DELETE /api/agents/:id/artifacts/:artifactSlug - Delete a dashboard
agents.delete('/:id/artifacts/:artifactSlug', AgentAdmin(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const artifactSlug = c.req.param('artifactSlug')

    // Stop the dashboard process in the container (if running), then delete files
    try {
      const actor = agentRegistry.get(agentSlug)
      const info = await agentRegistry.get(agentSlug).container.status()
      if (info.status === 'running') {
        await actor.container.fetch(`/artifacts/${encodeURIComponent(artifactSlug)}`, { method: 'DELETE' })
      }
    } catch {
      // Container not running — just delete files
    }

    await deleteArtifactFromFilesystem(agentSlug, artifactSlug)
    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to delete artifact:', error)
    return c.json({ error: 'Failed to delete artifact' }, 500)
  }
})

// PATCH /api/agents/:id/artifacts/:artifactSlug - Rename a dashboard
agents.patch('/:id/artifacts/:artifactSlug', AgentAdmin(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const artifactSlug = c.req.param('artifactSlug')
    const { name } = await c.req.json()

    if (!name || typeof name !== 'string' || !name.trim()) {
      return c.json({ error: 'Name is required' }, 400)
    }

    await renameArtifactOnFilesystem(agentSlug, artifactSlug, name.trim())
    return c.json({ ok: true })
  } catch (error) {
    console.error('Failed to rename artifact:', error)
    return c.json({ error: 'Failed to rename artifact' }, 500)
  }
})

// ============================================================
// Widgets — an artifact's static snapshot, refreshed by a script in the
// container. Routes live under the artifact and are registered before the
// dashboard proxy so /artifacts/:slug/widget/* never reaches a dashboard.
// ============================================================

// The after-run trigger listens on the global feed; arm it
// once when the routes register (both the web server and Electron main
// import this module exactly once).
widgetRefreshService.start()

const WidgetSnapshotQuery = z.object({
  family: widgetSizeSchema.optional(),
  scale: z.enum(['2', '3']).optional(),
  scheme: widgetSchemeSchema.optional(),
})

// GET /api/agents/:id/widgets - Every artifact that exposes a widget, with
// snapshot state, from the host filesystem. Never touches the container:
// this is what App Home and a cold launch read, and it must be free.
agents.get('/:id/widgets', AgentRead(), async (c) => {
  try {
    const slug = getAgentId(c)
    const widgets = await listWidgetsFromFilesystem(slug)
    return c.json(await widgetRefreshService.decorate(slug, widgets))
  } catch (error) {
    console.error('Failed to list widgets:', error)
    return c.json({ error: 'Failed to list widgets' }, 500)
  }
})

// POST /api/agents/:id/widgets/refresh-stale - The Agent Home mount trigger.
// Starts a refresh for every stale widget (waking the container if needed)
// and returns the slugs in flight; completion arrives over SSE. Throttled
// per agent so tab-switching cannot spam the container.
//
// AgentUser, not AgentRead: this can start a container, which is what
// POST /:id/start requires. Reading a widget stays free — the listing, the
// snapshot document and the PNG never touch the container.
agents.post('/:id/widgets/refresh-stale', AgentUser(), async (c) => {
  try {
    const slug = getAgentId(c)
    const result = await widgetRefreshService.refreshStale(slug, { wake: true })
    return c.json(result)
  } catch (error) {
    console.error('Failed to refresh stale widgets:', error)
    return c.json({ error: 'Failed to refresh widgets' }, 500)
  }
})

// POST /api/agents/:id/artifacts/:artifactSlug/widget/refresh - Explicit
// refresh (the card's refresh button). Waits for the container so the caller
// gets the outcome; the SSE events fire along the way as well.
agents.post('/:id/artifacts/:artifactSlug/widget/refresh', AgentUser(), async (c) => {
  const slug = getAgentId(c)
  const artifactSlug = c.req.param('artifactSlug')
  if (!resolveWidgetPath(slug, artifactSlug)) return c.json({ error: 'Invalid artifact slug' }, 400)
  const widget = await readWidgetFromFilesystem(slug, artifactSlug)
  if (!widget) return c.json({ error: 'Artifact has no widget' }, 404)
  const outcome = await widgetRefreshService.refreshWidget(slug, artifactSlug, { wake: true, reason: 'manual' })
  if (!outcome.ok) return c.json({ ok: false, error: outcome.error }, 502)
  return c.json({ ok: true, snapshot: outcome.snapshot })
})

// GET /api/agents/:id/artifacts/:artifactSlug/widget/html?scheme=light|dark -
// The snapshot document for the in-app iframe. Served straight off disk with
// a display-only CSP; the renderer adds a sandbox without allow-scripts.
agents.get('/:id/artifacts/:artifactSlug/widget/html', AgentRead(), async (c) => {
  const slug = getAgentId(c)
  const artifactSlug = c.req.param('artifactSlug')
  const scheme = widgetSchemeSchema.safeParse(c.req.query('scheme'))
  const html = await readWidgetHtml(slug, artifactSlug)
  if (html === null) return c.json({ error: 'Widget has no snapshot yet' }, 404)
  return c.body(scheme.success ? renderWidgetDocument(html, scheme.data) : html, 200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': WIDGET_HTML_CSP,
    'x-content-type-options': 'nosniff',
    // The iframe URL carries the html hash, so a changed snapshot is a new
    // URL; the document itself can be cached briefly and privately.
    'cache-control': 'private, max-age=60, must-revalidate',
  })
})

// GET /api/agents/:id/artifacts/:artifactSlug/widget/snapshot?family=&scale=&scheme=
// Rasterized PNG for native surfaces (the iOS widget extension). Served from
// the agent's workspace, so it works while the container sleeps.
agents.get('/:id/artifacts/:artifactSlug/widget/snapshot', AgentRead(), async (c) => {
  const slug = getAgentId(c)
  const artifactSlug = c.req.param('artifactSlug')
  const parsed = WidgetSnapshotQuery.safeParse({
    family: c.req.query('family'),
    scale: c.req.query('scale'),
    scheme: c.req.query('scheme'),
  })
  if (!parsed.success) return c.json({ error: 'Invalid snapshot query' }, 400)
  const widget = await readWidgetFromFilesystem(slug, artifactSlug)
  if (!widget) return c.json({ error: 'Artifact has no widget' }, 404)
  const family = parsed.data.family ?? widget.size
  const scale = parsed.data.scale === '3' ? 3 : 2
  const scheme = parsed.data.scheme ?? 'light'
  const pngPath = widgetSnapshotPngPath(slug, artifactSlug, family, scheme, scale)
  if (!pngPath) return c.json({ error: 'Invalid artifact slug' }, 400)
  try {
    // Where the file really is, the check this route always made; an
    // unexpected read failure is still this route's 500, not an absence.
    const realPngPath = await containedArtifactPath(slug, pngPath)
    const png = realPngPath === null ? null : await agentRegistry.get(slug).files.getDoc(realPngPath)
    if (png === null) return c.json({ error: 'No snapshot rendered yet' }, 404)
    // The bytes as read, not a copy: a typed view is all Response needs.
    return new Response(png as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'cache-control': 'private, max-age=60, must-revalidate',
        ...(widget.generatedAt ? { 'x-widget-generated-at': widget.generatedAt } : {}),
        ...(widget.validUntil ? { 'x-widget-valid-until': widget.validUntil } : {}),
      },
    })
  } catch (error) {
    if (error instanceof WorkspaceFileError) return c.json({ error: error.message }, error.status)
    console.error('Failed to read widget snapshot:', error)
    return c.json({ error: 'Failed to read snapshot' }, 500)
  }
})

// GET /api/agents/:id/artifacts/:artifactSlug/screenshot.png - Serve the
// auto-captured dashboard thumbnail from the agent's workspace. Works
// regardless of whether the container is running. Must be registered before
// the catch-all artifact proxy below.
agents.get('/:id/artifacts/:artifactSlug/screenshot.png', AgentRead(), async (c) => {
  const agentSlug = getAgentId(c)
  const artifactSlug = c.req.param('artifactSlug')

  // A bad slug is answered here; containment of the path is the actor's job.
  // Any artifact the listing shows can have a thumbnail, whatever its
  // directory is called, so this is the artifact rule, not the widget one.
  const screenshotPath = resolveArtifactPath(agentSlug, artifactSlug, 'screenshot.png')
  if (!screenshotPath) {
    return c.json({ error: 'Invalid artifact slug' }, 400)
  }

  try {
    // Read as named, the way the plain read did; a real-location check for
    // dashboard files is part of the containment work tracked separately.
    const png = await agentRegistry.get(agentSlug).files.getDoc(screenshotPath)
    if (png === null) {
      return c.json({ error: 'No screenshot available' }, 404)
    }
    // The bytes as read, not a copy: a typed view is all Response needs.
    return new Response(png as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        // Screenshots are overwritten on every restart, so cache briefly — and
        // `private`, never `public`: this is an AgentRead-authorized .png, an
        // extension a CDN caches by default, so a shared-cache copy would be
        // served to anyone with the URL without our auth ever running.
        'cache-control': 'private, max-age=60, must-revalidate',
      },
    })
  } catch (error) {
    if (error instanceof WorkspaceFileError) return c.json({ error: error.message }, error.status)
    console.error('Failed to read dashboard screenshot:', error)
    return c.json({ error: 'Failed to read screenshot' }, 500)
  }
})

// GET /api/agents/:id/artifacts/:artifactSlug/view - Standalone dashboard wrapper
// Serves a self-contained HTML page that handles agent lifecycle (auto-start, wait, then load dashboard)
agents.get('/:id/artifacts/:artifactSlug/view', AgentRead(), async (c) => {
  const agentSlug = getAgentId(c)
  const artifactSlug = c.req.param('artifactSlug')
  const basePath = `/api/agents/${agentSlug}`
  // For the dispatch-consent dialog: resolved at render time so the wrapper
  // never needs a client-side agent-info fetch (removed by the fast-path work).
  const agentName = (await getAgentRecord(agentSlug))?.name ?? null

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Loading dashboard…</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0a0a0a; color: #e5e5e5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .container { text-align: center; max-width: 400px; padding: 2rem; }
    .spinner { width: 40px; height: 40px; border: 3px solid #333; border-top-color: #888; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 1.5rem; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status { font-size: 14px; color: #999; margin-top: 0.5rem; }
    .error { color: #ef4444; }
    iframe { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; border: 0; }
  </style>
</head>
<body>
  <div class="container" id="loading">
    <div class="spinner"></div>
    <div id="status" class="status">Checking agent status…</div>
  </div>
  <script>
    const agentSlug = ${JSON.stringify(agentSlug)};
    const artifactSlug = ${JSON.stringify(artifactSlug)};
    const basePath = ${JSON.stringify(basePath)};
    const dashboardUrl = basePath + '/artifacts/' + encodeURIComponent(artifactSlug) + '/';
    const statusEl = document.getElementById('status');
    const loadingEl = document.getElementById('loading');
    const agentName = ${JSON.stringify(agentName).replace(/</g, '\\u003c')};

    function setTitle(name) {
      document.title = (name || artifactSlug) + ' \\u2014 Gamut';
    }

    // undefined means the status check itself was inconclusive; null means
    // it completed and the requested dashboard was absent.
    async function fetchDashboard() {
      try {
        const res = await fetch(basePath + '/artifacts');
        if (!res.ok) return undefined;
        const artifacts = await res.json();
        if (!Array.isArray(artifacts)) return undefined;
        const dashboard = artifacts.find(a => a.slug === artifactSlug) || null;
        if (dashboard && dashboard.name) setTitle(dashboard.name);
        return dashboard;
      } catch {}
      return undefined;
    }

    // The iframe is mounted (hidden behind the spinner) as soon as the agent
    // start is underway: the container proxy holds a document request for a
    // 'starting' dashboard until its server binds, so the fetch overlaps
    // startup instead of following it. The spinner drops once a load event
    // arrives after 'running' has been observed; a document that finished
    // loading earlier (e.g. the hold timed out into an error body) is
    // refetched exactly once when 'running' arrives.
    let iframe = null;
    let confirmedRunning = false;
    let loadedEarly = false;
    let revealed = false;

    function reveal() {
      if (revealed) return;
      revealed = true;
      loadingEl.remove();
      iframe.style.visibility = 'visible';
    }

    function mountFrame() {
      if (iframe) return;
      iframe = document.createElement('iframe');
      iframe.style.visibility = 'hidden';
      iframe.src = dashboardUrl;
      iframe.sandbox = 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads';
      iframe.allow = 'microphone; camera';
      iframe.onload = () => {
        if (confirmedRunning) reveal();
        else loadedEarly = true;
      };
      document.body.appendChild(iframe);
      // Host the session-dispatch confirmation dialog for the wrapped
      // dashboard. typeof-guarded: unit tests run this script in a bare vm
      // context that has no window at all.
      if (typeof window !== 'undefined' && window.__gamutDispatchHost) {
        window.__gamutDispatchHost.attach({ iframe, agentSlug, agentName, artifactSlug, basePath });
      }
    }

    function onRunning(name) {
      if (confirmedRunning) return;
      confirmedRunning = true;
      setTitle(name);
      mountFrame();
      if (loadedEarly) {
        loadedEarly = false;
        iframe.src = dashboardUrl;
      }
    }

    async function run() {
      try {
        statusEl.textContent = 'Starting agent…';
        // Fire the start immediately — it is idempotent and returns fast for a
        // running agent — and fetch dashboard metadata/status in parallel.
        const startPromise = fetch(basePath + '/start', { method: 'POST' });
        startPromise.catch(() => {});
        const initialDashboard = await fetchDashboard();

        if (initialDashboard === null) { throw new Error('Dashboard not found.'); }
        if (initialDashboard && initialDashboard.status === 'running') {
          // Warm path: both processes already up — paint without waiting for
          // the start round trip.
          onRunning(initialDashboard.name);
          return;
        }

        const startRes = await startPromise;
        if (!startRes.ok) {
          const err = await startRes.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to start agent');
        }

        // Optimistic mount: the held document request resolves the moment the
        // dashboard server binds, while the poll below confirms the outcome.
        mountFrame();
        statusEl.textContent = 'Waiting for dashboard…';
        await pollDashboard();
      } catch (err) {
        statusEl.textContent = err.message;
        statusEl.classList.add('error');
      }
    }

    async function pollDashboard() {
      // Fast cadence while startup is expected to be quick, then back off.
      for (let i = 0; i < 280; i++) {
        const res = await fetch(basePath + '/artifacts');
        if (res.ok) {
          const artifacts = await res.json();
          if (Array.isArray(artifacts)) {
            const d = artifacts.find(a => a.slug === artifactSlug);
            if (!d) { throw new Error('Dashboard not found.'); }
            if (d.status === 'crashed') { throw new Error('Dashboard crashed.'); }
            if (d.status === 'running') { onRunning(d.name); return; }
            if (d.status === 'starting' && d.startupPhase === 'installing-dependencies') {
              statusEl.textContent = d.firstRun
                ? 'Preparing dashboard for first use…'
                : 'Installing dashboard dependencies…';
            } else {
              statusEl.textContent = 'Starting dashboard…';
            }
          }
        }
        await new Promise(r => setTimeout(r, i < 100 ? 300 : 1000));
      }
      throw new Error('Dashboard did not start in time');
    }

    run();
  </script>
  <!-- After the main wrapper script: existing tests extract "the" wrapper
       script with a first-match regex, and parse order doesn't matter — the
       host is only referenced from showDashboard(), long after both parse. -->
  <script>${getDashboardViewDispatchHostJs()}</script>
</body>
</html>`

  return c.html(html)
})

// Shared handler for proxying artifact requests to the container
const skipProxyRequestHeaders = new Set([
  'host', 'connection', 'transfer-encoding',
  // Node fetch transparently decodes upstream bodies. Ask every hop for the
  // identity representation so body bytes and response metadata cannot drift.
  'accept-encoding',
])
const conditionalRequestHeaders = new Set(['if-modified-since', 'if-none-match'])

async function proxyArtifactRequest(c: any) {
  const agentSlug = getAgentId(c)
  const artifactSlug = c.req.param('artifactSlug')

  const actor = agentRegistry.get(agentSlug)
  // Use cached status to avoid spawning docker process
  const info = await agentRegistry.get(agentSlug).container.status()

  if (info.status !== 'running') {
    return c.json({ error: 'Agent is not running. Start the agent to view this dashboard.' }, 503)
  }

  // Build the container path. The prefix must use the RAW :id route param (the
  // display slug as it appears in the URL), NOT the resolved canonical agentSlug:
  // url.pathname still carries the display slug, so an id-based prefix would not be
  // found (indexOf → -1) and corrupt subPath. The resolved id is only for the
  // container lookup above.
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url is always a valid URL
  const url = new URL(c.req.url)
  const routeSlug = c.req.param('id')
  const prefix = `/api/agents/${routeSlug}/artifacts/${artifactSlug}`
  const publicBasePath = dashboardMountPath(routeSlug, artifactSlug)
  const subPath = url.pathname.slice(url.pathname.indexOf(prefix) + prefix.length) || '/'
  const containerPath = `/artifacts/${artifactSlug}${subPath}${url.search}`

  // Framework router bases are compiled from the canonical id passed to the
  // dashboard process. A display-slug document URL would therefore disagree
  // with that router base. Canonicalize navigations while continuing to proxy
  // non-document assets for compatibility with older relative builds.
  if (
    routeSlug !== agentSlug
    && (c.req.method === 'GET' || c.req.method === 'HEAD')
    && c.req.header('accept')?.includes('text/html')
  ) {
    const canonicalBasePath = dashboardMountPath(encodeURIComponent(agentSlug), artifactSlug)
    return c.redirect(`${canonicalBasePath.slice(0, -1)}${subPath}${url.search}`, 307)
  }

  // Forward request headers (minus hop-by-hop headers)
  const reqHeaders = c.req.header() as Record<string, string>
  const headers: Record<string, string> = {}
  // Dashboard HTML is injected per request, so an upstream 304 cannot safely
  // stand in for the browser's transformed representation. Assets are not
  // transformed and retain normal ETag/Last-Modified revalidation.
  const isDocumentRequest = (c.req.method === 'GET' || c.req.method === 'HEAD')
    && c.req.header('accept')?.includes('text/html')
  for (const key of Object.keys(reqHeaders)) {
    const normalizedKey = key.toLowerCase()
    if (
      !skipProxyRequestHeaders.has(normalizedKey)
      && !(isDocumentRequest && conditionalRequestHeaders.has(normalizedKey))
    ) {
      headers[key] = reqHeaders[key]
    }
  }
  headers['accept-encoding'] = 'identity'
  headers['x-forwarded-prefix'] = publicBasePath.slice(0, -1)
  headers['x-forwarded-host'] = c.req.header('x-forwarded-host') || url.host
  headers['x-forwarded-proto'] = c.req.header('x-forwarded-proto') || url.protocol.slice(0, -1)
  // Hono's Node connection metadata is unavailable in direct app.request()
  // calls (including tests and some embedded adapters). Existing forwarded
  // metadata is still preserved in that case.
  let remoteAddress: string | undefined
  try {
    remoteAddress = getConnInfo(c).remote.address
  } catch {
    remoteAddress = undefined
  }
  if (remoteAddress) {
    const forwardedFor = c.req.header('x-forwarded-for')
    headers['x-forwarded-for'] = forwardedFor ? `${forwardedFor}, ${remoteAddress}` : remoteAddress
  }

  const init: RequestInit = { method: c.req.method, headers, redirect: 'manual' }
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    init.body = await c.req.arrayBuffer()
  }

  const response = await actor.container.fetch(containerPath, init)

  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('text/html')) {
    const html = injectDashboardRuntime(await response.text(), {
      basePath: publicBasePath,
      slug: artifactSlug,
      polyfillJs: getPolyfillJs() + getLlmPolyfillJs(),
    })
    return new Response(html, {
      status: response.status,
      headers: dashboardResponseHeaders(response.headers, publicBasePath, { transformedHtml: true }),
    })
  }

  return new Response(response.body, {
    status: response.status,
    headers: dashboardResponseHeaders(response.headers, publicBasePath),
  })
}

// ALL /api/agents/:id/artifacts/:slug/* - Proxy all methods to dashboard server
agents.all('/:id/artifacts/:artifactSlug/*', AgentRead(), async (c) => {
  try {
    return await proxyArtifactRequest(c)
  } catch (error: any) {
    console.error('Failed to proxy artifact:', error)
    return c.json({ error: error.message || 'Failed to proxy artifact' }, 502)
  }
})

// Also handle without trailing path
agents.all('/:id/artifacts/:artifactSlug', AgentRead(), async (c) => {
  try {
    return await proxyArtifactRequest(c)
  } catch (error: any) {
    console.error('Failed to proxy artifact:', error)
    return c.json({ error: error.message || 'Failed to proxy artifact' }, 502)
  }
})

// ============================================================
// Browser proxy endpoints
// ============================================================

// GET /api/agents/:id/browser/status - Check browser state
agents.get('/:id/browser/status', AgentRead(), async (c) => {
  try {
    const slug = getAgentId(c)


    const actor = agentRegistry.get(slug)
    // Use cached status to avoid spawning docker process
    const info = await agentRegistry.get(slug).container.status()

    if (info.status !== 'running') {
      return c.json({ active: false, sessionId: null })
    }

    const response = await actor.container.fetch('/browser/status')
    return c.json(await response.json())
  } catch (error) {
    console.error('Failed to get browser status:', error)
    return c.json({ active: false, sessionId: null })
  }
})

// POST /api/agents/:id/browser/:action - Proxy browser tool actions
agents.post('/:id/browser/:action', AgentUser(), async (c) => {
  try {
    const slug = getAgentId(c)
    const action = c.req.param('action')


    const actor = agentRegistry.get(slug)
    // Use cached status to avoid spawning docker process
    const info = await agentRegistry.get(slug).container.status()

    if (info.status !== 'running') {
      return c.json({ error: 'Agent container is not running' }, 400)
    }

    const body = await c.req.json()
    const response = await actor.container.fetch(`/browser/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const data = await response.json()
    return c.json(data, response.status as any)
  } catch (error: any) {
    console.error('Failed to proxy browser action:', error)
    return c.json({ error: error.message || 'Failed to proxy browser action' }, 500)
  }
})

// ============================================================================
// Cleanup stale chunked uploads (older than 1 hour)
// ============================================================================
const STALE_UPLOAD_MS = 60 * 60 * 1000 // 1 hour

async function cleanupStaleUploads() {
  try {
    await cleanupStaleTempUploads(STALE_UPLOAD_MS)
  } catch (err) {
    console.warn('[agents] stale upload cleanup failed:', err)
    captureException(err, { tags: { component: 'agents', operation: 'cleanup-stale-uploads' } })
  }
}

// Run cleanup on startup and every 30 minutes
background(cleanupStaleUploads(), { name: 'agents-route.cleanup-stale-uploads' })
setInterval(() => background(cleanupStaleUploads(), { name: 'agents-route.cleanup-stale-uploads' }), 30 * 60 * 1000).unref()

// =============================================================================
// Pending user-input requests (unified wire)
// =============================================================================

// GET /api/agents/:id/pending-requests?sessionId= — snapshot of the open
// user-input requests visible to the agent, optionally narrowed to a session's
// view (its own requests plus the agent-scoped reviews that block every
// session of the agent). This is the recovery source for the unified client
// store: mount, reconnect, and invalidation refetch from here; live updates
// arrive as user_request_created / user_request_resolved on the session and
// global SSE streams; clients treat those as invalidation triggers and read
// the resulting state from here.
agents.get('/:id/pending-requests', AgentRead(), async (c) => {
  const agentSlug = getAgentId(c)
  const sessionId = c.req.query('sessionId') || undefined
  return c.json({ requests: await agentRegistry.get(agentSlug).inputs.snapshot(sessionId) })
})

// =============================================================================
// Re-authentication endpoints
// =============================================================================

const MAX_DISMISS_REASON_LENGTH = 500

agents.route('/', accountReauth)
agents.route('/', mcpReauth)
agents.route('/', agentMemoryRoutes)
agents.route('/', agentBrowserAccountRoutes)

// POST /api/agents/:id/reauth-request/:requestId/dismiss - Give up on a parked
// re-authentication card.
//
// A reauth card is agent-scoped and blocking: while it is open, every session
// of the agent sits in awaiting-input. Reconnecting is the owner's privilege,
// so when the shared credential belongs to someone else, nobody in the room
// can clear the card and the agent stays stuck until the five-minute timer
// fires. This is the escape hatch — it fails the parked call with a distinct
// "dismissed" status (not a timeout) so the agent knows a person decided it.
//
// AgentUser(), not AgentAdmin(): anyone who can put work into this agent can
// abandon a call it is stuck on. Viewers, who cannot, are excluded.
agents.post('/:id/reauth-request/:requestId/dismiss', AgentUser(), async (c) => {
  const slug = getAgentId(c)
  const requestId = c.req.param('requestId')
  const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }))
  // Bounded: this text is forwarded into the proxy's error body and written to
  // the audit log, so it must not be an unbounded write from the composer.
  const reason = typeof body.reason === 'string' && body.reason.trim()
    ? body.reason.trim().slice(0, MAX_DISMISS_REASON_LENGTH)
    : undefined

  const open = await agentRegistry.get(slug).inputs.get(requestId)
  if (open) {
    // A caller-supplied id points into a global, cross-agent registry, so both
    // the kind and the agent are re-checked against the URL before we settle
    // anything — the same guard the review routes apply.
    if (
      open.scope.agentSlug !== slug ||
      (open.kind !== 'account_reauth_required' && open.kind !== 'mcp_reauth_required')
    ) {
      return c.json({ error: 'Request not found' }, 404)
    }

    const dismissed = open.kind === 'account_reauth_required'
      ? await agentRegistry.get(slug).inputs.accountReauth.dismiss(requestId, reason)
      : await agentRegistry.get(slug).inputs.mcpReauth.dismiss(requestId, reason)

    // An open envelope whose parked group is already gone (every waiter
    // aborted, but the entry outlived them) would otherwise leave the card —
    // and the awaiting-input state behind it — on screen forever. Clearing it
    // is the whole point of this route, so do it rather than report success
    // and change nothing.
    if (!dismissed) await agentRegistry.get(slug).inputs.resolve(requestId, 'cancelled')

    // Short form, matching the `type` its sibling decline routes emit
    // ('secret', 'connected_account') rather than the raw registry kind.
    const declinedType = open.kind === 'account_reauth_required' ? 'account_reauth' : 'mcp_reauth'
    trackServerEvent('request_declined', { type: declinedType, withReason: !!reason })
    return c.json({ success: true })
  }

  // Settled or unknown. Report on it only through the route that could have
  // decided it, so settling a request never widens who may read its outcome.
  const settled = await agentRegistry.get(slug).inputs.recentResolution(requestId)
  if (settled && (
    settled.scope.agentSlug !== slug ||
    (settled.kind !== 'account_reauth_required' && settled.kind !== 'mcp_reauth_required')
  )) {
    return c.json({ error: 'Request not found' }, 404)
  }
  // 200, not an error: the caller's intent is already satisfied and a stale
  // card should dismiss itself exactly like a successful one.
  return c.json({
    success: true,
    alreadySettled: true,
    ...(settled ? { outcome: settled.outcome } : {}),
  })
})

// =============================================================================
// Proxy review endpoints
// =============================================================================

// POST /api/agents/:id/proxy-review/:reviewId - Submit a review decision
agents.post('/:id/proxy-review/:reviewId', AgentUser(), async (c) => {
  const slug = getAgentId(c)
  const reviewId = c.req.param('reviewId')
  const body = await c.req.json<{ decision: 'allow' | 'deny' }>()

  if (!body.decision || !['allow', 'deny'].includes(body.decision)) {
    return c.json({ error: 'Invalid decision. Must be "allow" or "deny".' }, 400)
  }

  // Approving an agent's proxy rule persists access on the account or MCP
  // server, so (like "always allow") only its owner may approve it.
  const proposal = (await agentRegistry.get(slug).inputs.reviews.get(reviewId))?.ruleProposal
  if (proposal && body.decision === 'allow' && isAuthMode()) {
    const context = await loadTargetContext({ kind: proposal.ruleKind, targetId: proposal.targetId })
    if (!context || context.userId !== getCurrentUserId(c)) {
      return c.json({ error: 'Forbidden: only the owner of this connection can approve its rules' }, 403)
    }
  }

  // Pass slug so submitDecision rejects cross-agent attempts. AgentUser()
  // verifies the URL agent only — without this, a user with role on agent A
  // could resolve agent B's review by sending B's reviewId to A's URL.
  const success = await agentRegistry.get(slug).inputs.reviews.submit(reviewId, body.decision)
  if (!success) {
    return c.json({ error: 'Review not found or already resolved' }, 404)
  }
  if (proposal) {
    await auditRuleDecision({ proposal, approved: body.decision === 'allow', agentSlug: slug, via: 'app', userId: getCurrentUserId(c) })
  }

  return c.json({ ok: true })
})

// POST /api/agents/:id/proxy-review/:reviewId/always - Submit decision and save as policy
agents.post('/:id/proxy-review/:reviewId/always', AgentUser(), async (c) => {
  const reviewId = c.req.param('reviewId')
  const slug = getAgentId(c)
  const body = await c.req.json<{
    decision: 'allow' | 'deny'
    scope: string
    accountId: string
    reviewType?: 'mcp' | 'api' | 'xagent'
    // For xagent: { operation: 'list' | 'read' | 'invoke', targetSlug?: string }
    xAgent?: { operation: 'list' | 'read' | 'invoke'; targetSlug: string | null }
  }>()

  if (!body.decision || !['allow', 'deny'].includes(body.decision)) {
    return c.json({ error: 'Invalid decision' }, 400)
  }

  const pendingReview = await agentRegistry.get(slug).inputs.reviews.get(reviewId)
  if (body.decision === 'allow' && requiresOneTimeXAgentReview(pendingReview?.xAgent)) {
    return c.json({ error: 'File-sharing reviews can only be allowed once' }, 400)
  }
  // An unnamed call's scopes union every action on its path: a policy on one of them can allow a delete.
  if (body.decision === 'allow' && body.scope !== '*' && pendingReview?.endpointAmbiguous) {
    return c.json({ error: 'This request can only be allowed once or for every request to this account' }, 400)
  }
  if (pendingReview?.ruleProposal) {
    return c.json({ error: 'A rule proposal can only be approved or rejected, not saved as a policy' }, 400)
  }

  const policyDecision = body.decision === 'allow' ? 'allow' : 'block'
  const now = new Date()

  // Which policy table this decision belongs to. The pending review is
  // authoritative: the proxy that raised it stamped `reviewType` at creation.
  // The client's claim is only a fallback for envelopes written before the
  // stamp existed — the card used to infer "mcp" from a `tools/call` path
  // prefix, so an MCP call whose JSON-RPC method was anything else (e.g.
  // Railway's `subscriptions/listen`) was sent as an API-scope policy with
  // the MCP server's id, and failed apiScopePolicies' FOREIGN KEY against
  // connected_accounts.
  const reviewType: 'api' | 'mcp' | 'xagent' =
    body.reviewType === 'xagent' && body.xAgent
      ? 'xagent'
      : pendingReview?.reviewType ?? (body.reviewType === 'mcp' ? 'mcp' : 'api')

  // Persist the policy FIRST. The review is only resolved after the write commits,
  // so any concurrent /invoke (or other gated call) that runs after this point
  // will see the new policy on its eval and not create a duplicate review.
  // If the write fails, surface the error instead of silently degrading to "Allow Once" —
  // the user thinks they enabled "always" and would otherwise have no idea it didn't stick.
  try {
    if (reviewType === 'xagent' && body.xAgent) {
      // X-Agent review — save to xAgentPolicies. The "caller" is the agent the
      // review is attached to (slug), not the target.
      const { setPolicy: setAgentPolicy } = await import('@shared/lib/services/x-agent-policy-service')
      await setAgentPolicy(slug, body.xAgent.operation, body.xAgent.targetSlug, policyDecision)
    } else if (reviewType === 'mcp') {
      // MCP tool review — save to mcpToolPolicies
      // accountId is actually the mcpId for MCP reviews.
      // Both policy tables carry a FOREIGN KEY to their owner row, so confirm
      // the row exists up front and answer with a message the card can show,
      // rather than letting SQLite's bare "FOREIGN KEY constraint failed"
      // surface. A 4xx other than 404 on purpose: the card reads 404 as
      // "already resolved elsewhere" and would dismiss itself as allowed.
      if (!body.accountId) {
        return c.json({ error: 'Missing MCP server id' }, 400)
      }
      const [mcpServer] = await db
        .select({ userId: remoteMcpServers.userId })
        .from(remoteMcpServers)
        .where(eq(remoteMcpServers.id, body.accountId))
        .limit(1)
      if (!mcpServer) {
        return c.json({ error: 'MCP server no longer exists; the policy was not saved' }, 400)
      }
      // Verify MCP-server ownership before persisting, mirroring the API-scope
      // branch below: AgentUser() only proves a role on the URL agent, so
      // without this an authenticated user could write a policy onto an MCP
      // server owned by someone else by passing its mcpId here.
      if (isAuthMode() && mcpServer.userId !== getCurrentUserId(c)) {
        return c.json({ error: 'Forbidden: you do not own this MCP server' }, 403)
      }

      await db.insert(mcpToolPolicies).values({
        id: randomUUID(),
        mcpId: body.accountId,
        toolName: body.scope,
        decision: policyDecision,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [mcpToolPolicies.mcpId, mcpToolPolicies.toolName],
        set: { decision: policyDecision, updatedAt: now },
      })
    } else {
      // API scope review — save to apiScopePolicies.
      // Look up the account once: we need its owner (to enforce the auth-mode
      // ownership check) and its toolkit (to validate the scope below).
      if (!body.accountId) {
        return c.json({ error: 'Missing connected account id' }, 400)
      }
      const [acct] = await db
        .select({ userId: connectedAccounts.userId, toolkitSlug: connectedAccounts.toolkitSlug })
        .from(connectedAccounts)
        .where(eq(connectedAccounts.id, body.accountId))
        .limit(1)
      // Same FOREIGN KEY reasoning as the MCP branch: say what is missing
      // instead of letting the insert fail.
      if (!acct) {
        return c.json({ error: 'Connected account no longer exists; the policy was not saved' }, 400)
      }
      if (isAuthMode() && acct.userId !== getCurrentUserId(c)) {
        return c.json({ error: 'Forbidden: you do not own this account' }, 403)
      }
      const toolkitSlug = acct.toolkitSlug

      // Validate the scope against the toolkit's known scope set ∪ sentinels.
      // The in-session "Allow all <label>" action legitimately sends the
      // '*read'/'*write'/'*destructive' risk-group sentinels, so allow those
      // (and the '*' account default) explicitly and reject everything else —
      // a buggy or malicious client must not persist a garbage or smuggled
      // scope (e.g. a sentinel the per-group editor framing never intended).
      if (!isValidApiScope(toolkitSlug, body.scope)) {
        return c.json({ error: `Invalid scope: ${JSON.stringify(body.scope)}` }, 400)
      }

      await db.insert(apiScopePolicies).values({
        id: randomUUID(),
        accountId: body.accountId,
        scope: body.scope,
        decision: policyDecision,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [apiScopePolicies.accountId, apiScopePolicies.scope],
        set: { decision: policyDecision, updatedAt: now },
      })
    }
  } catch (err) {
    console.error('Failed to save policy on always-allow:', err)
    // The user sees this as an inline card error and nothing else records it,
    // so report it: a persistence failure here means "always" silently did
    // not stick, which is exactly the class of bug support only hears about
    // from screenshots.
    captureException(err, {
      tags: { component: 'proxy-review', operation: 'save-policy', reviewType },
      extra: { agentSlug: slug, reviewId, scope: body.scope, accountId: body.accountId },
    })
    return c.json(
      { error: `Failed to save policy: ${err instanceof Error ? err.message : 'unknown error'}` },
      500,
    )
  }

  // Submit decision for this review (and any others matching the same scope).
  // Pass slug so submitDecision rejects cross-agent attempts (see B1).
  await agentRegistry.get(slug).inputs.reviews.submit(reviewId, body.decision)
  await agentRegistry.get(slug).inputs.reviews.resolveMatching(body.scope, body.decision)

  // "Allow all <label>" saves a label sentinel ('*read'/'*write'/'*destructive'),
  // which the exact-scope sweep above can't match. Sweep sibling pending API
  // reviews whose matched scopes carry the same risk label so they resolve now
  // instead of timing out.
  if (isLabelDefaultKey(body.scope)) {
    await agentRegistry.get(slug).inputs.reviews.resolveMatchingByLabel(body.scope.slice(1) as ScopeLabel, body.decision)
  }

  // For x-agent "always allow for all agents" (targetSlug=null on read/invoke),
  // the per-scope match above only resolves prompts for the same exact target.
  // Sweep every pending review of the same operation so sibling prompts
  // (e.g. an in-flight read:bob when the user just allowed read:* globally)
  // also resolve immediately instead of timing out.
  if (body.reviewType === 'xagent' && body.xAgent && body.xAgent.targetSlug === null) {
    await agentRegistry.get(slug).inputs.reviews.resolveMatchingXAgent(body.xAgent.operation, body.decision)
  }

  return c.json({ ok: true })
})

// =============================================================================
// X-Agent invoke policies (per-agent remembered cross-agent permissions)
// =============================================================================

// GET /api/agents/:id/inbound-x-agent - Other-agent calls and widget repairs, plus
// every agent currently eligible to invoke this target. The target's read ACL
// protects the page; caller rows remain visible but carry canAccess=false when
// the viewing user cannot open that caller agent.
agents.get('/:id/inbound-x-agent', AgentRead(), async (c) => {
  try {
    const authMode = isAuthMode()
    const viewer = authMode
      ? c.get('user' as never) as { role?: string } | undefined
      : undefined
    return c.json(await getInboundXAgentDetails(getAgentId(c), {
      authMode,
      viewerUserId: authMode ? getCurrentUserId(c) : undefined,
      viewerCanAccessAll: viewer?.role === 'admin',
    }))
  } catch (error) {
    console.error('Failed to fetch inbound x-agent activity:', error)
    return c.json({ error: 'Failed to fetch calls from other agents' }, 500)
  }
})

/**
 * Agents the caller may see: their agentAcl entries in auth mode, everything
 * in non-auth mode (null = no restriction). One query, reused by the policy
 * read + write paths so their visibility rules can't drift.
 */
async function callerVisibleAgents(c: Context): Promise<Set<string> | null> {
  if (!isAuthMode()) return null
  const userId = getCurrentUserId(c)
  const aclRows = await db
    .select({ agentSlug: agentAcl.agentSlug })
    .from(agentAcl)
    .where(eq(agentAcl.userId, userId))
  return new Set(aclRows.map((r) => r.agentSlug))
}

async function callerCanSeeAgent(c: Context, agentSlug: string): Promise<boolean> {
  const visible = await callerVisibleAgents(c)
  return visible === null || visible.has(agentSlug)
}

// GET /api/agents/:id/x-agent-policies - List policies where this agent is the caller
agents.get('/:id/x-agent-policies', AgentRead(), async (c) => {
  const slug = getAgentId(c)
  const rows = await listPoliciesForCaller(slug)
  // Enrich with target agent display name (best-effort; null target means "list" op)
  const targetSlugs = Array.from(
    new Set(rows.map((r) => r.targetAgentSlug).filter((s): s is string => s !== null)),
  )

  // In auth mode, hide policies whose target the viewer can't see — otherwise
  // the policy editor leaks workspace topology (target slugs the user has no ACL on).
  // null targets ('list' policy) are always visible.
  const visibleTargets = await callerVisibleAgents(c)

  const nameMap = new Map<string, string>()
  for (const targetSlug of targetSlugs) {
    if (visibleTargets && !visibleTargets.has(targetSlug)) continue
    const target = await getAgentRecord(targetSlug)
    if (target) nameMap.set(targetSlug, target.name)
  }
  return c.json({
    policies: rows
      .filter((r) => r.targetAgentSlug === null || !visibleTargets || visibleTargets.has(r.targetAgentSlug))
      .map((r) => ({
        id: r.id,
        operation: r.operation,
        targetAgentSlug: r.targetAgentSlug,
        targetAgentName: r.targetAgentSlug ? nameMap.get(r.targetAgentSlug) ?? null : null,
        decision: r.decision,
        updatedAt: r.updatedAt,
      })),
  })
})

// PATCH /api/agents/:id/x-agent-policies - Atomically update or clear one
// policy. The editor sends independent controls through this route so rapid
// edits never race through the whole-list replacement endpoint below.
agents.patch('/:id/x-agent-policies', AgentAdmin(), async (c) => {
  const slug = getAgentId(c)
  const callerAgent = await getAgentRecord(slug)
  if (!callerAgent) {
    return c.json({ error: 'Agent not found' }, 404)
  }

  const body = await c.req.json().catch(() => ({}))
  const parsed = z.object({
    operation: xAgentOperationSchema,
    targetSlug: z.string().nullable(),
    decision: z.union([xAgentDecisionSchema, z.literal('default')]),
  }).safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid policy payload', details: parsed.error.format() }, 400)
  }

  const { operation, targetSlug, decision } = parsed.data
  if (operation === 'list' && targetSlug !== null) {
    return c.json({ error: 'List policies cannot target an agent' }, 400)
  }
  if (targetSlug === slug) {
    return c.json({ error: 'Cannot set a policy targeting the same agent' }, 400)
  }
  if (targetSlug !== null) {
    const targetAgent = await getAgentRecord(targetSlug)
    if (!targetAgent || !(await callerCanSeeAgent(c, targetSlug))) {
      return c.json({ error: 'Agent not found' }, 404)
    }
  }

  if (decision === 'default') {
    const removed = await deletePolicy(slug, operation, targetSlug)
    return c.json({ ok: true, removed })
  }
  const result = await setPolicy(slug, operation, targetSlug, decision)
  return c.json({ ok: true, ...result })
})

// PUT /api/agents/:id/x-agent-policies - Replace all policies for this caller (batch)
agents.put('/:id/x-agent-policies', AgentAdmin(), async (c) => {
  const slug = getAgentId(c)
  // AgentAdmin checks role but not existence (and is a no-op in non-auth mode);
  // assert here so a typo'd slug doesn't write phantom rows that nothing references.
  const callerAgent = await getAgentRecord(slug)
  if (!callerAgent) {
    return c.json({ error: 'Agent not found' }, 404)
  }
  const body = await c.req.json()
  const parsed = replacePoliciesForCallerInputSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid policies payload', details: parsed.error.format() }, 400)
  }
  // Don't let an agent set a policy targeting itself — meaningless and would create a confusing row
  for (const p of parsed.data.policies) {
    if (p.targetSlug === slug) {
      return c.json({ error: 'Cannot set a policy targeting the same agent' }, 400)
    }
  }
  await replacePoliciesForCaller(slug, parsed.data.policies)
  return c.json({ ok: true })
})

const targetedOperationSchema = z.enum(['invoke', 'read'])

// PUT /api/agents/:id/x-agent-policies/{invoke|read}/:target - Upsert ONE
// targeted policy atomically. The batch PUT above is a whole-form replace: concurrent
// single-edge edits through it read-modify-write the full list and the last
// writer silently drops the other's change. Graph edge edits go through here.
agents.put('/:id/x-agent-policies/:operation/:target', AgentAdmin(), async (c) => {
  const slug = getAgentId(c)
  const operation = targetedOperationSchema.safeParse(c.req.param('operation'))
  if (!operation.success) {
    return c.json({ error: 'Unknown operation' }, 400)
  }
  const targetSlug = c.req.param('target')
  if (targetSlug === slug) {
    return c.json({ error: 'Cannot set a policy targeting the same agent' }, 400)
  }
  // AgentAdmin checks role but not existence; assert both ends so a typo'd
  // slug doesn't write phantom rows that nothing references. In auth mode the
  // target must also be VISIBLE to the caller (same anti-topology-leak rule
  // the GET route enforces) — and an invisible target returns the SAME 404 as
  // a nonexistent one, so this can't be used as an agent-existence oracle.
  const [callerAgent, targetAgent] = await Promise.all([getAgentRecord(slug), getAgentRecord(targetSlug)])
  if (!callerAgent || !targetAgent || !(await callerCanSeeAgent(c, targetSlug))) {
    return c.json({ error: 'Agent not found' }, 404)
  }
  const body = await c.req.json().catch(() => ({}))
  const parsed = z.object({ decision: xAgentDecisionSchema.default('allow') }).safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid policy payload', details: parsed.error.format() }, 400)
  }
  const result = await setPolicy(slug, operation.data, targetSlug, parsed.data.decision)
  return c.json({ ok: true, ...result })
})

// DELETE /api/agents/:id/x-agent-policies/{invoke|read}/:target - Remove the
// grant for one target atomically. Preserves 'block' rows: deleting a drawn
// graph edge revokes a grant, and lifting an explicit block here would
// silently escalate (effective decision falls back to a global allow).
agents.delete('/:id/x-agent-policies/:operation/:target', AgentAdmin(), async (c) => {
  const slug = getAgentId(c)
  const operation = targetedOperationSchema.safeParse(c.req.param('operation'))
  if (!operation.success) {
    return c.json({ error: 'Unknown operation' }, 400)
  }
  const targetSlug = c.req.param('target')
  const removed = await deleteTargetPolicy(slug, operation.data, targetSlug, { preserveBlock: true })
  return c.json({ ok: true, removed })
})

// GET /api/agents/:id/bookmarks - Read bookmarks from agent workspace
agents.get('/:id/bookmarks', AgentRead(), async (c) => {
  return c.json(await readWorkspaceBookmarks(getAgentId(c)))
})

// PUT /api/agents/:id/bookmarks - Write bookmarks to agent workspace
agents.put('/:id/bookmarks', AgentAdmin(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const parsed = WorkspaceBookmarksSchema.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json({ error: 'Invalid bookmarks', issues: parsed.error.issues }, 400)
    }
    // Atomic write: full-replace from client input, but crash-safe so
    // an interrupted write can't truncate bookmarks.json.
    await agentRegistry.get(agentSlug).files.putDoc(BOOKMARKS_FILE, JSON.stringify(parsed.data, null, 2))
    return c.json(parsed.data)
  } catch (error) {
    console.error('Failed to update bookmarks:', error)
    return c.json({ error: 'Failed to update bookmarks' }, 500)
  }
})

// GET /api/agents/:id/hooks - List Claude Code hooks configured in the agent's
// workspace settings file. Agents can self-install hooks (they own the file),
// and a UserPromptSubmit hook can silently block all input — so the host
// surfaces whatever is configured.
agents.get('/:id/hooks', AgentRead(), async (c) => {
  try {
    const agentSlug = getAgentId(c)
    const hooks = await readAgentHooks(agentSlug)
    return c.json({ hooks })
  } catch (error) {
    console.error('Failed to read agent hooks:', error)
    return c.json({ hooks: [] })
  }
})

// DELETE /api/agents/:id/hooks - Remove one configured hook (identified by
// event + command + matcher) from the workspace settings file, preserving
// every other settings key.
agents.delete('/:id/hooks', AgentAdmin(), async (c) => {
  const agentSlug = getAgentId(c)
  const parsed = removeAgentHookSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'Invalid hook removal target' }, 400)
  }
  try {
    const hooks = await removeAgentHook(agentSlug, parsed.data)
    return c.json({ hooks })
  } catch (error) {
    console.error('Failed to remove agent hook:', error)
    // Includes the unparseable-settings case: never rewrite a file we couldn't parse.
    return c.json({ error: 'Failed to update the agent settings file' }, 500)
  }
})

// Dynamic-workflow (`Workflow` tool) per-agent drawer routes, kept in their own
// module for isolation/testability; mounted at the same `/api/agents` root.
agents.route('/', workflowRoutes)

export default agents
