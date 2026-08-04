---
title: How do agents work with other agents?
description: Cross-agent collaboration (x-agent): invoking other agents, reading their sessions, and the policies that govern it.
source_url:
  - https://www.gamut.so/docs/using-superagent/multi-agent/x-agent
  - https://www.gamut.so/docs/using-superagent/multi-agent/x-agent-policies
---

## X-Agent (Cross-Agent)

Superagent agents can interact with other agents in the same workspace through a set of cross-agent tools collectively called **X-Agent**. One agent can list the other agents available, create new agents on the fly, send messages to another agent, and read that agent's session history -- all without leaving its own session.

This enables multi-agent workflows where a manager agent delegates subtasks to specialized worker agents, or where peer agents collaborate by exchanging information through invocations and transcript reads.

### How it works

Each agent container is equipped with an MCP server called `agents` that exposes five tools. When an agent calls one of these tools, the request is sent from the container back to the Superagent host process over HTTP, authenticated with the container's proxy token. The host resolves which agent is calling, applies [X-Agent Policies](https://www.gamut.so/docs/using-superagent/multi-agent/x-agent-policies), and performs the operation on behalf of the caller.

The caller agent never directly communicates with the target agent's container. All orchestration flows through the host, which manages container lifecycle, session creation, message persistence, and policy enforcement.

### X-Agent tools

#### list_agents

Discovers the other agents available in the workspace. Returns each agent's slug, display name, and description. The calling agent is excluded from the results.

In [auth mode](https://www.gamut.so/docs/self-hosting/administration/auth-mode), the list is filtered to agents that the calling agent's owner has access to.

Use this before `invoke_agent` to find the slug of the agent you want to work with.

#### create_agent

Creates a new agent in the workspace. Accepts a name, an optional one-line description, and optional instructions (which become the new agent's system prompt). Returns the new agent's slug.

**This tool always requires manual approval.** There is no "always allow" policy for agent creation -- every `create_agent` call prompts the user for confirmation. In auth mode, the new agent inherits the ACL of the calling agent's owner.

After creation, you can immediately interact with the new agent using `invoke_agent`.

#### invoke_agent

Sends a message to another agent. This is the primary tool for agent-to-agent delegation.

**Parameters:**

- `slug` -- The target agent's slug (from `list_agents`).
- `prompt` -- The message to send.
- `session_id` (optional) -- An existing session ID to continue. If omitted, a new session is started on the target agent.
- `sync` (optional) -- If `true`, the tool blocks until the target agent finishes its turn and returns the agent's final response inline. If `false` (the default), the tool returns immediately with status `running` and you can check results later with `get_agent_session_transcript`.

**Returns:** The session ID and status (`running` or `completed`). In sync mode, the target agent's last message is included in the response.

When continuing an existing session (`session_id` provided), the session must exist and must not be currently running.

#### get_agent_sessions

Lists the sessions belonging to another agent, ordered newest first. Each entry includes the session ID, name, creation time, last activity time, message count, and whether the session is currently running.

Supports pagination via `limit` (default 50, max 200) and `offset` parameters.

Use the returned session ID with `get_agent_session_transcript` to read a conversation, or with `invoke_agent` to send a follow-up message.

#### get_agent_session_transcript

Reads the full message transcript of a session belonging to another agent. Returns a status line (`running`, `idle`, or `awaiting_input`) followed by the messages.

Each message includes its role (user, assistant, system), text content, and tool name if applicable. Tool call inputs and outputs are summarized to keep the transcript compact -- the raw payloads are omitted. Thinking blocks are stripped.

If `sync=true` and the session is currently running, the tool waits until the target agent's turn completes before returning the transcript.

### Session tracking and provenance

When one agent invokes another, the resulting session on the target agent is tagged with metadata recording which agent started it. The session name defaults to "Invoked by {caller-slug}" so it is easy to identify cross-agent sessions in the UI.

The session metadata includes:

- **invokedByAgentSlug** -- The slug of the agent that initiated the invocation.
- **createdByUserId** -- In auth mode, the user ID attributed to the invocation (inherited from the calling agent's owner).

This provenance data is visible in the session list and is used to enforce the one-hop invocation rule (see below).

### One-hop invocation rule

Cross-agent invocation is limited to one hop. If Agent A invokes Agent B, Agent B cannot invoke Agent C (or Agent A) from that invoked session. This prevents runaway chains (A invokes B invokes C invokes D...) and circular invocations (A invokes B invokes A).

The host enforces this by checking the session metadata of the calling session. If the caller's session was itself started by another agent (`invokedByAgentSlug` is present), the `invoke_agent` call is rejected with an error explaining the constraint.

An agent can still be invoked directly by a user and have full X-Agent capabilities in that session -- the restriction only applies to sessions that were themselves created by another agent's invocation.

### Self-invocation guard

An agent cannot invoke itself. If `invoke_agent` is called with the caller's own slug, the request is rejected immediately. This prevents infinite loops within a single agent.

### Use cases

#### Manager-worker delegation

A "manager" agent receives a complex task, breaks it into subtasks, and delegates each subtask to a specialized worker agent using `invoke_agent` with `sync=true`. The manager collects the results and synthesizes a final answer.

For example, a research agent might invoke a "Web Researcher" agent to gather information, a "Data Analyst" agent to process the findings, and a "Report Writer" agent to produce the final document.

#### Specialized agent collaboration

Agents with different capabilities can collaborate by reading each other's session transcripts. A "Code Review" agent might read the sessions of a "Developer" agent to understand what changes were made, then invoke the developer with feedback.

#### Dynamic agent creation

An agent can create new agents tailored to a specific task. For example, a "Project Bootstrapper" agent could create a set of specialized agents (frontend, backend, testing) with customized instructions, then orchestrate work across them.

#### Session monitoring

A supervisory agent can use `get_agent_sessions` and `get_agent_session_transcript` to monitor what other agents are doing, check on long-running tasks, or compile status reports -- all without sending new messages that would trigger additional work.

### Delivering sessions to the user

After invoking another agent, the caller can use the `deliver_session` tool to surface the resulting session as a clickable card in the chat. The user sees a link they can click to jump directly to the invoked session and review the work. This is useful for making cross-agent workflows visible and navigable in the UI.

## X-Agent Policies

X-Agent Policies control what one agent is allowed to do with other agents in the workspace. Every cross-agent operation -- listing agents, reading sessions, sending messages -- is gated by a policy check. You can allow operations automatically, require interactive review each time, or block them outright.

### Operations

There are three policy-controlled operations, plus one special case:

| Operation | What it gates | Target |
|---|---|---|
| **list** | Calling `list_agents` to discover other agents | None (workspace-wide) |
| **read** | Calling `get_agent_sessions` or `get_agent_session_transcript` to browse another agent's history | A specific target agent |
| **invoke** | Calling `invoke_agent` to send a message to another agent | A specific target agent |
| **create** | Calling `create_agent` to create a new agent | N/A (always prompts) |

Each operation is evaluated independently. Allowing `invoke` does not automatically allow `read`, and vice versa. This lets you configure write-only access (an agent can trigger another agent but not browse its history) or read-only access (an agent can monitor another agent's sessions but not send messages).

**Exception:** When `invoke_agent` is called with `sync=true`, the target agent's final response is returned inline as part of the invoke result. This does not require a separate `read` policy -- it is part of the invoke contract.

**Exception:** `create_agent` is never stored as a policy. It always requires manual user approval, every time it is called. There is no "always allow" option for agent creation.

### Decisions

Each policy resolves to one of three decisions:

- **Allow** -- The operation proceeds without prompting the user.
- **Review** -- The user is prompted to approve or deny the operation. This is the default when no policy exists.
- **Block** -- The operation is denied immediately without prompting the user.

### Policy precedence

When an agent attempts a cross-agent operation, the policy system evaluates the decision using a most-specific-wins rule:

1. **Per-target policy** -- If a policy exists for this specific caller, operation, and target agent, that decision is used.
2. **Global policy** -- If no per-target policy exists, the global policy for this caller and operation (target = all agents) is used.
3. **Default** -- If no policy exists at all, the default is `review` (prompt the user every time).

For example, if Agent A has a global invoke policy of `allow` but a per-target invoke policy of `block` for Agent B, then Agent A can invoke any agent except Agent B.

### The review flow

When a policy evaluates to `review` (or when no policy exists), the user sees an interactive approval prompt in the Superagent UI. The prompt appears in the caller agent's session as an orange-themed card showing:

- Which agent is requesting the action.
- What operation it wants to perform (list, read, invoke, or create).
- Which target agent is involved (for read and invoke).
- A preview of the message being sent (for invoke operations).

The user has several options:

#### Deny

Rejects this specific request. The calling agent receives an error that the operation was denied.

#### Allow Once

Approves this specific request without remembering the decision. The next time the same operation is attempted, the user will be prompted again.

#### Always Allow (remembered policies)

Available for `list`, `read`, and `invoke` operations (not `create`). Approves the request and saves a policy so future identical operations proceed automatically. The options vary by operation:

**For list:**
- "Always allow listing agents" -- Saves a global `list` policy so the agent can call `list_agents` without prompting.

**For read:**
- "Always allow reading {target}" -- Saves a per-target `read` policy for this specific agent.
- "Always allow reading all agents" -- Saves a global `read` policy that applies to every agent in the workspace.

**For invoke:**
- "Always allow messaging {target}" -- Saves a per-target `invoke` policy for this specific agent.
- "Always allow messaging all agents" -- Saves a global `invoke` policy for every agent.

When a global "always allow" decision is saved, any other pending review prompts for the same operation (against different targets) are automatically resolved, since the new global policy covers them.

#### Review timeout

If no decision is made within 5 minutes, the review times out and the operation is denied. The calling agent receives an error indicating the review timed out.

### Managing policies in the settings tab

You can view and edit X-Agent Policies directly in the agent's settings dialog, under the **X-Agent Policies** tab (also labeled "Cross-agent permissions" in the UI). This tab shows:

#### Global permissions

Three toggles that control workspace-wide defaults for this agent:

- **List Agents** -- Whether this agent can call `list_agents` to see other agents. Set to Allow, Review, or Block.
- **Read sessions of all agents** -- The default read policy for any agent that does not have a specific per-agent setting below.
- **Send messages to all agents** -- The default invoke policy for any agent that does not have a specific per-agent setting below.

#### Per-agent permissions

A table listing every other agent in the workspace, with two policy toggles per row:

- **Read sessions** -- Whether the caller can read this target agent's sessions and transcripts.
- **Send messages** -- Whether the caller can invoke (send messages to) this target agent.

Per-agent settings override the global defaults. If you set the global "Send messages to all agents" to Allow but set a specific agent's "Send messages" to Block, the caller can message every agent except that one.

The **Review** state (also shown as "default") means no policy is stored -- the user will be prompted each time. Internally, `review` rows are not persisted to the database; the absence of a row is treated as `review`. This keeps the policy table clean.

You can filter the per-agent list by name or slug using the search box when you have many agents in the workspace.

### Policy storage

Policies are stored in the `x_agent_policies` database table with the following structure:

| Column | Description |
|---|---|
| `caller_agent_slug` | The agent these policies apply to (the one making the call) |
| `target_agent_slug` | The target agent, or `null` for global policies |
| `operation` | `list`, `read`, or `invoke` |
| `decision` | `allow` or `block` (`review` is not stored -- it is the implicit default) |

Each combination of (caller, target, operation) is unique. When an agent is deleted, all policy rows referencing it -- whether as caller or target -- are automatically cleaned up.

### Auth mode considerations

In [auth mode](https://www.gamut.so/docs/self-hosting/administration/auth-mode), X-Agent Policies work alongside the existing role-based access control (ACL) system:

- **list_agents** results are filtered to agents the calling agent's owner has access to.
- **get_agent_sessions** and **get_agent_session_transcript** require the caller's owner to have at least `viewer` role on the target agent.
- **invoke_agent** requires the caller's owner to have at least `user` role on the target agent.
- **create_agent** copies the caller's owner ACL to the new agent, so the owner automatically has access.

ACL checks run first. If the caller's owner does not have sufficient access to the target, the request is rejected before the X-Agent Policy is even evaluated. If ACL passes, the X-Agent Policy is evaluated next.

The X-Agent Policies tab in settings respects auth mode visibility: policies targeting agents the viewer cannot see are hidden, preventing information leakage about workspace topology.

### Audit trail

Cross-agent operations that go through the review flow are tracked through the proxy audit log alongside other reviewed actions like API scope approvals and MCP tool approvals. The audit log records the caller agent, the operation, the target, and the policy decision (allow, block, denied by user, or review timeout).

You can view the audit trail for an agent in the agent's settings under the Audit Log tab. For more details on audit logging across Superagent, see [Audit Logging](https://www.gamut.so/docs/self-hosting/administration/audit-logging).
