# File-Based Agent Storage Refactor Plan

## Overview

Move from database-centric storage to a file-based approach where agent metadata, sessions, and configuration live in the filesystem. This simplifies the architecture, reduces sync issues, and allows Claude to naturally interact with agent configuration via CLAUDE.md.

## Current vs Target Architecture

### Current (DB-Centric)
```
~/.superagent/
├── superagent.db           # SQLite: agents, sessions, messages, toolCalls, secrets
└── agents/
    └── {uuid}/
        └── workspace/      # Mounted to container at /workspace
```

### Target (File-Based)
```
~/.superagent/
├── superagent.db           # SQLite: ONLY connected accounts (OAuth tokens)
└── agents/
    └── {name-slug-abc123}/ # Human-readable directory name
        └── workspace/      # Mounted to container at /workspace
            ├── CLAUDE.md   # Agent name/description (frontmatter) + instructions (body)
            ├── .env        # Agent secrets (KEY=value format)
            ├── session-metadata.json  # Custom session names
            └── .claude/    # Claude Code data (via CLAUDE_CONFIG_DIR)
                └── projects/
                    └── -workspace/
                        └── {session-id}.jsonl  # Conversation history
```

## What Stays in DB vs Moves to Files

| Data | Current | Target | Reason |
|------|---------|--------|--------|
| Agent name/description | `agents` table | `CLAUDE.md` frontmatter | File-based, agent-editable |
| Agent system prompt | `agents.systemPrompt` | `CLAUDE.md` body | SDK loads via `settingSources` |
| Sessions list | `sessions` table | JSONL files + `session-metadata.json` | Claude SDK manages history |
| Session names | `sessions.name` | `session-metadata.json` | Custom names per agent |
| Messages | `messages` table | JSONL files | Claude SDK writes these |
| Tool calls | `toolCalls` table | JSONL files | Embedded in messages |
| Agent secrets | `agentSecrets` table | `.env` file in workspace | File-based, agent can use directly |
| Connected accounts | `connectedAccounts` | **Keep in DB** | OAuth tokens via Composio |
| Agent-account links | `agentConnectedAccounts` | **Keep in DB** | Junction table for above |

## Implementation Phases

---

## Phase 1: File Storage Utilities

Create `src/lib/utils/file-storage.ts` with reusable utilities:

### 1.1 Slug Generation
```typescript
/**
 * Generate a URL-safe slug with unique suffix
 * "My Cool Agent" -> "my-cool-agent-k7x9m2"
 *
 * Note: Display name always comes from CLAUDE.md frontmatter, not the slug.
 * The slug is only used for directory names and URLs.
 */
function generateAgentSlug(name: string): string

/**
 * Generate a unique agent slug, checking for collisions
 * Regenerates random suffix if directory already exists
 */
async function generateUniqueAgentSlug(name: string): Promise<string>
```

### 1.2 Frontmatter Parsing
```typescript
interface ParsedMarkdown<T = Record<string, unknown>> {
  frontmatter: T
  body: string
}

/**
 * Parse markdown file with YAML frontmatter
 * Returns { frontmatter: {...}, body: "..." }
 */
function parseMarkdownWithFrontmatter<T>(content: string): ParsedMarkdown<T>

/**
 * Serialize frontmatter + body back to markdown string
 */
function serializeMarkdownWithFrontmatter<T>(frontmatter: T, body: string): string
```

### 1.3 Directory Operations
```typescript
/**
 * List subdirectories in a path (for listing agents)
 */
function listDirectories(dirPath: string): Promise<string[]>

/**
 * Check if directory exists
 */
function directoryExists(dirPath: string): Promise<boolean>

/**
 * Safely remove directory (with confirmation callback)
 */
function removeDirectory(dirPath: string): Promise<void>
```

### 1.4 JSONL Operations
```typescript
/**
 * Parse JSONL content into array of objects
 */
function parseJsonl<T>(content: string): T[]

/**
 * Read and parse a JSONL file
 */
function readJsonlFile<T>(filePath: string): Promise<T[]>

/**
 * Stream-read JSONL file (for large files)
 */
function streamJsonlFile<T>(filePath: string): AsyncIterable<T>
```

### 1.5 Agent Path Helpers
```typescript
/**
 * Get agent root directory (replaces getAgentWorkspaceDir parent)
 * ~/.superagent/agents/{slug}/
 */
function getAgentDir(slug: string): string

/**
 * Get agent workspace directory
 * ~/.superagent/agents/{slug}/workspace/
 */
function getAgentWorkspaceDir(slug: string): string

/**
 * Get CLAUDE.md path for agent
 * ~/.superagent/agents/{slug}/CLAUDE.md
 */
function getAgentClaudeMdPath(slug: string): string

/**
 * Get Claude config directory (inside workspace, mounted as CLAUDE_CONFIG_DIR)
 * ~/.superagent/agents/{slug}/workspace/.claude/
 */
function getAgentClaudeConfigDir(slug: string): string

/**
 * Get sessions directory
 * ~/.superagent/agents/{slug}/workspace/.claude/projects/-workspace/
 */
function getAgentSessionsDir(slug: string): string
```

---

## Phase 2: Agent CLAUDE.md Schema

### 2.1 Frontmatter Schema
```yaml
---
name: "My Assistant"
description: "A helpful coding assistant"  # optional
createdAt: "2024-01-15T10:30:00Z"
---

# Agent Instructions

[User-editable content that becomes the system prompt]

## Preferences
[Agent can add learned preferences here]

## Project Notes
[Agent can track project-specific knowledge]
```

### 2.2 TypeScript Types
```typescript
interface AgentFrontmatter {
  name: string
  description?: string
  createdAt: string  // ISO date string
}

interface AgentConfig {
  slug: string           // Directory name
  frontmatter: AgentFrontmatter
  instructions: string   // CLAUDE.md body (system prompt)
}
```

### 2.3 Default CLAUDE.md Template
```typescript
const DEFAULT_AGENT_TEMPLATE = `---
name: "{name}"
createdAt: "{createdAt}"
---

# Agent Instructions

You are a helpful AI assistant.

## Preferences

<!-- The agent can learn and note preferences here -->

## Project Notes

<!-- The agent can add notes as it learns about the project -->
`
```

---

## Phase 3: Agent Service Layer

Create `src/lib/services/agent-service.ts` to replace DB operations:

### 3.1 CRUD Operations
```typescript
interface AgentWithStatus {
  slug: string
  name: string
  description?: string
  instructions: string
  createdAt: Date
  status: 'running' | 'stopped'
  containerPort: number | null
}

/**
 * List all agents by scanning directories
 */
async function listAgents(): Promise<AgentWithStatus[]>

/**
 * Get single agent by slug
 */
async function getAgent(slug: string): Promise<AgentWithStatus | null>

/**
 * Create new agent (creates directory + CLAUDE.md)
 */
async function createAgent(name: string, description?: string): Promise<AgentWithStatus>

/**
 * Update agent metadata (updates CLAUDE.md frontmatter)
 */
async function updateAgent(slug: string, updates: Partial<AgentFrontmatter>): Promise<AgentWithStatus>

/**
 * Update agent instructions (updates CLAUDE.md body)
 */
async function updateAgentInstructions(slug: string, instructions: string): Promise<void>

/**
 * Delete agent (removes directory)
 */
async function deleteAgent(slug: string): Promise<void>
```

### 3.2 Implementation Notes
- `listAgents()`: Read all dirs in `~/.superagent/agents/`, parse each CLAUDE.md
- `createAgent()`: Generate slug, create directory, write CLAUDE.md from template
- Container manager needs to map slug → container name (already uses agentId in container name)

---

## Phase 4: Session Service Layer

Create `src/lib/services/session-service.ts` to replace DB operations:

### 4.1 Session Types (from JSONL)
```typescript
interface SessionMessage {
  uuid: string
  parentUuid: string | null
  type: 'user' | 'assistant'
  message: {
    role: string
    content: string | ContentBlock[]
  }
  timestamp: string
  // ... other fields from JSONL
}

interface SessionInfo {
  id: string           // UUID from filename
  agentSlug: string
  name?: string        // From sessions-index.json or generated
  createdAt: Date      // From first message timestamp
  lastActivityAt: Date // From last message timestamp
  messageCount: number
}
```

### 4.2 Operations
```typescript
/**
 * List sessions for an agent (reads sessions-index.json + JSONL files)
 */
async function listSessions(agentSlug: string): Promise<SessionInfo[]>

/**
 * Get session messages (parses JSONL file)
 */
async function getSessionMessages(agentSlug: string, sessionId: string): Promise<SessionMessage[]>

/**
 * Delete session (removes JSONL file)
 */
async function deleteSession(agentSlug: string, sessionId: string): Promise<void>

/**
 * Update session name (writes to sessions-index.json or separate metadata file)
 */
async function updateSessionName(agentSlug: string, sessionId: string, name: string): Promise<void>
```

### 4.3 Session Name Storage

Option A: Use Claude's `sessions-index.json` if it supports custom metadata
Option B: Create our own `~/.superagent/agents/{slug}/session-metadata.json`:
```json
{
  "session-uuid-1": { "name": "Debug Auth Issue", "starred": true },
  "session-uuid-2": { "name": "Refactor Components" }
}
```

---

## Phase 4B: Secrets Service Layer

Create `src/lib/services/secrets-service.ts` to manage .env files:

### 4B.1 Types
```typescript
interface AgentSecret {
  key: string      // Display name: "My API Key"
  envVar: string   // Environment variable: "MY_API_KEY"
  value: string    // The secret value
}
```

### 4B.2 Operations
```typescript
/**
 * Get path to agent's .env file
 * ~/.superagent/agents/{slug}/workspace/.env
 */
function getAgentEnvPath(slug: string): string

/**
 * List all secrets for an agent (parses .env file)
 */
async function listSecrets(slug: string): Promise<AgentSecret[]>

/**
 * Get a single secret by env var name
 */
async function getSecret(slug: string, envVar: string): Promise<AgentSecret | null>

/**
 * Add or update a secret (writes to .env file)
 */
async function setSecret(slug: string, secret: AgentSecret): Promise<void>

/**
 * Delete a secret (removes from .env file)
 */
async function deleteSecret(slug: string, envVar: string): Promise<void>

/**
 * Parse .env file content into key-value pairs
 * Handles comments, empty lines, quoted values
 */
function parseEnvFile(content: string): Record<string, string>

/**
 * Serialize secrets back to .env format
 * Includes header comment with display names
 */
function serializeEnvFile(secrets: AgentSecret[]): string
```

### 4B.3 .env File Format
```bash
# Superagent Secrets
# Format: ENV_VAR=value  # Display Name

MY_API_KEY=sk-abc123  # My API Key
DATABASE_URL=postgres://...  # Database URL
```

### 4B.4 Container Integration
- Container already mounts workspace, so .env is accessible at `/workspace/.env`
- No need to inject secrets at container start - they're already in the filesystem
- Agent scripts can use `source .env` or `dotenv` packages

---

## Phase 5: Container Integration Changes

### 5.1 Update `base-container-client.ts`
- Already sets `CLAUDE_CONFIG_DIR=/workspace/.claude` ✓
- Change `getContainerName()` to use slug: `superagent-{slug}` (was `superagent-{uuid}`)
- **Remove**: Secret injection via `-e` flags (secrets now in .env file in workspace)
- **Remove**: `buildEnvFlags()` for secrets (keep only ANTHROPIC_API_KEY and CLAUDE_CONFIG_DIR)
- **Simplify**: `start()` no longer needs to fetch secrets from DB

### 5.2 Update Session Creation in Container
Modify `agent-container/src/claude-code.ts`:
```typescript
const options = {
  systemPrompt: {
    type: 'preset',
    preset: 'claude_code',
    append: platformInstructions, // From system-prompt.md
  },
  settingSources: ['project'], // Loads /workspace/CLAUDE.md
}
```

Note: The user's custom instructions now come from CLAUDE.md (loaded by SDK), not passed via API.

### 5.3 CLAUDE.md Location
The CLAUDE.md with frontmatter lives at `~/.superagent/agents/{slug}/CLAUDE.md`.
But the SDK expects it at `/workspace/CLAUDE.md` inside container.

**Solution**: Symlink or copy on container start:
```bash
# In container startup or mount configuration
ln -sf /agent/CLAUDE.md /workspace/CLAUDE.md
```

Or restructure to put CLAUDE.md inside workspace:
```
~/.superagent/agents/{slug}/
└── workspace/           # Mounted to /workspace
    ├── CLAUDE.md        # Agent instructions (SDK reads this)
    └── .claude/         # Claude Code data
```

**Recommendation**: Put CLAUDE.md inside workspace/ for simplicity.

---

## Phase 6: API Route Updates

### 6.1 `/api/agents/route.ts`
```typescript
// GET - List agents
// Before: db.select().from(agents)
// After: agentService.listAgents()

// POST - Create agent
// Before: db.insert(agents).values(...)
// After: agentService.createAgent(name, description)
```

### 6.2 `/api/agents/[id]/route.ts`
Note: `[id]` becomes `[slug]` in the URL

```typescript
// GET - Get agent
// Before: db.select().from(agents).where(eq(agents.id, id))
// After: agentService.getAgent(slug)

// PATCH - Update agent
// Before: db.update(agents).set(...).where(...)
// After: agentService.updateAgent(slug, updates)

// DELETE - Delete agent
// Before: db.delete(agents).where(...)
// After: agentService.deleteAgent(slug)
```

### 6.3 `/api/agents/[id]/sessions/route.ts`
```typescript
// GET - List sessions
// Before: db.select().from(sessions).where(eq(sessions.agentId, id))
// After: sessionService.listSessions(slug)

// POST - Create session
// Changes: No DB insert for session, just start container session
// Session ID comes from Claude SDK
```

### 6.4 `/api/sessions/[id]/messages/route.ts`
```typescript
// GET - Get messages
// Before: db.select().from(messages).where(eq(messages.sessionId, id))
// After: sessionService.getSessionMessages(agentSlug, sessionId)

// POST - Send message
// No change to sending (still goes to container)
// Remove: messagePersister.saveUserMessage()
// Keep: SSE broadcasting for live updates
```

### 6.5 `/api/agents/[slug]/secrets/route.ts`
```typescript
// GET - List secrets
// Before: db.select().from(agentSecrets).where(eq(agentSecrets.agentId, id))
// After: secretsService.listSecrets(slug)

// POST - Add secret
// Before: db.insert(agentSecrets).values(...)
// After: secretsService.setSecret(slug, secret)
```

### 6.6 `/api/agents/[slug]/secrets/[envVar]/route.ts`
```typescript
// DELETE - Remove secret
// Before: db.delete(agentSecrets).where(...)
// After: secretsService.deleteSecret(slug, envVar)
```

### 6.7 Routes That Stay Database-Backed
- `/api/agents/[slug]/connected-accounts/` - Uses DB (OAuth via Composio)
- `/api/connected-accounts/` - Uses DB (app-level OAuth)
- `/api/settings/` - Uses file-based settings (unchanged)

---

## Phase 7: SSE / Live Streaming

### 7.1 What Changes
- **Remove**: Writing messages to `messages` and `toolCalls` tables
- **Keep**: WebSocket subscription to container for real-time events
- **Keep**: SSE broadcasting to connected UI clients

### 7.2 Simplified Message Persister
Rename to `stream-broadcaster.ts` - only handles:
- Subscribing to container WebSocket
- Broadcasting events to UI clients via SSE
- Tracking streaming state (for UI indicators)
- **Not**: Persisting to database

```typescript
// Before
class MessagePersister {
  saveUserMessage()      // Remove
  upsertAssistantMessage() // Remove
  handleToolResults()    // Remove
  broadcastToClients()   // Keep
}

// After
class StreamBroadcaster {
  subscribeToSession()   // Keep
  broadcastToClients()   // Keep
  getStreamingState()    // Keep (for UI)
}
```

---

## Phase 8: Database Schema Changes

### 8.1 Tables to Remove
```sql
DROP TABLE messages;
DROP TABLE tool_calls;
DROP TABLE sessions;
DROP TABLE agents;
DROP TABLE agent_secrets;           -- Moving to .env files
DROP TABLE agent_connected_accounts; -- Recreate with slug reference
```

### 8.2 Tables to Keep
```sql
-- OAuth connections managed by Composio (app-level, not per-agent)
connected_accounts (
  id,
  composio_connection_id,
  toolkit_slug,
  display_name,
  status,
  created_at,
  updated_at
)

-- Junction table linking agents to connected accounts
-- Uses slug instead of UUID
agent_connected_accounts (
  id,
  agent_slug TEXT NOT NULL,  -- References directory name, not FK
  connected_account_id,
  created_at
)
```

### 8.3 Migration
1. Export existing agents to file structure
2. Export existing secrets to .env files per agent
3. Recreate `agent_connected_accounts` with slug references
4. Drop removed tables

---

## Phase 9: Migration Strategy

### 9.1 Data Migration Script
```typescript
async function migrateToFileBased() {
  // 1. Get all agents from DB
  const agents = await db.select().from(agentsTable)

  for (const agent of agents) {
    // 2. Generate slug from name
    const slug = await generateUniqueAgentSlug(agent.name)

    // 3. Create new directory structure
    const workspaceDir = getAgentWorkspaceDir(slug)
    mkdirSync(workspaceDir, { recursive: true })

    // 4. Copy existing workspace if exists
    const oldWorkspace = `~/.superagent/agents/${agent.id}/workspace`
    if (exists(oldWorkspace)) {
      copyRecursive(oldWorkspace, workspaceDir)
    }

    // 5. Create CLAUDE.md in workspace
    const claudeMd = serializeMarkdownWithFrontmatter({
      name: agent.name,
      createdAt: agent.createdAt.toISOString(),
    }, agent.systemPrompt || DEFAULT_INSTRUCTIONS)

    write(`${workspaceDir}/CLAUDE.md`, claudeMd)

    // 6. Export secrets to .env file
    const secrets = await db.select().from(agentSecrets)
      .where(eq(agentSecrets.agentId, agent.id))

    if (secrets.length > 0) {
      const envContent = serializeEnvFile(secrets.map(s => ({
        key: s.key,
        envVar: s.envVar,
        value: s.value,
      })))
      write(`${workspaceDir}/.env`, envContent, { mode: 0o600 })
    }

    // 7. Update connected account links to use slug
    await db.update(agentConnectedAccounts)
      .set({ agentSlug: slug })
      .where(eq(agentConnectedAccounts.agentId, agent.id))

    // 8. Log mapping for reference
    console.log(`Migrated: ${agent.id} -> ${slug}`)
  }

  // 9. Drop old tables (after verification)
  // DROP TABLE agents, sessions, messages, tool_calls, agent_secrets
}
```

### 9.2 Cleanup
After migration verification:
- Delete old agent directories (`~/.superagent/agents/{uuid}/`)
- Drop unused DB tables
- Remove old DB-related code

---

## Phase 10: Frontend Updates

### 10.1 URL Changes
```
/agents/{uuid}        ->  /agents/{slug}
/agents/{uuid}/chat   ->  /agents/{slug}/chat
/agents/{uuid}/settings -> /agents/{slug}/settings
```

### 10.2 API Response Shape
Replace `id` with `slug`:
```typescript
// Before
{ id: "uuid-here", name: "My Agent", ... }

// After
{ slug: "my-agent-k7x9m2", name: "My Agent", ... }
```

### 10.3 CLAUDE.md Editor
Replace system prompt textarea with:
- Monaco editor for CLAUDE.md content
- Frontmatter displayed as editable form fields (name, description)
- Body editable as "Agent Instructions"

### 10.4 Secrets UI
Update to read/write from .env file:
- Parse .env format for display
- Write back in .env format with comments for display names

---

## Implementation Order

1. **Phase 1**: File storage utilities (slug, frontmatter, JSONL, directory helpers)
2. **Phase 2**: CLAUDE.md schema and types
3. **Phase 3**: Agent service layer (file-based CRUD)
4. **Phase 4**: Session service layer (read from JSONL)
5. **Phase 4B**: Secrets service layer (.env file operations)
6. **Phase 5**: Container integration (remove secret injection, add settingSources)
7. **Phase 6**: API route updates (switch all routes to new services)
8. **Phase 7**: Simplify MessagePersister → StreamBroadcaster
9. **Phase 9**: Run migration script
10. **Phase 8**: Drop unused DB tables
11. **Phase 10**: Frontend updates (URLs, CLAUDE.md editor, secrets UI)

---

## Design Decisions (Resolved)

1. **Session names**: `session-metadata.json` per agent
   ```json
   {
     "session-uuid-1": { "name": "Debug Auth Issue" },
     "session-uuid-2": { "name": "Refactor Components" }
   }
   ```

2. **CLAUDE.md location**: Inside workspace (`/workspace/CLAUDE.md`)
   - SDK finds it naturally with `settingSources: ['project']`
   - No symlinks needed

3. **Secrets**: `.env` file as source of truth
   - Located at `~/.superagent/agents/{slug}/workspace/.env`
   - UI reads/writes directly to this file
   - Container already has access via workspace mount
   - Note: Agent could potentially read/expose secrets - acceptable tradeoff for simplicity

4. **Agent slug collisions**: Random suffix + collision check
   - Always add random suffix: `my-agent-k7x9m2`
   - On creation, check if directory exists, regenerate suffix if collision

5. **Backwards compatibility**: Not needed
   - Early in development, can make breaking changes
   - No UUID → slug redirects required

---

## Success Criteria

- [x] Agents can be created without any DB write
- [x] Agent listing works by scanning directories + reading CLAUDE.md frontmatter
- [x] Sessions load from JSONL files
- [x] Session names stored in session-metadata.json
- [x] Messages display from JSONL without DB query
- [x] Live streaming still works via SSE (messagePersister unchanged for now)
- [x] Agent can edit its own CLAUDE.md
- [x] Secrets stored in .env file, UI can read/write
- [x] Container no longer needs secrets injected at start
- [ ] Migration exports existing data to new file structure (Phase 9 - TODO)
- [ ] Only `connected_accounts` tables remain in DB (Phase 8 - TODO after migration)

## Implementation Status

### Completed
- **Phase 1**: File storage utilities (`src/lib/utils/file-storage.ts`)
- **Phase 2**: CLAUDE.md schema/types (`src/lib/types/agent.ts`)
- **Phase 3**: Agent service (`src/lib/services/agent-service.ts`)
- **Phase 4**: Session service (`src/lib/services/session-service.ts`)
- **Phase 4B**: Secrets service (`src/lib/services/secrets-service.ts`)
- **Phase 5**: Container integration (removed DB secret fetching)
- **Phase 6**: All API routes updated to use file-based services
- **Phase 7**: MessagePersister kept for SSE (can simplify later)

### Remaining
- **Phase 9**: Migration script to convert existing DB data
- **Phase 8**: Drop unused DB tables after migration verified
- **Phase 10**: Frontend updates (URL changes, response format)
