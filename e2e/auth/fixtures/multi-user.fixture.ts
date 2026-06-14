import {
  request as playwrightRequest,
  test as base,
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Page,
} from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'

const BASE_URL = 'http://localhost:3001'
const DEFAULT_PASSWORD = 'password123'
const AUTH_DATA_DIR = process.env.SUPERAGENT_DATA_DIR
  ? path.resolve(process.env.SUPERAGENT_DATA_DIR)
  : path.resolve(process.cwd(), '.e2e-data-auth')

type AuthUserRole = 'admin' | 'user'
type AgentRole = 'owner' | 'user' | 'viewer'

export interface AuthTestUser {
  id: string
  name: string
  email: string
  password: string
  role: AuthUserRole
}

interface CreateUserOptions {
  name?: string
  email?: string
  password?: string
  role?: AuthUserRole
  banned?: boolean
  banReason?: string | null
}

interface UserDetailsOptions {
  name?: string
  email?: string
  emailPrefix?: string
  emailDomain?: string
  password?: string
}

interface CreateAgentOptions {
  name?: string
  description?: string
}

interface CreateConnectedAccountOptions {
  providerConnectionId?: string
  providerName?: string
  toolkitSlug?: string
  displayName?: string
  status?: 'active' | 'revoked' | 'expired'
}

interface CreateRemoteMcpOptions {
  name?: string
  url?: string
  authType?: 'none' | 'oauth' | 'bearer'
  accessToken?: string
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>
  status?: 'active' | 'error' | 'auth_required'
  errorMessage?: string | null
}

interface AuthSettingsOverrides {
  signupMode?: 'open' | 'domain_restricted' | 'invitation_only' | 'closed'
  allowedSignupDomains?: string[]
  requireAdminApproval?: boolean
  defaultUserRole?: 'member' | 'admin'
  allowLocalAuth?: boolean
  allowSocialAuth?: boolean
  passwordMinLength?: number
  passwordMaxLength?: number
  passwordRequireComplexity?: boolean
  sessionMaxLifetimeHrs?: number
  sessionIdleTimeoutMin?: number
  maxConcurrentSessions?: number
  accountLockoutThreshold?: number
  accountLockoutDurationMin?: number
}

export interface AuthFactories {
  uniqueUserDetails(options?: UserDetailsOptions): Omit<AuthTestUser, 'id' | 'role'>
  resetAuthData(): Promise<void>
  createUser(options?: CreateUserOptions): Promise<AuthTestUser>
  createAdmin(options?: Omit<CreateUserOptions, 'role'>): Promise<AuthTestUser>
  apiForUser(user: Pick<AuthTestUser, 'email' | 'password'>): Promise<APIRequestContext>
  pageForUser(user: Pick<AuthTestUser, 'email' | 'password'>): Promise<Page>
  anonymousPage(): Promise<Page>
  resetSettings(admin: Pick<AuthTestUser, 'email' | 'password'>, auth?: AuthSettingsOverrides): Promise<void>
  setAuthSettings(admin: Pick<AuthTestUser, 'email' | 'password'>, auth: AuthSettingsOverrides): Promise<void>
  createAgent(owner: Pick<AuthTestUser, 'email' | 'password'>, options?: CreateAgentOptions): Promise<{ name: string; slug: string }>
  inviteUser(owner: Pick<AuthTestUser, 'email' | 'password'>, agentSlug: string, target: Pick<AuthTestUser, 'id'>, role?: AgentRole): Promise<void>
  createConnectedAccount(owner: Pick<AuthTestUser, 'email' | 'password'>, options?: CreateConnectedAccountOptions): Promise<{ id: string }>
  createRemoteMcp(owner: Pick<AuthTestUser, 'id'>, options?: CreateRemoteMcpOptions): Promise<{ id: string }>
  connectRemoteMcpToAgent(owner: Pick<AuthTestUser, 'email' | 'password'>, agentSlug: string, mcpId: string): Promise<void>
}

const DEFAULT_AUTH_SETTINGS: Required<Pick<
  AuthSettingsOverrides,
  'signupMode' | 'allowedSignupDomains' | 'requireAdminApproval' | 'allowLocalAuth' | 'allowSocialAuth' | 'passwordMinLength' | 'passwordRequireComplexity'
>> = {
  signupMode: 'open',
  allowedSignupDomains: [],
  requireAdminApproval: false,
  allowLocalAuth: true,
  allowSocialAuth: false,
  passwordMinLength: 8,
  passwordRequireComplexity: false,
}

const AUTH_RESET_TABLES = [
  'message_author',
  'session',
  'account',
  'verification',
  'agent_connected_accounts',
  'agent_remote_mcps',
  'api_scope_policies',
  'mcp_tool_policies',
  'webhook_triggers',
  'chat_integration_sessions',
  'chat_integrations',
  'scheduled_tasks',
  'notifications',
  'proxy_audit_log',
  'proxy_tokens',
  'mcp_audit_log',
  'audit_log',
  'agent_acl',
  'connected_accounts',
  'remote_mcp_servers',
  'user_settings',
  'user',
]

interface StoredAuthUser {
  id: string
  name: string
  email: string
  role: string | null
}

function quoteIdentifier(name: string) {
  return `"${name.replaceAll('"', '""')}"`
}

function openAuthDb() {
  return new Database(path.join(AUTH_DATA_DIR, 'superagent.db'))
}

function withAuthDb<T>(action: (db: ReturnType<typeof openAuthDb>) => T): T {
  const db = openAuthDb()
  try {
    return action(db)
  } finally {
    db.close()
  }
}

function getStoredUser(email: string): StoredAuthUser | undefined {
  return withAuthDb((db) =>
    db
      .prepare('SELECT id, name, email, role FROM "user" WHERE email = ?')
      .get(email.toLowerCase()) as StoredAuthUser | undefined
  )
}

function patchStoredUser(
  id: string,
  fields: { role?: AuthUserRole; banned?: boolean; banReason?: string | null }
) {
  withAuthDb((db) => {
    const current = db
      .prepare('SELECT role, banned, ban_reason FROM "user" WHERE id = ?')
      .get(id) as { role: string | null; banned: number | null; ban_reason: string | null } | undefined
    const banned = fields.banned ?? Boolean(current?.banned)

    db.prepare(`
      UPDATE "user"
      SET role = ?, banned = ?, ban_reason = ?, must_change_password = 0, updated_at = ?
      WHERE id = ?
    `).run(
      fields.role ?? (current?.role === 'admin' ? 'admin' : 'user'),
      banned ? 1 : 0,
      fields.banReason ?? current?.ban_reason ?? null,
      Date.now(),
      id
    )
  })
}

function seedCompletedUserSettings(userId: string) {
  withAuthDb((db) => {
    db.prepare(`
      INSERT INTO user_settings (user_id, settings, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at
    `).run(
      userId,
      JSON.stringify({ setupCompleted: true, onboardingProgress: null }),
      Date.now()
    )
  })
}

async function expectOk(response: APIResponse, action: string) {
  if (response.ok()) return
  let body = ''
  try {
    body = await response.text()
  } catch {
    // Ignore body parsing failures; the status is enough to fail clearly.
  }
  throw new Error(`${action} failed with ${response.status()} ${response.statusText()}: ${body}`)
}

/**
 * Multi-user fixture for auth E2E tests.
 * Uses worker-scoped fixtures so browser contexts persist across serial tests.
 * Each user gets an isolated cookie jar sharing the same server.
 */
export const test = base.extend<
  // Test-scoped fixtures (none)
  object,
  // Worker-scoped fixtures (persist across tests)
  {
    authFactories: AuthFactories
    user1Context: BrowserContext
    user1Page: Page
    user2Context: BrowserContext
    user2Page: Page
    user3Context: BrowserContext
    user3Page: Page
  }
>({
  authFactories: [async ({ browser }, use, workerInfo) => {
    let userCounter = 0
    const contexts: BrowserContext[] = []
    const apiContexts: APIRequestContext[] = []
    const workerSeed = `w${workerInfo.workerIndex}-${Date.now().toString(36)}`

    const uniqueUserDetails: AuthFactories['uniqueUserDetails'] = (options = {}) => {
      userCounter += 1
      const emailPrefix = options.emailPrefix ?? 'user'
      const emailDomain = options.emailDomain ?? 'test.com'
      const email = options.email ?? `${emailPrefix}-${workerSeed}-${userCounter}@${emailDomain}`
      return {
        name: options.name ?? `E2E ${emailPrefix} ${userCounter}`,
        email: email.toLowerCase(),
        password: options.password ?? DEFAULT_PASSWORD,
      }
    }

    const resetAuthData = async () => {
      withAuthDb((db) => {
        db.pragma('foreign_keys = OFF')
        for (const table of AUTH_RESET_TABLES) {
          db.prepare(`DELETE FROM ${quoteIdentifier(table)}`).run()
        }
        db.pragma('foreign_keys = ON')
        db.pragma('wal_checkpoint(TRUNCATE)')
      })
      await fs.promises.rm(path.join(AUTH_DATA_DIR, 'agents'), { recursive: true, force: true })
    }

    const createUser: AuthFactories['createUser'] = async (options = {}) => {
      const details = {
        ...uniqueUserDetails({
          name: options.name,
          emailPrefix: options.role === 'admin' ? 'admin' : 'user',
          password: options.password,
        }),
        ...options,
      }
      const email = details.email.toLowerCase()
      const role = details.role ?? 'user'
      const existing = getStoredUser(email)

      if (existing) {
        patchStoredUser(existing.id, {
          role,
          banned: details.banned,
          banReason: details.banReason,
        })
        seedCompletedUserSettings(existing.id)
        return {
          id: existing.id,
          name: existing.name,
          email: existing.email,
          password: details.password ?? DEFAULT_PASSWORD,
          role,
        }
      }

      const password = details.password ?? DEFAULT_PASSWORD
      const api = await playwrightRequest.newContext({ baseURL: BASE_URL })
      apiContexts.push(api)
      const signup = await api.post('/api/auth/sign-up/email', {
        data: {
          name: details.name,
          email,
          password,
        },
      })
      await expectOk(signup, `create user ${email}`)

      const session = await api.get('/api/auth/get-session')
      await expectOk(session, `read session for ${email}`)
      const sessionBody = await session.json()
      const sessionUser = sessionBody.user ?? sessionBody.data?.user
      if (!sessionUser?.id) {
        throw new Error(`create user ${email} did not return a session user id`)
      }

      patchStoredUser(sessionUser.id, {
        role,
        banned: details.banned,
        banReason: details.banReason,
      })
      seedCompletedUserSettings(sessionUser.id)

      return { id: sessionUser.id, name: details.name, email, password, role }
    }

    const createAdmin: AuthFactories['createAdmin'] = (options = {}) =>
      createUser({ ...options, role: 'admin' })

    const apiForUser: AuthFactories['apiForUser'] = async (user) => {
      const api = await playwrightRequest.newContext({ baseURL: BASE_URL })
      apiContexts.push(api)
      const response = await api.post('/api/auth/sign-in/email', {
        data: {
          email: user.email,
          password: user.password,
        },
      })
      await expectOk(response, `sign in ${user.email}`)
      return api
    }

    const pageForUser: AuthFactories['pageForUser'] = async (user) => {
      const api = await apiForUser(user)
      const context = await browser.newContext({ storageState: await api.storageState() })
      contexts.push(context)
      const page = await context.newPage()
      await page.goto(BASE_URL)
      return page
    }

    const anonymousPage: AuthFactories['anonymousPage'] = async () => {
      const context = await browser.newContext()
      contexts.push(context)
      const page = await context.newPage()
      await page.goto(BASE_URL)
      return page
    }

    const setAuthSettings: AuthFactories['setAuthSettings'] = async (admin, auth) => {
      const api = await apiForUser(admin)
      const response = await api.put('/api/settings', {
        data: {
          app: { setupCompleted: true },
          auth,
        },
      })
      await expectOk(response, 'update auth settings')
    }

    const resetSettings: AuthFactories['resetSettings'] = async (admin, auth = {}) => {
      await setAuthSettings(admin, { ...DEFAULT_AUTH_SETTINGS, ...auth })
    }

    const createAgent: AuthFactories['createAgent'] = async (owner, options = {}) => {
      const api = await apiForUser(owner)
      const response = await api.post('/api/agents', {
        data: {
          name: options.name ?? `E2E Agent ${workerSeed}-${++userCounter}`,
          description: options.description ?? 'Created by Playwright auth factory',
        },
      })
      await expectOk(response, 'create agent')
      return response.json()
    }

    const inviteUser: AuthFactories['inviteUser'] = async (owner, agentSlug, target, role = 'user') => {
      const api = await apiForUser(owner)
      const response = await api.post(`/api/agents/${agentSlug}/access`, {
        data: { userId: target.id, role },
      })
      await expectOk(response, `invite user ${target.id} to ${agentSlug}`)
    }

    const createConnectedAccount: AuthFactories['createConnectedAccount'] = async (owner, options = {}) => {
      const api = await apiForUser(owner)
      const toolkitSlug = options.toolkitSlug ?? 'slack'
      const response = await api.post('/api/connected-accounts', {
        data: {
          providerConnectionId: options.providerConnectionId ?? `e2e-${toolkitSlug}-${workerSeed}-${++userCounter}`,
          providerName: options.providerName ?? 'composio',
          toolkitSlug,
          displayName: options.displayName ?? `E2E ${toolkitSlug}`,
          status: options.status ?? 'active',
        },
      })
      await expectOk(response, 'create connected account')
      const body = await response.json()
      return body.account
    }

    const createRemoteMcp: AuthFactories['createRemoteMcp'] = async (owner, options = {}) => {
      const now = Date.now()
      const id = randomUUID()
      withAuthDb((db) => {
        db.prepare(`
          INSERT INTO remote_mcp_servers (
            id,
            name,
            url,
            user_id,
            auth_type,
            access_token,
            tools_json,
            tools_discovered_at,
            status,
            error_message,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          options.name ?? `E2E MCP ${workerSeed}-${++userCounter}`,
          options.url ?? 'https://mcp.example.test/mcp',
          owner.id,
          options.authType ?? 'none',
          options.accessToken ?? null,
          JSON.stringify(options.tools ?? [{ name: 'hello_world', description: 'E2E test tool' }]),
          now,
          options.status ?? 'active',
          options.errorMessage ?? null,
          now,
          now
        )
      })
      return { id }
    }

    const connectRemoteMcpToAgent: AuthFactories['connectRemoteMcpToAgent'] = async (owner, agentSlug, mcpId) => {
      const api = await apiForUser(owner)
      const response = await api.post(`/api/agents/${agentSlug}/remote-mcps`, {
        data: { mcpIds: [mcpId] },
      })
      await expectOk(response, `connect remote MCP ${mcpId} to ${agentSlug}`)
    }

    await use({
      uniqueUserDetails,
      resetAuthData,
      createUser,
      createAdmin,
      apiForUser,
      pageForUser,
      anonymousPage,
      resetSettings,
      setAuthSettings,
      createAgent,
      inviteUser,
      createConnectedAccount,
      createRemoteMcp,
      connectRemoteMcpToAgent,
    })

    await Promise.all(contexts.map((context) => context.close()))
    await Promise.all(apiContexts.map((api) => api.dispose()))
  }, { scope: 'worker' }],

  user1Context: [async ({ browser }, use) => {
    const context = await browser.newContext()
    await use(context)
    await context.close()
  }, { scope: 'worker' }],

  user1Page: [async ({ user1Context }, use) => {
    const page = await user1Context.newPage()
    await page.goto(BASE_URL)
    await use(page)
  }, { scope: 'worker' }],

  user2Context: [async ({ browser }, use) => {
    const context = await browser.newContext()
    await use(context)
    await context.close()
  }, { scope: 'worker' }],

  user2Page: [async ({ user2Context }, use) => {
    const page = await user2Context.newPage()
    await page.goto(BASE_URL)
    await use(page)
  }, { scope: 'worker' }],

  user3Context: [async ({ browser }, use) => {
    const context = await browser.newContext()
    await use(context)
    await context.close()
  }, { scope: 'worker' }],

  user3Page: [async ({ user3Context }, use) => {
    const page = await user3Context.newPage()
    await page.goto(BASE_URL)
    await use(page)
  }, { scope: 'worker' }],
})

export { expect } from '@playwright/test'
