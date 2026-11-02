import { Hono } from 'hono'
import { routePath } from 'hono/route'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { isHostAllowed } from '@shared/lib/proxy/allowed-hosts'
import { matchScopes } from '@shared/lib/proxy/scope-matcher'
import { requestBodyPreview } from '@shared/lib/proxy/review-display'
import { isPreviewableContentType } from '@shared/lib/proxy/body-translation'
import { canonicalizeTargetPath, rawRouteTail } from '@shared/lib/proxy/target-path'
import { resolveApiPolicy } from '@shared/lib/proxy/policy-resolver'
import { agentRegistry } from '@shared/lib/agent-actor'
import { withUserReason } from '@shared/lib/proxy/user-reason'
import { awaitReauth } from '@shared/lib/proxy/reauth-request'
import { getAccountProviderByName } from '@shared/lib/account-providers'
import { getProviderDisplayName } from '@shared/lib/account-providers/service-catalog'
import { attribution, runWithAttribution } from '@shared/lib/platform-attribution'
import { writeProxyAuditEntry, type ProxyAuditEntry } from '@shared/lib/proxy/audit'
import { hasDotSegment } from '@shared/lib/proxy/rules/patterns'
import { buildApiRuleInput } from '@shared/lib/proxy/rules/input'
import {
  auditRuleOutcomes,
  decidingRuleVersionId,
  evaluateRulesForRequest,
  reportedRules,
  reviewRuleOutcomes,
  type GateResult,
} from '@shared/lib/proxy/rules/gate'
import { db } from '@shared/lib/db'
import {
  connectedAccounts,
  agentConnectedAccounts,
} from '@shared/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { awaitReview } from '@shared/lib/proxy/review-request'

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
  // The path is read from the raw request URL and canonicalised once: policy
  // matching, review, audit and the forwarded URL all use this one value.
  const target = canonicalizeTargetPath(rawRouteTail(c.req.url, routePath(c), 'rest'), targetHost)
  const targetPath = target.ok ? target.path : target.rawPath

  const method = c.req.method

  if (!targetHost) {
    return c.json({ error: 'Missing target host in proxy URL' }, 400)
  }

  if (!target.ok) {
    const message = `Invalid target path: ${target.error}`
    await logAuditEntry({
      agentSlug,
      accountId,
      toolkit: '',
      targetHost,
      targetPath,
      method,
      errorMessage: message,
    })
    return c.json({ error: 'invalid_target_path', message }, 400)
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
  const loadMappedAccount = async () => {
    const [result] = await db
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
    return result?.account ?? null
  }

  let account = await loadMappedAccount()
  if (!account) {
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

  type ReauthResult =
    | { ok: true }
    | { ok: false; reason: 'replaced'; replacementAccountId: string }
    // `dismissReason` is what the dismisser typed, forwarded so the agent
    // learns WHY a person cut its call off, not merely that they did.
    | { ok: false; reason: 'timeout' | 'dismissed' | 'missing' | 'inactive'; dismissReason?: string }

  const holdForReauth = async (status: 'expired' | 'revoked'): Promise<ReauthResult> => {
    const wait = await awaitReauth(agentRegistry.get(agentSlug).inputs.accountReauth, {
      accountId,
      toolkit: account!.toolkitSlug,
      accountStatus: status,
    }, c.req.raw.signal)
    if (wait.outcome === 'replaced') return { ok: false, reason: 'replaced', replacementAccountId: wait.replacementId }
    // A person pressing Dismiss is a decision the agent must respect; a
    // five-minute timer, an abort or a lost card are not.
    if (wait.outcome === 'dismissed') return { ok: false, reason: 'dismissed', dismissReason: wait.reason }
    if (wait.outcome !== 'resumed') return { ok: false, reason: 'timeout' }

    const refreshed = await loadMappedAccount()
    if (!refreshed) return { ok: false, reason: 'missing' }
    if (refreshed.status !== 'active') return { ok: false, reason: 'inactive' }
    account = refreshed
    return { ok: true }
  }

  const reauthFailureResponse = async (
    result: Exclude<ReauthResult, { ok: true }>,
    status: 'expired' | 'revoked',
    auditError: (message: string, statusCode: number) => Promise<void>,
  ) => {
    if (result.reason === 'replaced') {
      await auditError('Account replaced for this agent by a user', 409)
      return c.json({
        error: 'account_replaced',
        replacementAccountId: result.replacementAccountId,
        message: `A user replaced this connection for this agent. Retry the request using account ID ${result.replacementAccountId} in the proxy URL instead of ${accountId}. The replacement account's access policies will be checked on the new request.`,
      }, 409)
    }

    if (result.reason === 'timeout') {
      await auditError(`Account re-authentication timed out (${status})`, 408)
      return c.json({
        error: 'account_reauth_timeout',
        message: 'The request timed out while waiting for the account to be reconnected.',
        accountStatus: status,
      }, 408)
    }

    if (result.reason === 'dismissed') {
      const message = withUserReason(
        'A user dismissed the reconnection request, so this call was not made. '
        + 'Do not retry it until the connection is reconnected.',
        result.dismissReason,
      )
      await auditError(`Account re-authentication dismissed by a user (${status})`, 403)
      return c.json({ error: 'account_reauth_dismissed', message, accountStatus: status }, 403)
    }

    const message = result.reason === 'missing'
      ? 'Connected account disappeared while re-authenticating.'
      : 'Connected account did not become active after re-authentication.'
    await auditError(message, result.reason === 'missing' ? 404 : 502)
    return c.json({ error: 'account_reauth_failed', message, accountStatus: status },
      result.reason === 'missing' ? 404 : 502)
  }

  // 3. Validate target host against toolkit allowlist. Only a bare hostname
  // passes, so the URL built in step 4 reaches exactly this host.
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

  // 3.2 Reject dot segments. Hono decodes %2F before the scope matcher sees
  // the path, and the forwarded URL then resolves `..`, so
  // `drafts%2F..%2Fmessages/send` would be matched as one endpoint and sent
  // to another.
  if (hasDotSegment('/' + targetPath)) {
    await logAuditEntry({
      agentSlug,
      accountId,
      toolkit: account.toolkitSlug,
      targetHost,
      targetPath,
      method,
      errorMessage: 'Path contains dot segments',
    })
    return c.json({ error: 'invalid_path', message: 'The request path must not contain "." or ".." segments.' }, 400)
  }

  // The body is read at most once, shared by the matcher, the card, rules and the
  // forwarder: text bodies before matching, others only when a rule or the forward needs them.
  let bodyRead: Promise<ArrayBuffer | null> | null = null
  const readBody = () => bodyRead ??= (method === 'GET' || method === 'HEAD')
    ? Promise.resolve(null)
    : c.req.arrayBuffer()
  const textBody = isPreviewableContentType(c.req.header('content-type')) ? await readBody() : null

  // 3.5 Policy enforcement
  const resolvePolicy = async () => {
    try {
      const matchResult = matchScopes(account.toolkitSlug, method, '/' + targetPath, targetHost, textBody)
      const userId = account.userId ?? 'local'
      return await resolveApiPolicy(accountId, matchResult, userId, account.toolkitSlug)
    } catch (policyError) {
      console.error('[proxy] Policy enforcement failed, defaulting to review:', policyError)
      return { decision: 'review' as const, matchedScopes: [] as string[], scopeDescriptions: {} as Record<string, string>, resolvedFrom: 'global_default' as const }
    }
  }
  const policyResult = await resolvePolicy()

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
      settingsHint: `You can change this on the agent's Connections page: open ${getProviderDisplayName(account.toolkitSlug)} and edit its Permissions.`,
    }, 403)
  }

  // Track the precise outcome for audit logging
  let resolvedPolicyDecision: string = policyResult.decision // 'allow' or 'review'

  // 3.6 Proxy rules: a require rule can send an allowed request to review; an
  // allow rule can move a reviewed request to allow.
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url is always a valid URL
  const search = new URL(c.req.url).search
  const runRules = (policy: 'allow' | 'review'): Promise<GateResult> => evaluateRulesForRequest(
    { kind: 'api', targetId: accountId },
    agentSlug,
    policy,
    { kind: 'api', method, path: '/' + targetPath },
    async () => buildApiRuleInput({
      method,
      host: targetHost,
      path: '/' + targetPath,
      search,
      headers: c.req.raw.headers,
      body: await readBody(),
    }),
  )
  const ruleGate = await runRules(policyResult.decision)
  const ruleAudit = {
    ruleVersionId: decidingRuleVersionId(ruleGate),
    ruleOutcomes: auditRuleOutcomes(ruleGate.evaluations),
  }
  if (ruleGate.unavailable && policyResult.decision === 'allow') {
    // No one can tell whether a require rule would hold this request. Answer
    // now so the agent can retry, rather than parking an allowed request on
    // a review card for minutes.
    await logAuditEntry({
      agentSlug,
      accountId,
      toolkit: account.toolkitSlug,
      targetHost,
      targetPath,
      method,
      policyDecision: 'rules_unavailable',
      matchedScopes: JSON.stringify(policyResult.matchedScopes),
      errorMessage: 'Proxy rules could not be checked',
    })
    return c.json({ error: 'rules_unavailable', message: 'Proxy rules could not be checked. Try again shortly.' }, 503)
  }
  if (ruleGate.allowedBy) resolvedPolicyDecision = 'allowed_by_rule'
  else if (ruleGate.decision === 'review') resolvedPolicyDecision = 'review'

  if (resolvedPolicyDecision === 'review') {
    const ruleOutcomes = reviewRuleOutcomes(ruleGate.evaluations)
    const rules = reportedRules(ruleGate)
    try {
      const reviews = agentRegistry.get(agentSlug).inputs.reviews
      const review = await awaitReview(reviews, (raise) => reviews.request({
        accountId,
        reviewType: 'api',
        toolkit: account.toolkitSlug,
        method,
        targetPath,
        matchedScopes: policyResult.matchedScopes,
        scopeDescriptions: policyResult.scopeDescriptions,
        endpointDescription: policyResult.endpointDescription,
        endpointAmbiguous: policyResult.endpointAmbiguous,
        requestBody: requestBodyPreview(textBody),
        ...(ruleOutcomes.length > 0 ? { ruleOutcomes } : {}),
      }, raise), {
        signal: c.req.raw.signal,
        // When an "always" decision on another card changes the policy, this
        // request is decided again rather than released.
        reevaluate: async () => {
          const policy = await resolvePolicy()
          if (policy.decision === 'block') return 'deny'
          const gate = await runRules(policy.decision)
          return gate.unavailable ? 'review' : gate.decision
        },
      })
      if (review.decision === 'deny') {
        await logAuditEntry({
          agentSlug,
          accountId,
          toolkit: account.toolkitSlug,
          targetHost,
          targetPath,
          method,
          policyDecision: 'denied_by_user',
          matchedScopes: JSON.stringify(policyResult.matchedScopes),
          ...ruleAudit,
        })
        return c.json({ error: 'denied_by_user', message: withUserReason('Request denied by user.', review.reason), rules }, 403)
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
        ...ruleAudit,
      })
      return c.json({ error: 'review_timeout', message: 'Request required user approval but timed out.', rules }, 408)
    }
  }

  // resolvedPolicyDecision is now 'allow' (auto), 'allowed_by_rule' or
  // 'approved_by_user' (manual)

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
      ...ruleAudit,
      ...extras,
    })

  // Park only after the request has passed both the host allowlist and API
  // policy gate. Re-authentication cannot turn a forbidden request into an
  // allowed one, so prompting before these checks only interrupts the user
  // for work that will be rejected immediately afterward.
  if (account.status !== 'active') {
    const status = account.status
    const result = await holdForReauth(status)
    if (!result.ok) {
      return reauthFailureResponse(result, status, (errorMessage, statusCode) =>
        audit({ statusCode, errorMessage }))
    }
  }

  // 4. Build target URL
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url is always a valid URL
  const queryString = new URL(c.req.url).search
  const targetUrl = `https://${targetHost}/${target.encodedPath}${queryString}`

  // 5. Verify remote connection status before forwarding
  let provider = getAccountProviderByName(account.providerName)

  let remoteConnection: Awaited<ReturnType<typeof provider.getConnection>> | null = null
  try {
    remoteConnection = await provider.getConnection(
      account.providerConnectionId,
      account.toolkitSlug,
    )
  } catch (statusCheckErr) {
    console.warn('[proxy] Remote status check failed, proceeding with request:', statusCheckErr)
  }

  if (remoteConnection && remoteConnection.status !== 'ACTIVE') {
    const newStatus = remoteConnection.status === 'EXPIRED' ? 'expired' as const : 'revoked' as const
    try {
      await db.update(connectedAccounts)
        .set({ status: newStatus, updatedAt: new Date() })
        .where(eq(connectedAccounts.id, accountId))
    } catch (statusUpdateErr) {
      console.warn('[proxy] Failed to persist non-active account status:', statusUpdateErr)
    }

    const reauthResult = await holdForReauth(newStatus)
    if (!reauthResult.ok) {
      return reauthFailureResponse(reauthResult, newStatus, (errorMessage, statusCode) =>
        audit({ statusCode, errorMessage }))
    }
    provider = getAccountProviderByName(account.providerName)
  }

  // 6. Forward via account provider (handles token retrieval/proxy internally)
  const requestBody = await readBody()

  const forwardRequest = async () => runWithAttribution(
      await attribution.fromResourceCreator(account.userId),
      () => provider.makeApiCall({
        providerConnectionId: account.providerConnectionId,
        toolkitSlug: account.toolkitSlug,
        targetUrl,
        method,
        headers: c.req.raw.headers,
        body: requestBody,
      }),
    )

  let response: Response
  try {
    response = await forwardRequest()
  } catch (error) {
    const isTokenError = String(error).includes('token') || String(error).includes('Token')
    const errorLabel = isTokenError ? 'Failed to fetch access token' : 'Proxy request failed'

    if (isTokenError) {
      try {
        await db.update(connectedAccounts)
          .set({ status: 'expired', updatedAt: new Date() })
          .where(eq(connectedAccounts.id, accountId))
      } catch (statusUpdateErr) {
        console.warn('[proxy] Failed to persist expired account status:', statusUpdateErr)
      }

      const reauthResult = await holdForReauth('expired')
      if (!reauthResult.ok) {
        return reauthFailureResponse(reauthResult, 'expired', (errorMessage, statusCode) =>
          audit({ statusCode, errorMessage }))
      }
      provider = getAccountProviderByName(account.providerName)
      try {
        response = await forwardRequest()
      } catch (retryError) {
        await audit({ errorMessage: `${errorLabel} after re-authentication: ${retryError}` })
        return c.json(
          { error: errorLabel, details: String(retryError), accountStatus: 'expired' },
          502,
        )
      }
    } else {
      await audit({ errorMessage: `${errorLabel}: ${error}` })
      return c.json(
        { error: errorLabel, details: String(error) },
        502
      )
    }
  }

  await audit({
    statusCode: response.status,
    ...(response.status >= 400 ? { errorMessage: `Upstream returned ${response.status}` } : {}),
  })
  return response
})

export default proxy
