---
title: Is my data secure?
description: Security and privacy FAQ — isolation, credentials, OAuth tokens, permissions, audit logging, and what the agent can and cannot access.
---

<!-- REVIEW REQUIRED: this file makes factual security claims. Any edit must be
     reviewed against the actual implementation before shipping. -->

Honest answers to the security questions users ask most. Where a detail depends on how Gamut is deployed (cloud vs self-hosted), that is called out explicitly.

## Where does the agent actually run?

Each agent runs in its own isolated container with its own filesystem and its own persistent workspace. Agents do not share files, secrets, or sessions with each other **unless you explicitly connect them**: cross-agent collaboration ([work-with-other-agents](../how-to/work-with-other-agents.md)) is opt-in — calls between agents require your approval (or a policy you've saved), and even connected agents exchange prompts and session transcripts, never each other's secrets. Mounting the same host folder into two agents likewise shares those files by your choice. The agent process runs as a non-root user inside the container. See [where-am-i-running](../platform/where-am-i-running.md) for the runtime options.

## Can the agent see my passwords or OAuth tokens?

For connected accounts (Gmail, GitHub, Slack, …): **no**. API calls go through a secure proxy. The agent holds only a synthetic token that is valid for proxy requests from that one agent; the proxy validates the request, checks the target host against a per-provider allowlist, enforces scope policies, and injects the real OAuth token on the server side. The real token never enters the agent's container. Details: [connect-external-accounts-oauth](../how-to/connect-external-accounts-oauth.md).

Secrets the user explicitly gives the agent (API keys, tokens added in Settings → Secrets or via a request in chat) are different: those exist so the agent can use them, and they are available inside that agent's container as environment variables. They are stored per-agent on disk (not additionally encrypted by Gamut — at-rest protection comes from your disk encryption), are not visible to other agents, and are included in **full agent exports** (the export dialog warns about this) though never in shareable templates. See [use-secrets-and-api-keys](../how-to/use-secrets-and-api-keys.md).

## What can the agent access?

- Its own workspace (`/workspace`) and any host folders the user has explicitly mounted into it.
- Connected accounts that have been mapped to it — subject to host allowlists and scope policies.
- Secrets configured for it.
- The web, via its browser and network access.

It cannot read other agents' workspaces or secrets, and it cannot use accounts that are not mapped to it.

## What stops the agent from doing something destructive?

- **Permission modes**: tool calls run behind a user-selected permission mode; calls not automatically allowed prompt the user for approval.
- **Scope policies**: per-provider API scopes can be set to allow, require review, or block — so e.g. reading email can be allowed while sending requires approval. See [control-what-the-agent-can-access](../how-to/control-what-the-agent-can-access.md).
- **Agent guidelines**: agents are instructed to confirm before hard-to-reverse or externally visible actions (sending messages, deleting data, spending money).

## Is there an audit trail?

Every proxied API request is logged with the agent, account, target host, path, method, status, matched scopes, and the policy decision. Self-hosted deployments additionally have audit logging described in [self-hosting-setup-and-administration](../platform/self-hosting-setup-and-administration.md).

## What about data from webhooks and web pages?

Content arriving from outside (webhook payloads, web pages, tool results) is treated as untrusted data, not instructions. Webhook endpoints support HMAC signature verification; unverified events are explicitly marked and agents are instructed never to follow instructions embedded in them. Agents are also instructed to flag suspected prompt-injection attempts to the user.

## Where is my data stored?

- **Self-hosted** (desktop app or Docker): agent workspaces, message history, and configuration live on your own machine/server in a local database and on-disk workspaces. Conversation content is sent to the LLM provider you configured (e.g. Anthropic) to generate responses, and to any external services you connect — nothing else leaves your machine.
- **Cloud/managed deployments**: workspaces and history live in the managed environment; ask your workspace admin about retention specifics.

## Can the agent change its own security rules?

No. The product documentation (this folder) is baked read-only into the container image, scope policies and permission settings live outside the container where the agent cannot edit them, and the agent cannot grant itself new accounts or scopes — every new access goes through a user-approval prompt.
