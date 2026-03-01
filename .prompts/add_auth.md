# SuperAgent - Auth Mode

We want to add a new feature to SuperAgent called "Auth Mode". It is enabled by setting `AUTH_MODE=true` as an env var when running the app (web only — not supported for the electron app).

---

## Overview

- **Login is required** - the app becomes multi-user, meaning if you are not authenticated, you will be redirected to a login / signup page. Similarly, all API routes enforce authentication.
- **Agent ACLs** - access to agents is guarded by ACLs. We shall have a new `agent_acl` table in the database that maps users (from the user's table) to agents (slugs) with a role column.
  - When a user creates an agent, we shall automatically create an 'owner' role ACL for them (in a DB transaction with agent creation).
  - When the app loads in auth mode, we don't just list all agents directly from the file system, but rather scan the ACL table to figure out which agents the user may see.
  - There are three agent roles (for ACLs):
    - **Owner** - can modify settings, delete agent, invite/manage users on the agent.
    - **User** - can use agent (send messages) but cannot delete or modify settings or invite people. Users also cannot directly inspect / modify skills, update them or open PRs from them.
    - **Viewer** - can view sessions, view dashboards and download generated files, but cannot send new messages to the agent / start new sessions.
  - **Constraint**: An agent must always have at least one owner. Removing the last owner is not allowed.
- **User Roles** - users in the system have roles, managed by the Better Auth admin plugin. Initially, we support 'user' and 'admin'.
- **Connected Accounts** - a connected account always belongs to a person. So we'll need a new "owner" column (`userId`).
  - When auth mode is enabled, the Composio user ID we use when adding an account should be the user's unique ID (rather than the currently hard coded ID).
  - **Agent-level sharing**: Connected accounts are linked at the agent level. Anyone with User+ ACL on an agent can trigger use of that agent's linked accounts. The proxy layer does not need to track which user initiated the call. The UI should make it clear when linking a personal account to an agent that it will be accessible to all agent users.
- **Notifications** - notifications shall be per user, so we should add a `userId` column in the DB.
- **Skillsets** - skillsets are currently stored in settings.json (app settings). Only admins can edit skillsets, but everyone can access them.
- **Remote MCP Servers** - will be user-owned as well (similar to accounts), with a `userId` column.
- **Onboarding** - new users in auth mode shall not see the config steps — go straight to "first agent".
- **Signup** - when users sign up they are added in the 'user' role. However, the FIRST ever user to signup is added in the admin role by default. **Race condition protection**: Use a DB transaction with a count check (`INSERT ... WHERE (SELECT COUNT(*) FROM users) = 0`) to prevent two simultaneous first signups.

---

## Architecture: Use Better Auth

We use [Better Auth](https://www.better-auth.com/) to set up authentication, integrated with the Drizzle ORM we are already using.

### Plugins

- **Admin plugin** - provides user role management (`admin`/`user` roles), listing users, banning/unbanning, setting roles, removing users. Adds a `role` field to the user object in sessions automatically.
- **Rate limiter plugin** - rate limit auth endpoints (login, signup, password reset). Use reasonable defaults (e.g. 10 attempts per 15 minutes per IP for login).

### Environment Variables

Better Auth requires two configuration values:

- **`BETTER_AUTH_SECRET`** — a cryptographic key (at least 32 characters) used by Better Auth to sign and encrypt session cookies. Without it, sessions cannot be created or validated securely. **Auto-generated on first startup**: if not set as an env var, generate one using `crypto.randomBytes(32).toString('base64')` and persist it to `~/.superagent/.auth-secret`. On subsequent startups, read from that file. Users can override by setting the env var explicitly.
- **`BETTER_AUTH_URL`** — the base URL of the app (e.g., `https://myapp.example.com`). Better Auth uses this for constructing callback URLs. **Derived from `trustedOrigins`** if configured (first entry), otherwise falls back to `http://localhost:<port>`.

### Better Auth Instance Setup

```typescript
// src/shared/lib/auth/index.ts
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { admin } from "better-auth/plugins"
import { db } from "../db"

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
  }),
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    admin(),
  ],
  secret: getOrCreateAuthSecret(),       // auto-generated, persisted to .auth-secret
  baseURL: getAuthBaseUrl(),             // derived from trustedOrigins setting
  trustedOrigins: getTrustedOrigins(),   // from app settings
})
```

### Mount Handler (Hono) — Conditional

Better Auth routes are **only mounted when AUTH_MODE is enabled**. This reduces attack surface in non-auth mode.

```typescript
// In src/api/index.ts
if (isAuthMode()) {
  app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw))
}
```

### Client Instance (React)

```typescript
// src/renderer/lib/auth-client.ts
import { createAuthClient } from "better-auth/react"
import { adminClient } from "better-auth/client/plugins"

export const authClient = createAuthClient({
  plugins: [adminClient()],
})

export const { signIn, signUp, signOut, useSession } = authClient
```

---

## Settings Architecture: App Settings vs User Settings

Settings are split into two categories:

### App Settings (`settings.json` — admin only in auth mode)

The existing `settings.json` stays as the app-level configuration. In auth mode, only admins can read/write these. Contains:
- `container` (runner, image, resource limits)
- `apiKeys` (anthropic, composio, browserbase)
- `models` (agent model, summarizer, browser)
- `agentLimits`
- `customEnvVars`
- `skillsets[]`
- `app.hostBrowserProvider`, `app.chromeProfileId` (infrastructure)
- `app.autoSleepTimeoutMinutes` (app-level, affects container resources)
- `app.showMenuBarIcon` (Electron-only, irrelevant in web auth mode)
- `auth.trustedOrigins` (list of allowed CORS/CSRF origins — web only, not needed in Electron)

### User Settings (DB table — both modes)

Per-user preferences stored in a `user_settings` DB table. The same code path is used in both auth and non-auth mode — in non-auth mode, a sentinel user ID (`'local'`) is used:

```typescript
function getCurrentUserId(c: Context): string {
  if (!isAuthMode()) return 'local'  // fixed ID for single-user mode
  return c.get('user').id
}
```

Contains:
- `theme` ('system' | 'light' | 'dark')
- `notifications` preferences
- `setupCompleted` / onboarding state

### Settings API Routes

- `GET /api/settings` — In auth mode: admin gets full app settings, non-admin gets 403. In non-auth mode: returns all settings.
- `PUT /api/settings` — In auth mode: admin only. In non-auth mode: open.
- `GET /api/user-settings` — Returns the current user's settings (uses sentinel `'local'` ID in non-auth mode).
- `PUT /api/user-settings` — Updates the current user's settings.

---

## CORS & CSRF

- `trustedOrigins` can optionally be configured in app settings (`settings.json` → `auth.trustedOrigins`). When configured, this is used both for Hono CORS middleware and Better Auth's CSRF protection.
- **Default: allow all origins** (same as current behavior). This keeps the setup frictionless. Admins can tighten this later via the Auth settings tab.
- In non-auth / Electron mode, CORS remains fully permissive (current behavior).

---

## Non-Auth Mode (Default)

When auth mode is not enabled, all authentication checks are bypassed. This is the default behavior today and how people use the app — it shall remain unchanged.

### No-Op Middleware Pattern

All auth middleware follows a no-op pattern when `AUTH_MODE` is false. This is centralized in the middleware itself (not per-route), making it impossible to miss a route:

```typescript
function Authenticated() {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) return next()  // no-op when auth disabled
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.json({ error: 'Unauthorized' }, 401)
    c.set('user', session.user)
    return next()
  }
}

function AgentRead() {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) return next()  // no-op when auth disabled
    const user = c.get('user')
    const agentSlug = c.req.param('id')
    // Check ACL: user has any role (owner, user, viewer) on this agent
    // OR user is admin
    return next()
  }
}

function AgentUser() {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) return next()
    const user = c.get('user')
    const agentSlug = c.req.param('id')
    // Check ACL: user has 'owner' or 'user' role on this agent
    // OR user is admin
    return next()
  }
}

function AgentAdmin() {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) return next()
    const user = c.get('user')
    const agentSlug = c.req.param('id')
    // Check ACL: user has 'owner' role on this agent
    // OR user is admin
    return next()
  }
}

function IsAdmin() {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) return next()
    const user = c.get('user')
    if (user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
    return next()
  }
}

function IsAgent() {
  // Validates synthetic bearer token from container — same in both modes
  return async (c: Context, next: Next) => {
    const token = c.req.header('Authorization')?.replace('Bearer ', '')
    if (!token || !await validateProxyToken(token)) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    return next()
  }
}
```

In non-auth mode, `c.get('user')` will be `undefined`, which is fine — services don't need it.

---

## Electron Guard

If running in Electron and `AUTH_MODE=true`, log a warning and ignore the flag. Auth mode is web-only.

---

## Clean Start Requirement

AUTH_MODE requires a clean data directory. No migration of existing data.

**Startup validation when `AUTH_MODE=true`**:
1. If the `user` table exists AND has entries → OK, normal start.
2. If the `user` table doesn't exist but the agents directory has agents → **ERROR**: "Cannot enable AUTH_MODE with existing data. Start with a clean data directory."
3. If the `user` table doesn't exist and no agents → OK, fresh start, run auth migrations.

---

## React "User" Context

Expose a `UserContext` for the frontend app that provides auth state everywhere:

```typescript
// src/renderer/context/user-context.tsx
interface UserContextValue {
  user: User | null            // null when not logged in or non-auth mode
  isAuthenticated: boolean     // true when logged in, always false in non-auth mode
  isAdmin: boolean             // true if user.role === 'admin', false in non-auth mode
  isAuthMode: boolean          // whether AUTH_MODE is enabled
  isPending: boolean           // loading state from Better Auth
  agentRole: (agentSlug: string) => 'owner' | 'user' | 'viewer' | null
  canAccessAgent: (agentSlug: string) => boolean        // has any role
  canUseAgent: (agentSlug: string) => boolean           // owner or user
  canAdminAgent: (agentSlug: string) => boolean         // owner only
  signOut: () => Promise<void>
}
```

**Implementation notes**:
- In non-auth mode: `isAuthMode=false`, all `can*` methods return `true`, `user` is null.
- In auth mode: uses `authClient.useSession()` for reactive session data. Agent roles are fetched from a dedicated API endpoint (`GET /api/my-agent-roles`) and cached with React Query.
- Components check `isAuthMode` before rendering auth-specific UI (login button, user avatar, access controls).
- `isAuthMode` is determined on app load via a lightweight `GET /api/auth-mode` endpoint (returns `{ enabled: boolean }`), which requires no authentication.

---

## Frontend Auth Gate

The app uses state-driven navigation (SelectionContext), not URL-based routing. The auth gate is a simple wrapper component that conditionally renders the login page or the main app.

### Provider Hierarchy (Updated)

```
<QueryProvider>
  <UserProvider>              ← NEW: auth state
    <AuthGate>                ← NEW: shows login or app
      <SelectionProvider>
        <ConnectivityProvider>
          <ErrorBoundary>
            <AppContent />
          </ErrorBoundary>
        </ConnectivityProvider>
      </SelectionProvider>
    </AuthGate>
  </UserProvider>
</QueryProvider>
```

### AuthGate Component

```tsx
// src/renderer/components/auth/auth-gate.tsx
function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthMode, isAuthenticated, isPending } = useUser()

  if (!isAuthMode) return <>{children}</>     // no auth, render app directly
  if (isPending) return <LoadingScreen />     // checking session...
  if (!isAuthenticated) return <AuthPage />   // show login/signup
  return <>{children}</>                      // authenticated, render app
}
```

**Key design decisions**:
- `UserProvider` sits above `SelectionProvider` because auth state is needed everywhere, and the selection state is meaningless when not authenticated.
- `AuthGate` sits between `UserProvider` and the rest — the login/signup page doesn't need `SelectionProvider`, `ConnectivityProvider`, etc.
- No URL-based routing is introduced — this keeps the navigation model consistent.

---

## Login / Signup Page

A simple, single-page auth UI rendered by `AuthGate` when the user is not authenticated. V1 supports **local email/password only** — social providers will be added later.

### Layout

Centered card on a clean background. Two tabs/modes: **Sign In** and **Sign Up**.

### Sign In Form

- **Email** — text input, required
- **Password** — password input, required
- **"Sign in" button** — submits the form
- **"Don't have an account? Sign up"** link — switches to Sign Up mode
- **Error display** — inline error message for invalid credentials, rate limiting, etc.

### Sign Up Form

- **Name** — text input, required
- **Email** — text input, required, validated as email format
- **Password** — password input, required, minimum 8 characters (Better Auth default)
- **Confirm Password** — password input, must match
- **"Sign up" button** — submits the form
- **"Already have an account? Sign in"** link — switches to Sign In mode
- **Error display** — inline error for duplicate email, validation failures, etc.

### Behavior

- Uses `authClient.signUp.email()` and `authClient.signIn.email()` from the Better Auth React client.
- On successful sign in/up, `authClient.useSession()` reactively updates → `AuthGate` re-renders → main app is shown.
- The first user to sign up is automatically made admin (handled server-side by Better Auth's first-user logic).
- Loading state shown on buttons during API calls.
- No "forgot password" flow in V1 (can be added later via Better Auth plugins).

### Implementation

```tsx
// src/renderer/components/auth/auth-page.tsx
function AuthPage() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')

  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <Card className="w-full max-w-md">
        <CardHeader>
          <h1>SuperAgent</h1>
          {/* Tabs or toggle for Sign In / Sign Up */}
        </CardHeader>
        <CardContent>
          {mode === 'signin' ? (
            <SignInForm onSwitchToSignUp={() => setMode('signup')} />
          ) : (
            <SignUpForm onSwitchToSignIn={() => setMode('signin')} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
```

---

## Agent Settings Dialog & API Routes

- **If not agent owner** → do not allow access to settings. When dialog is opened, do not call API (API should also enforce) and show a blur overlay on top of the dialog telling the user they are not an owner.
- **If auth mode enabled** → Add a new tab called **Access** to manage users on the agent.

### Access Tab (Agent Settings)

The Access tab is visible only to agent owners and shows:
- List of users with their roles (owner, user, viewer)
- **Invite button** with user-search functionality (search by name/email, select user, assign role)
- Ability to change user roles or remove users
- **Constraint enforced**: Cannot remove the last owner — UI disables the remove/change button and shows a tooltip explaining why.

---

## Admin Tabs in Settings

When Auth Mode is enabled, new admin-only tabs are added to Settings:

- **Auth** → control auth settings (trusted origins; providers, password requirements, allowed domains etc. will be added in the future)
- **Users** → see all users in a table (name, email, role, created date), with actions (change role, ban, delete)

---

## Auth at API Level

- There is a general **Authenticated** middleware applied on all routes which checks the user is logged in and attaches the user object to the request context.
- Beyond that, composable auth middleware validates specific things (is admin, owns agent, etc.).
- **Agent API calls** (from inside container) continue to use synthetic bearer tokens (`IsAgent()` middleware). These are extra sensitive as they can proxy with user keys / MCPs.
- **SSE Streams**: Validate Better Auth session on SSE connection establishment. Don't re-validate on each event (too expensive). Accept that a revoked session may receive events until the next reconnect. This is standard practice.

### Auth Middleware for API Routes

| Method                 | Auth                                                                                  | Path                                                                                               | Description                                     |
| ---------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Auth**               |                                                                                       |                                                                                                    |                                                 |
| ALL                    | (none — handled by Better Auth)                                                       | `/api/auth/*`                                                                                      | Better Auth handler (login, signup, session)    |
| **Agents**             |                                                                                       |                                                                                                    |                                                 |
| POST                   | Authenticated()                                                                       | `/api/agents/import-template`                                                                      | Import agent from uploaded ZIP template         |
| GET                    | Authenticated() Check both global skillset and user-level skillsets                    | `/api/agents/discoverable-agents`                                                                  | List agents available from configured skillsets |
| POST                   | Authenticated() Validate user access to skillset (global or user's)                   | `/api/agents/install-from-skillset`                                                                | Install an agent from a skillset repo           |
| GET                    | Authenticated() Filter by Agent ACLs                                                  | `/api/agents`                                                                                      | List all agents with status                     |
| POST                   | Authenticated() Create with agent ACL (owner) in transaction                          | `/api/agents`                                                                                      | Create a new agent                              |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id`                                                                                  | Get agent details                               |
| PUT                    | Authenticated() AgentAdmin()                                                          | `/api/agents/:id`                                                                                  | Update agent name/description/instructions      |
| DELETE                 | Authenticated() AgentAdmin()                                                          | `/api/agents/:id`                                                                                  | Delete agent and clean up data                  |
| POST                   | Authenticated() AgentUser()                                                           | `/api/agents/:id/start`                                                                            | Start agent's Docker container                  |
| POST                   | Authenticated() AgentUser()                                                           | `/api/agents/:id/stop`                                                                             | Stop agent's running container                  |
| POST                   | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/open-directory`                                                                   | Open agent's workspace directory                |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/sessions`                                                                         | List all sessions for an agent                  |
| POST                   | Authenticated() AgentUser()                                                           | `/api/agents/:id/sessions`                                                                         | Create a new session                            |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/sessions/:sessionId`                                                              | Get session details                             |
| PATCH                  | Authenticated() AgentUser()                                                           | `/api/agents/:id/sessions/:sessionId`                                                              | Update session metadata (e.g. name)             |
| DELETE                 | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/sessions/:sessionId`                                                              | Delete a session                                |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/sessions/:sessionId/messages`                                                     | Get all messages in a session                   |
| DELETE                 | Authenticated() AgentUser()                                                           | `/api/agents/:id/sessions/:sessionId/messages/:messageId`                                          | Delete a message                                |
| DELETE                 | Authenticated() AgentUser()                                                           | `/api/agents/:id/sessions/:sessionId/tool-calls/:toolCallId`                                       | Delete a tool call                              |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/sessions/:sessionId/subagent/:agentId/messages`                                   | Get subagent messages                           |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/sessions/:sessionId/raw-log`                                                      | Get raw container logs                          |
| POST                   | Authenticated() AgentUser()                                                           | `/api/agents/:id/sessions/:sessionId/messages`                                                     | Send a message to the agent                     |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/sessions/:sessionId/stream`                                                       | SSE stream for real-time session updates        |
| POST                   | Authenticated() AgentUser()                                                           | `/api/agents/:id/sessions/:sessionId/interrupt`                                                    | Interrupt a running operation                   |
| POST                   | Authenticated() AgentUser()                                                           | `/api/agents/:id/sessions/:sessionId/provide-secret`                                               | Provide a secret credential                     |
| POST                   | Authenticated() AgentUser()                                                           | `/api/agents/:id/sessions/:sessionId/provide-connected-account`                                    | Provide an OAuth account                        |
| POST                   | Authenticated() AgentUser()                                                           | `/api/agents/:id/sessions/:sessionId/answer-question`                                              | Answer agent's `ask_question` tool              |
| POST                   | Authenticated() AgentUser()                                                           | `/api/agents/:id/sessions/:sessionId/provide-file`                                                 | Provide a file to the agent                     |
| POST                   | Authenticated() AgentUser()                                                           | `/api/agents/:id/sessions/:sessionId/provide-remote-mcp`                                           | Provide remote MCP server details               |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/scheduled-tasks`                                                                  | List pending scheduled tasks                    |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/secrets`                                                                          | List agent secrets                              |
| POST                   | Authenticated() AgentUser()                                                           | `/api/agents/:id/secrets`                                                                          | Create a secret                                 |
| PUT                    | Authenticated() AgentUser()                                                           | `/api/agents/:id/secrets/:secretId`                                                                | Update a secret                                 |
| DELETE                 | Authenticated() AgentUser()                                                           | `/api/agents/:id/secrets/:secretId`                                                                | Delete a secret                                 |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/connected-accounts`                                                               | List connected OAuth accounts                   |
| POST                   | Authenticated() AgentUser()                                                           | `/api/agents/:id/connected-accounts`                                                               | Link a connected account                        |
| DELETE                 | Authenticated() AgentUser()                                                           | `/api/agents/:id/connected-accounts/:accountId`                                                    | Unlink a connected account                      |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/remote-mcps`                                                                      | List remote MCP servers                         |
| POST                   | Authenticated() AgentUser()                                                           | `/api/agents/:id/remote-mcps`                                                                      | Assign a remote MCP server                      |
| DELETE                 | Authenticated() AgentUser()                                                           | `/api/agents/:id/remote-mcps/:mcpId`                                                               | Remove MCP server assignment                    |
| GET                    | Authenticated() AgentUser()                                                           | `/api/agents/:id/mcp-audit-log`                                                                    | Get MCP call audit log                          |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/skills`                                                                           | List installed skills                           |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/discoverable-skills`                                                              | List available skills from skillsets            |
| POST                   | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/skills/install`                                                                   | Install a skill from a skillset                 |
| POST                   | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/skills/:dir/update`                                                               | Update a skill to new version                   |
| GET                    | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/skills/:dir/pr-info`                                                              | Get PR info for skill update                    |
| POST                   | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/skills/:dir/create-pr`                                                            | Create PR to update skill                       |
| GET                    | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/skills/:dir/publish-info`                                                         | Get publish info for a skill                    |
| POST                   | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/skills/:dir/publish`                                                              | Publish skill to skillset repo                  |
| POST                   | Authenticated() AgentRead()                                                           | `/api/agents/:id/skills/refresh`                                                                   | Refresh all skills                              |
| GET                    | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/skills/:dir/files`                                                                | List files in skill directory                   |
| GET                    | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/skills/:dir/files/content`                                                        | Get skill file content (`?path=`)               |
| PUT                    | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/skills/:dir/files/content`                                                        | Update skill file content                       |
| POST                   | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/export-template`                                                                  | Export agent as ZIP template                    |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/template-status`                                                                  | Check template export status                    |
| POST                   | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/template-update`                                                                  | Update agent template                           |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/template-pr-info`                                                                 | Get PR info for template update                 |
| POST                   | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/template-create-pr`                                                               | Create PR for agent template                    |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/template-publish-info`                                                            | Get publish info for template                   |
| POST                   | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/template-publish`                                                                 | Publish agent to skillset                       |
| POST                   | Authenticated() AgentRead()                                                           | `/api/agents/:id/template-refresh`                                                                 | Refresh agent templates                         |
| GET                    | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/audit-log`                                                                        | Get agent action audit log                      |
| POST                   | Authenticated() AgentUser()                                                           | `/api/agents/:id/upload-file`                                                                      | Upload a file for the agent                     |
| POST                   | Authenticated() AgentUser()                                                           | `/api/agents/:id/sessions/:sessionId/upload-file`                                                  | Upload file during a session                    |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/files/*`                                                                          | Retrieve uploaded files                         |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/artifacts`                                                                        | List artifacts from sessions                    |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/browser/status`                                                                   | Get host browser instance status                |
| POST                   | Authenticated() AgentUser()                                                           | `/api/agents/:id/browser/:action`                                                                  | Send action to host browser                     |
| **Agent Access (new)** |                                                                                       |                                                                                                    |                                                 |
| GET                    | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/access`                                                                           | List users with roles on this agent             |
| POST                   | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/access`                                                                           | Invite user (assign role)                       |
| PATCH                  | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/access/:userId`                                                                   | Change user's role on agent                     |
| DELETE                 | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/access/:userId`                                                                   | Remove user's access to agent                   |
| **User Roles (new)**   |                                                                                       |                                                                                                    |                                                 |
| GET                    | Authenticated()                                                                       | `/api/my-agent-roles`                                                                              | Get current user's roles on all agents          |
| **App Settings**       |                                                                                       |                                                                                                    |                                                 |
| GET                    | Authenticated() IsAdmin()                                                             | `/api/settings`                                                                                    | Get app settings                                |
| PUT                    | Authenticated() IsAdmin()                                                             | `/api/settings`                                                                                    | Update app settings                             |
| POST                   | Authenticated() IsAdmin()                                                             | `/api/settings/start-runner`                                                                       | Start a container runner                        |
| POST                   | Authenticated() IsAdmin()                                                             | `/api/settings/refresh-availability`                                                               | Refresh runner availability                     |
| POST                   | Authenticated() IsAdmin()                                                             | `/api/settings/validate-anthropic-key`                                                             | Validate Anthropic API key                      |
| POST                   | Authenticated() IsAdmin()                                                             | `/api/settings/factory-reset`                                                                      | Clear all data and reset                        |
| **User Settings (new)**|                                                                                       |                                                                                                    |                                                 |
| GET                    | Authenticated()                                                                       | `/api/user-settings`                                                                               | Get current user's settings                     |
| PUT                    | Authenticated()                                                                       | `/api/user-settings`                                                                               | Update current user's settings                  |
| **Connected Accounts** |                                                                                       |                                                                                                    |                                                 |
| GET                    | Authenticated() If admin, show toggle for "All" and "Mine". Users see only theirs     | `/api/connected-accounts`                                                                          | List OAuth accounts                             |
| POST                   | Authenticated() Always add for authenticated user                                     | `/api/connected-accounts`                                                                          | Create a connected account                      |
| POST                   | Authenticated()                                                                       | `/api/connected-accounts/initiate`                                                                 | Start OAuth flow                                |
| POST                   | Authenticated()                                                                       | `/api/connected-accounts/complete`                                                                 | Complete OAuth flow                             |
| GET                    | Authenticated()                                                                       | `/api/connected-accounts/callback`                                                                 | OAuth callback handler                          |
| PATCH                  | Authenticated() Or(OwnsAccount(), IsAdmin())                                          | `/api/connected-accounts/:id`                                                                      | Update a connected account                      |
| DELETE                 | Authenticated() Or(OwnsAccount(), IsAdmin())                                          | `/api/connected-accounts/:id`                                                                      | Revoke and delete account                       |
| **Providers**          |                                                                                       |                                                                                                    |                                                 |
| GET                    | Authenticated()                                                                       | `/api/providers`                                                                                   | List supported OAuth providers                  |
| **Skillsets**          |                                                                                       |                                                                                                    |                                                 |
| GET                    | Authenticated()                                                                       | `/api/skillsets`                                                                                   | List configured skillsets                       |
| POST                   | Authenticated() IsAdmin()                                                             | `/api/skillsets/validate`                                                                          | Validate a skillset URL                         |
| POST                   | Authenticated() IsAdmin()                                                             | `/api/skillsets`                                                                                   | Add a new skillset                              |
| DELETE                 | Authenticated() IsAdmin()                                                             | `/api/skillsets/:id`                                                                               | Remove a skillset                               |
| POST                   | Authenticated() IsAdmin()                                                             | `/api/skillsets/:id/refresh`                                                                       | Refresh skillset from repo                      |
| GET                    | Authenticated()                                                                       | `/api/skillsets/:id/skills`                                                                        | Get skills from a skillset                      |
| GET                    | Authenticated()                                                                       | `/api/skillsets/:id/agents`                                                                        | Get agents from a skillset                      |
| **Notifications**      |                                                                                       |                                                                                                    |                                                 |
| GET                    | Authenticated() Filter by user                                                        | `/api/notifications/stream`                                                                        | SSE stream for global notifications             |
| GET                    | Authenticated() Filter by user                                                        | `/api/notifications`                                                                               | List recent notifications (`?limit=`)           |
| GET                    | Authenticated() Filter by user                                                        | `/api/notifications/unread-count`                                                                  | Get unread notification count                   |
| POST                   | Authenticated() UsersNotification()                                                   | `/api/notifications/:id/read`                                                                      | Mark notification as read                       |
| POST                   | Authenticated() Filter by user                                                        | `/api/notifications/read-all`                                                                      | Mark all as read                                |
| POST                   | Authenticated() Filter by user                                                        | `/api/notifications/read-by-session/:sessionId`                                                    | Mark session notifications as read              |
| DELETE                 | Authenticated() UsersNotification()                                                   | `/api/notifications/:id`                                                                           | Delete a notification                           |
| **Scheduled Tasks**    |                                                                                       |                                                                                                    |                                                 |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/scheduled-tasks/:taskId`                                                          | Get a scheduled task                            |
| GET                    | Authenticated() AgentRead()                                                           | `/api/agents/:id/scheduled-tasks/:taskId/sessions`                                                 | Get sessions from a scheduled task              |
| DELETE                 | Authenticated() AgentAdmin()                                                          | `/api/agents/:id/scheduled-tasks/:taskId`                                                          | Cancel a scheduled task                         |
| POST                   | Authenticated() AgentUser()                                                           | `/api/agents/:id/scheduled-tasks/:taskId/reset`                                                    | Reset failed task to pending                    |
| **Remote MCP Servers** |                                                                                       |                                                                                                    |                                                 |
| GET                    | Authenticated() Filter by user owned                                                  | `/api/remote-mcps`                                                                                 | List all registered MCP servers                 |
| POST                   | Authenticated()                                                                       | `/api/remote-mcps`                                                                                 | Register a new MCP server                       |
| POST                   | Authenticated()                                                                       | `/api/remote-mcps/initiate-oauth`                                                                  | Start OAuth flow for MCP server                 |
| GET                    | Authenticated()                                                                       | `/api/remote-mcps/oauth-callback`                                                                  | MCP OAuth callback                              |
| GET                    | Authenticated() Or(UsersMcpServer(), IsAdmin())                                       | `/api/remote-mcps/:id`                                                                             | Get a single MCP server                         |
| PATCH                  | Authenticated() Or(UsersMcpServer(), IsAdmin())                                       | `/api/remote-mcps/:id`                                                                             | Update MCP server settings                      |
| DELETE                 | Authenticated() Or(UsersMcpServer(), IsAdmin())                                       | `/api/remote-mcps/:id`                                                                             | Delete an MCP server                            |
| POST                   | Authenticated() Or(UsersMcpServer(), IsAdmin())                                       | `/api/remote-mcps/:id/discover-tools`                                                              | Discover tools from MCP server                  |
| POST                   | Authenticated() Or(UsersMcpServer(), IsAdmin())                                       | `/api/remote-mcps/:id/test-connection`                                                             | Test MCP server connection                      |
| **Browser**            |                                                                                       |                                                                                                    |                                                 |
| POST                   | IsAgent()                                                                             | `/api/browser/launch-host-browser`                                                                 | Launch browser for CDP connection               |
| POST                   | Authenticated() IsAdmin()                                                             | `/api/browser/stop-host-browser`                                                                   | Stop host browser instance                      |
| **Proxy**              |                                                                                       |                                                                                                    |                                                 |
| ALL                    | IsAgent()                                                                             | `/api/proxy/:agentSlug/:accountId/:rest`                                                           | Proxy connected account API requests            |
| ALL                    | IsAgent()                                                                             | `/api/mcp-proxy/:agentSlug/:mcpId/:rest`                                                           | Proxy MCP server requests                       |
| **Usage**              |                                                                                       |                                                                                                    |                                                 |
| GET                    | Authenticated() `?full=true` requires IsAdmin()                                       | `/api/usage`                                                                                       | Get API usage stats (`?days=1-90`)              |

**Note**: Scheduled tasks have been moved under the agent path (`/api/agents/:id/scheduled-tasks/...`).

---

## Database Schema Changes

### New Tables

#### `agent_acl`

| Column      | Type    | Notes                                    |
|-------------|---------|------------------------------------------|
| id          | text PK | UUID                                     |
| userId      | text FK | References Better Auth `user` table      |
| agentSlug   | text    | References agent directory               |
| role        | text    | 'owner' \| 'user' \| 'viewer'           |
| createdAt   | integer | Timestamp                                |

**Indexes**: `(userId, agentSlug)` unique composite, `(agentSlug)` for listing agent members.

#### `user_settings`

| Column      | Type    | Notes                                                        |
|-------------|---------|--------------------------------------------------------------|
| userId      | text PK | User ID, or `'local'` sentinel in non-auth mode             |
| settings    | text    | JSON blob validated against `userSettingsSchema` (Zod)       |
| updatedAt   | integer | Timestamp                                                    |

**Zod schema** — validated in the service layer on every write:

```typescript
import { z } from 'zod'

export const userSettingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  notifications: z.object({
    enabled: z.boolean().default(true),
    sound: z.boolean().default(true),
  }).default({}),
  setupCompleted: z.boolean().default(false),
})

export type UserSettings = z.infer<typeof userSettingsSchema>
```

On read, parse with `userSettingsSchema.parse()` (provides defaults for missing fields, enabling forward-compatible schema evolution). On write, validate with `userSettingsSchema.parse()` before persisting.

### Modified Tables

#### `connected_accounts` — add `userId` column

| Column | Type | Notes |
|--------|------|-------|
| userId | text | FK to user table. Nullable (null in non-auth mode). |

#### `notifications` — add `userId` column

| Column | Type | Notes |
|--------|------|-------|
| userId | text | FK to user table. Nullable (null in non-auth mode). |

#### `remote_mcp_servers` — add `userId` column

| Column | Type | Notes |
|--------|------|-------|
| userId | text | FK to user table. Nullable (null in non-auth mode). |

#### `scheduled_tasks` — add `createdByUserId` column

| Column          | Type | Notes |
|-----------------|------|-------|
| createdByUserId | text | FK to user table. Nullable. For ACL purposes (who can cancel). |

### Better Auth Tables (auto-managed)

Better Auth + admin plugin will create/manage: `user`, `session`, `account`, `verification`.

---

## User Deletion Cascade

When a user is deleted, the following cleanup occurs in order:

1. **Find agents where user is sole owner** → delete those agents entirely (sessions, files, container cleanup, ACL entries, linked accounts).
2. **Remove user's ACL entries** on remaining agents (where they are not sole owner).
3. **Delete user's connected accounts** — warn if any agents still reference them (those agent links become dangling and should be cleaned up).
4. **Delete user's MCP servers** — warn if any agents still reference them (same cleanup).
5. **Delete user's notifications**.
6. **Delete user's settings row** from `user_settings` table.
7. **Delete the user record** (via Better Auth admin API).

---

## Scheduled Tasks & Identity

Scheduled tasks do not need a user identity for execution — they run as the agent using agent-level connected accounts. The `createdByUserId` column is used only for ACL purposes (determining who can cancel/reset the task).

---

## Usage Tab

- When a regular user opens it, they see the usage stats for the agents they have access to.
- When an admin opens it, they have a way to toggle to "global" usage — via `?full=true` query param (admin-only).

---

## Audit Logging

In auth mode, log the following events (append to existing audit log infrastructure):
- Login / signup / failed login attempts
- Role changes (user promoted/demoted)
- ACL changes (user added/removed from agent, role changed)
- User deletion

---

## Implementation Best Practices

1. **DB transactions**: Agent creation + ACL insert must be atomic.
2. **Index ACL table**: `(userId, agentSlug)` for fast permission lookups.
3. **Composable Hono middleware**: `Authenticated()`, `AgentRead()`, `AgentUser()`, `AgentAdmin()`, `IsAdmin()` as chainable middleware that set context variables.
4. **`BETTER_AUTH_SECRET`**: Must be set as env var. Generate automatically on first startup if not provided (using `crypto.randomBytes(32).toString('base64')`).
5. **HTTPS**: Document that auth mode in production should use HTTPS (reverse proxy like nginx/caddy).

---

---

# Reference: Better Auth Docs

The following sections are reference documentation from Better Auth for implementation guidance.

## Installation

```
npm install better-auth
```

### Set Environment Variables

Create a `.env` file in the root of your project:

```txt title=".env"
BETTER_AUTH_SECRET=   # At least 32 chars, high entropy. Use `openssl rand -base64 32`
BETTER_AUTH_URL=http://localhost:3000   # Base URL of your app
```

### Create A Better Auth Instance

Create a file named `auth.ts` in `src/shared/lib/auth/` (following this project's convention).

```ts title="auth.ts"
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  //...
});
```

### Configure Database (Drizzle Adapter)

```ts title="auth.ts"
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/db"; // your drizzle instance

export const auth = betterAuth({
    database: drizzleAdapter(db, {
        provider: "sqlite",
    }),
});
```

### Create Database Tables

```bash title="Terminal"
npx @better-auth/cli generate   # Generate ORM schema / SQL migration
npx @better-auth/cli migrate    # Create tables directly (Kysely adapter only)
```

### Authentication Methods

```ts title="auth.ts"
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID as string,
      clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
    },
  },
});
```

### Mount Handler (Hono)

```ts title="src/index.ts"
import { Hono } from "hono";
import { auth } from "./auth";

const app = new Hono();
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
```

### Create Client Instance (React)

```ts title="lib/auth-client.ts"
import { createAuthClient } from "better-auth/react"
export const authClient = createAuthClient({
    // baseURL optional if same domain
})
export const { signIn, signUp, useSession } = authClient
```

## Basic Usage

### Sign Up

```ts
const { data, error } = await authClient.signUp.email({
    email,
    password,    // min 8 characters by default
    name,
    image,       // optional
    callbackURL: "/dashboard", // optional
}, {
    onRequest: (ctx) => { /* show loading */ },
    onSuccess: (ctx) => { /* redirect */ },
    onError: (ctx) => { alert(ctx.error.message) },
});
```

### Sign In

```ts
const { data, error } = await authClient.signIn.email({
    email,
    password,
    callbackURL: "/dashboard",
    rememberMe: false  // default true
}, {
    // callbacks
})
```

### Server-Side Authentication

```ts
import { auth } from "./auth";

const response = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true
});
```

### Sign Out

```ts
await authClient.signOut({
  fetchOptions: {
    onSuccess: () => {
      router.push("/login");
    },
  },
});
```

### Session — Client Side (React)

```tsx
import { authClient } from "@/lib/auth-client"

export function User() {
    const {
        data: session,
        isPending,
        error,
        refetch
    } = authClient.useSession()

    return (/* ... */)
}
```

### Session — Server Side (Hono)

```ts
import { auth } from "./auth";

const app = new Hono();
app.get("/path", async (c) => {
    const session = await auth.api.getSession({
        headers: c.req.raw.headers
    })
});
```

## Using Plugins

### Server Configuration

```ts title="auth.ts"
import { betterAuth } from "better-auth"
import { admin } from "better-auth/plugins"

export const auth = betterAuth({
    plugins: [
        admin()
    ]
})
```

### Client Configuration

```ts title="auth-client.ts"
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";

const authClient = createAuthClient({
    plugins: [
        adminClient()
    ]
})
```

## Drizzle ORM Adapter

### Schema generation & migration

```bash
npx @better-auth/cli@latest generate   # Generate Drizzle schema
npx drizzle-kit generate               # Generate migration file
npx drizzle-kit migrate                # Apply migration
```

### Joins (Experimental)

```ts title="auth.ts"
export const auth = betterAuth({
  experimental: { joins: true }
});
```

### Modifying Table Names

```ts
export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema: {
      ...schema,
      user: schema.users,
    },
  }),
});
```

### Using Plural Table Names

```ts
export const auth = betterAuth({
  database: drizzleAdapter(db, {
    usePlural: true,
  }),
});
```
