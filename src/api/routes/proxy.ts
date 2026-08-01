import { Hono } from 'hono'
import crypto from 'crypto'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { isHostAllowed } from '@shared/lib/proxy/allowed-hosts'
import { matchScopes } from '@shared/lib/proxy/scope-matcher'
import { resolveApiPolicy } from '@shared/lib/proxy/policy-resolver'
import { PROXY_SKIP_REQUEST_HEADERS } from '@shared/lib/proxy/composio-envelope'
import { reviewManager } from '@shared/lib/proxy/review-manager'
import {
  AutopilotAuthorizationError,
  getAutopilotAuthorization,
  isAutopilotAuthorizationCurrent,
  type AutopilotAuthorization,
} from '@shared/lib/autopilot/autopilot-status'
import type { ApprovalReviewVerdict } from '@shared/lib/autopilot/autopilot-schema'
import { reviewAutopilotApproval } from '@shared/lib/autopilot/autopilot-approval-reviewer'
import { autopilotApprovalDeniedMessage } from '@shared/lib/autopilot/autopilot-service'
import { getAccountProviderByName } from '@shared/lib/account-providers'
import { attribution, runWithAttribution } from '@shared/lib/platform-attribution'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { db } from '@shared/lib/db'
import {
  connectedAccounts,
  agentConnectedAccounts,
  proxyAuditLog,
} from '@shared/lib/db/schema'
import { eq, and } from 'drizzle-orm'

/**
 * The most text (request body, and separately the forwarded-header block) the
 * autopilot approval judge will inspect. The judge must see each COMPLETELY or
 * not at all — a partial view can hide a recipient or destructive flag past
 * the cutoff — so anything larger is unreviewable and fails closed.
 */
export const REVIEWABLE_BODY_CHAR_CAP = 16_000

interface ProxyAuditEntry {
  agentSlug: string
  accountId: string
  toolkit: string
  targetHost: string
  targetPath: string
  method: string
  statusCode?: number
  errorMessage?: string
  policyDecision?: string
  matchedScopes?: string
  decisionReason?: string
}

async function writeProxyAuditEntry(entry: ProxyAuditEntry & { durationMs?: number }): Promise<void> {
  try {
    await db.insert(proxyAuditLog).values({
      id: crypto.randomUUID(),
      ...entry,
      statusCode: entry.statusCode ?? null,
      errorMessage: entry.errorMessage ?? null,
      durationMs: entry.durationMs ?? null,
      policyDecision: entry.policyDecision ?? null,
      matchedScopes: entry.matchedScopes ?? null,
      createdAt: new Date(),
    })
    trackServerEvent('api_called', { slug: entry.toolkit })
  } catch (error) {
    console.error('[proxy] Failed to write audit log:', error)
  }
}

const proxy = new Hono()

proxy.all('/:agentSlug/:accountId/:rest{.+}', async (c) => {
  const startTime = Date.now()
  const agentSlug = c.req.param('agentSlug')
  const accountId = c.req.param('accountId')
  const rest = c.req.param('rest') || ''

  // Stamp elapsed time (request entry → now) onto every audit entry. Every exit
  // path logs through this, so the API Logs Duration column is always populated.
  const logAuditEntry = (entry: ProxyAuditEntry) =>
    writeProxyAuditEntry({ ...entry, durationMs: Date.now() - startTime })

  // Parse target host and path from rest: <host>/<path...>
  const firstSlash = rest.indexOf('/')
  const targetHost = firstSlash === -1 ? rest : rest.slice(0, firstSlash)
  const targetPath = firstSlash === -1 ? '' : rest.slice(firstSlash + 1)

  const method = c.req.method

  if (!targetHost) {
    return c.json({ error: 'Missing target host in proxy URL' }, 400)
  }

  // 1. Validate synthetic token
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    await logAuditEntry({
      agentSlug,
      accountId,
      toolkit: '',
      targetHost,
      targetPath,
      method: c.req.method,
      errorMessage: 'Missing or invalid Authorization header',
    })
    return c.json({ error: 'Missing or invalid Authorization header' }, 401)
  }

  const synthToken = authHeader.slice(7)
  const validatedAgent = await validateProxyToken(synthToken)
  if (!validatedAgent) {
    await logAuditEntry({
      agentSlug,
      accountId,
      toolkit: '',
      targetHost,
      targetPath,
      method: c.req.method,
      errorMessage: 'Invalid proxy token',
    })
    return c.json({ error: 'Invalid proxy token' }, 401)
  }

  if (validatedAgent !== agentSlug) {
    await logAuditEntry({
      agentSlug,
      accountId,
      toolkit: '',
      targetHost,
      targetPath,
      method: c.req.method,
      errorMessage: 'Token does not match agent',
    })
    return c.json({ error: 'Token does not match agent' }, 403)
  }

  // 2. Look up connected account and verify it belongs to this agent
  const results = await db
    .select({ account: connectedAccounts })
    .from(agentConnectedAccounts)
    .innerJoin(
      connectedAccounts,
      eq(agentConnectedAccounts.connectedAccountId, connectedAccounts.id)
    )
    .where(
      and(
        eq(agentConnectedAccounts.agentSlug, agentSlug),
        eq(connectedAccounts.id, accountId)
      )
    )
    .limit(1)

  if (results.length === 0) {
    await logAuditEntry({
      agentSlug,
      accountId,
      toolkit: '',
      targetHost,
      targetPath,
      method: c.req.method,
      errorMessage: 'Account not found or not mapped to agent',
    })
    return c.json({ error: 'Account not found or not mapped to this agent' }, 404)
  }

  const account = results[0].account

  // 2b. Reject requests for accounts with non-active local status
  if (account.status !== 'active') {
    await logAuditEntry({
      agentSlug,
      accountId,
      toolkit: account.toolkitSlug,
      targetHost,
      targetPath,
      method: c.req.method,
      errorMessage: `Account status is ${account.status}`,
    })
    return c.json({
      error: `Connected account is ${account.status}. Re-authenticate to restore access.`,
      accountStatus: account.status,
    }, 403)
  }

  // 3. Validate target host against toolkit allowlist
  if (!isHostAllowed(account.toolkitSlug, targetHost)) {
    await logAuditEntry({
      agentSlug,
      accountId,
      toolkit: account.toolkitSlug,
      targetHost,
      targetPath,
      method: c.req.method,
      errorMessage: `Host '${targetHost}' not allowed for toolkit '${account.toolkitSlug}'`,
    })
    return c.json(
      {
        error: `Host '${targetHost}' is not allowed for toolkit '${account.toolkitSlug}'`,
      },
      403
    )
  }

  // 3.5 Policy enforcement
  let policyResult
  try {
    const matchResult = matchScopes(account.toolkitSlug, method, '/' + targetPath)
    const userId = account.userId ?? 'local'
    policyResult = await resolveApiPolicy(accountId, matchResult, userId, account.toolkitSlug)
  } catch (policyError) {
    console.error('[proxy] Policy enforcement failed, defaulting to review:', policyError)
    policyResult = { decision: 'review' as const, matchedScopes: [] as string[], scopeDescriptions: {} as Record<string, string>, resolvedFrom: 'global_default' as const }
  }

  if (policyResult.decision === 'block') {
    await logAuditEntry({
      agentSlug,
      accountId,
      toolkit: account.toolkitSlug,
      targetHost,
      targetPath,
      method,
      policyDecision: 'block',
      matchedScopes: JSON.stringify(policyResult.matchedScopes),
    })
    return c.json({
      error: 'blocked_by_policy',
      message: 'This request was blocked by your API access policy.',
      scopes: policyResult.matchedScopes,
      toolkit: account.toolkitSlug,
      settingsHint: 'You can adjust policies in Settings > Accounts > Policies',
    }, 403)
  }

  // Track the precise outcome for audit logging
  let resolvedPolicyDecision: string = policyResult.decision // 'allow' or 'review'

  // Reason recorded alongside autopilot reviewer decisions; rides the final
  // audit entry for approvals.
  let autopilotDecisionReason: string | undefined

  // Set when the autopilot reviewer approved this request. The approval is
  // provisional: it is revalidated at the outbound boundary (immediately
  // before the provider issues the request, via beforeForward) and the
  // timeline card records the FINAL outcome — the approval that executed, or
  // the deny substituted at the boundary.
  let autopilotBoundary:
    | {
        authorization: AutopilotAuthorization
        recordFinalDecision: (finalVerdict: ApprovalReviewVerdict) => Promise<void>
      }
    | undefined

  if (policyResult.decision === 'review') {
    // Autopilot: a review card would park on a user who delegated the task and
    // left. Instead, an automated reviewer decides on the user's behalf — it
    // sees ONLY the user's own messages plus this request (never the agent
    // trajectory, so injected instructions can't reach it). Block policy never
    // gets here; a deny keeps the pre-reviewer corrective guidance.
    const autopilotAuthorization = await getAutopilotAuthorization(agentSlug)
    if (autopilotAuthorization) {
      const scopeDetails = Object.entries(policyResult.scopeDescriptions ?? {})
        .map(([scope, description]) => `${scope}: ${description}`)
        .join('\n')
      // The judge must see the request EXACTLY as it will be forwarded: the
      // full URL including the query string, the complete forwarded header set
      // (headers can carry action-defining parameters — a destination path or
      // an overwrite flag — and every non-hop-by-hop header is forwarded at
      // step 6), and the complete body. A recipient, destination, or
      // destructive flag in an omitted part would otherwise ride an approval
      // granted for a different-looking request; anything too large to inspect
      // in full fails closed. The skip-set is the same one both account
      // providers apply when forwarding, and it strips Authorization — the
      // judge never sees credentials. Hono caches the arrayBuffer, so the
      // forward at step 6 reuses this same read.
      // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url is always a valid URL
      const queryString = new URL(c.req.url).search
      let unreviewable: string | undefined
      const headerLines: string[] = []
      c.req.raw.headers.forEach((value, key) => {
        if (!PROXY_SKIP_REQUEST_HEADERS.has(key.toLowerCase())) {
          headerLines.push(`${key}: ${value}`)
        }
      })
      const headersBlock = headerLines.join('\n')
      let headersText: string | undefined
      if (headersBlock.length > REVIEWABLE_BODY_CHAR_CAP) {
        unreviewable = `Forwarded request headers total ${headersBlock.length} characters — beyond the ${REVIEWABLE_BODY_CHAR_CAP}-character automated-review limit, so the request cannot be inspected in full. Denied by default.`
      } else if (headersBlock) {
        headersText = `Request headers (complete, as forwarded):\n${headersBlock}`
      }
      let bodyText: string | undefined
      if (!unreviewable && method !== 'GET' && method !== 'HEAD') {
        let buffer: ArrayBuffer | undefined
        try {
          buffer = await c.req.arrayBuffer()
        } catch {
          unreviewable = 'Request body could not be read for review. Denied by default.'
        }
        if (buffer && buffer.byteLength > 0) {
          // Fatal decode, no trimming: the forward at step 6 sends the raw
          // bytes, so the judge must see exactly those bytes as text. A
          // lenient decode would substitute replacement characters and a trim
          // would drop bytes — either way the judge approves a different
          // representation than what executes. Non-UTF-8 bodies cannot be
          // represented completely and fail closed.
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
            if (text.length > REVIEWABLE_BODY_CHAR_CAP) {
              unreviewable = `Request body is ${text.length} characters — beyond the ${REVIEWABLE_BODY_CHAR_CAP}-character automated-review limit, so it cannot be inspected in full. Denied by default.`
            } else {
              bodyText = `Request body (complete): ${text}`
            }
          } catch {
            unreviewable =
              'Request body is not valid UTF-8 text, so it cannot be inspected as it will be forwarded. Denied by default.'
          }
        }
      }
      const review = unreviewable
        ? { decision: 'deny' as const, reason: unreviewable }
        : await reviewAutopilotApproval({
            agentSlug,
            action: `API request: ${method} https://${targetHost}/${targetPath}${queryString}`,
            details: [
              policyResult.endpointDescription,
              scopeDetails,
              headersText,
              bodyText,
            ].filter(Boolean).join('\n') || undefined,
          })
      if (review.decision === 'deny') {
        await logAuditEntry({
          agentSlug,
          accountId,
          toolkit: account.toolkitSlug,
          targetHost,
          targetPath,
          method,
          policyDecision: 'denied_autopilot',
          matchedScopes: JSON.stringify(policyResult.matchedScopes),
          decisionReason: review.reason,
        })
        return c.json(
          {
            error: 'requires_user_approval',
            message: `${autopilotApprovalDeniedMessage('This API request')} Reviewer: ${review.reason}`,
            scopes: policyResult.matchedScopes,
            toolkit: account.toolkitSlug,
          },
          403
        )
      }
      resolvedPolicyDecision = 'approved_autopilot'
      autopilotDecisionReason = review.reason
      autopilotBoundary = {
        authorization: autopilotAuthorization,
        recordFinalDecision: review.recordFinalDecision,
      }
    } else {
      try {
        const decision = await reviewManager.requestReview({
          agentSlug,
          accountId,
          toolkit: account.toolkitSlug,
          method,
          targetPath,
          matchedScopes: policyResult.matchedScopes,
          scopeDescriptions: policyResult.scopeDescriptions,
          endpointDescription: policyResult.endpointDescription,
        }, c.req.raw.signal)
        if (decision === 'deny') {
          await logAuditEntry({
            agentSlug,
            accountId,
            toolkit: account.toolkitSlug,
            targetHost,
            targetPath,
            method,
            policyDecision: 'denied_by_user',
            matchedScopes: JSON.stringify(policyResult.matchedScopes),
          })
          return c.json({ error: 'denied_by_user', message: 'Request denied by user.' }, 403)
        }
        resolvedPolicyDecision = 'approved_by_user'
      } catch {
        await logAuditEntry({
          agentSlug,
          accountId,
          toolkit: account.toolkitSlug,
          targetHost,
          targetPath,
          method,
          policyDecision: 'review_timeout',
          matchedScopes: JSON.stringify(policyResult.matchedScopes),
        })
        return c.json({ error: 'review_timeout', message: 'Request required user approval but timed out.' }, 408)
      }
    }
  }

  // resolvedPolicyDecision is now 'allow' (auto), 'approved_by_user' (manual),
  // or 'approved_autopilot' (reviewed on the user's behalf while engaged)

  // Audit helper: curried with all the context fields shared by every
  // post-policy audit entry. Caller supplies only what varies (statusCode,
  // errorMessage). Keeps the forward branches focused on the actual logic.
  const audit = (extras: {
    statusCode?: number
    errorMessage?: string
  }) =>
    logAuditEntry({
      agentSlug,
      accountId,
      toolkit: account.toolkitSlug,
      targetHost,
      targetPath,
      method,
      policyDecision: resolvedPolicyDecision,
      matchedScopes: JSON.stringify(policyResult.matchedScopes),
      decisionReason: autopilotDecisionReason,
      ...extras,
    })

  // 4. Build target URL
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url is always a valid URL
  const queryString = new URL(c.req.url).search
  const targetUrl = `https://${targetHost}/${targetPath}${queryString}`

  // 5. Verify remote connection status before forwarding
  const provider = getAccountProviderByName(account.providerName)

  try {
    const remoteConnection = await provider.getConnection(
      account.providerConnectionId,
      account.toolkitSlug,
    )
    if (remoteConnection.status !== 'ACTIVE') {
      const newStatus = remoteConnection.status === 'EXPIRED' ? 'expired' as const : 'revoked' as const
      db.update(connectedAccounts)
        .set({ status: newStatus, updatedAt: new Date() })
        .where(eq(connectedAccounts.id, accountId))
        .catch((err) => console.error('[proxy] Failed to update account status:', err))
      await audit({ errorMessage: `Remote connection status: ${remoteConnection.status}` })
      return c.json({
        error: `Connected account is ${newStatus}. Re-authenticate to restore access.`,
        accountStatus: newStatus,
      }, 403)
    }
  } catch (statusCheckErr) {
    console.warn('[proxy] Remote status check failed, proceeding with request:', statusCheckErr)
  }

  // 6. Forward via account provider (handles token retrieval/proxy internally)
  const requestBody = (method === 'GET' || method === 'HEAD')
    ? null
    : await c.req.arrayBuffer()

  // An autopilot approval is revalidated at the outbound boundary: the awaits
  // between the verdict and the forward (connection check, body read,
  // provider-internal token retrieval) leave time for the user to revoke, and
  // an approval must not execute under an authorization that no longer
  // stands. The provider awaits this guard immediately before issuing its
  // outbound request; once it passes, the forward is committed and the
  // executed approval is recorded as the final timeline decision.
  const boundary = autopilotBoundary
  const beforeForward = boundary
    ? async () => {
        if (c.req.raw.signal.aborted) {
          throw new AutopilotAuthorizationError(
            'The request was cancelled before it was forwarded.'
          )
        }
        if (!(await isAutopilotAuthorizationCurrent(agentSlug, boundary.authorization))) {
          throw new AutopilotAuthorizationError(
            'Autopilot was switched off or interrupted before the request was forwarded, so the approval no longer applies.'
          )
        }
        void boundary.recordFinalDecision({
          decision: 'approve',
          reason: autopilotDecisionReason ?? 'Approved by the autopilot reviewer.',
        })
      }
    : undefined

  let response: Response
  try {
    response = await runWithAttribution(
      attribution.fromResourceCreator(account.userId),
      () => provider.makeApiCall({
        providerConnectionId: account.providerConnectionId,
        toolkitSlug: account.toolkitSlug,
        targetUrl,
        method,
        headers: c.req.raw.headers,
        body: requestBody,
        beforeForward,
      }),
    )
  } catch (error) {
    if (error instanceof AutopilotAuthorizationError) {
      void boundary?.recordFinalDecision({ decision: 'deny', reason: error.message })
      resolvedPolicyDecision = 'denied_autopilot'
      autopilotDecisionReason = error.message
      await audit({})
      return c.json(
        {
          error: 'requires_user_approval',
          message: `${autopilotApprovalDeniedMessage('This API request')} ${error.message}`,
          scopes: policyResult.matchedScopes,
          toolkit: account.toolkitSlug,
        },
        403
      )
    }
    const isTokenError = String(error).includes('token') || String(error).includes('Token')
    const errorLabel = isTokenError ? 'Failed to fetch access token' : 'Proxy request failed'

    if (isTokenError) {
      db.update(connectedAccounts)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(connectedAccounts.id, accountId))
        .catch((err) => console.error('[proxy] Failed to update account status:', err))
    }

    await audit({ errorMessage: `${errorLabel}: ${error}` })
    return c.json(
      { error: errorLabel, details: String(error), ...(isTokenError ? { accountStatus: 'expired' } : {}) },
      502
    )
  }

  audit({
    statusCode: response.status,
    ...(response.status >= 400 ? { errorMessage: `Upstream returned ${response.status}` } : {}),
  })
  return response
})

export default proxy
