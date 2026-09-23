# Container LLM proxy

The container can run Messages requests through a loopback listener in its existing Node process. It loads `llm-endpoint-translation` v0.1.3 from its pinned GitHub release for Responses and Chat Completions conversion. No gateway process or Python runtime is added.

## Routing and lifecycle

Only a host-resolved connection runtime with a `proxy` descriptor starts a listener. Existing providers continue directly to their current endpoints. A listener belongs to one Claude SDK process, including its subagents; it starts on demand (or when that process prewarms), uses a random local credential, and closes on stop or a switch to another connection. Ports are assigned by the OS and bound to 127.0.0.1; they are not exposed by Docker.

The app supplies the destination and initial access credential. Requests cannot select an account or destination. The SDK receives the local proxy key instead of the upstream credential. Runtime data stays in memory; warm profiles store a fingerprint, not the descriptor. Replay scope includes connection ID, base URL and model so encrypted Responses reasoning cannot cross those boundaries.

For expiring credentials, the proxy calls the existing authenticated app runtime resolver with its session, expected connection and (after rejection) rejected credential generation. The app owns refresh tokens and provider exchanges. Concurrent requests inside one proxy share a refresh; cross-container coordination and provider-specific refresh live in the app credential service added with the OAuth provider PR. The proxy retries once on HTTP 401 before sending response bytes, never on quota/network errors or after streaming begins.

## Translation and capabilities

Protocol conversion is owned by the shared library. The container owns HTTP, cancellation, routing, credential callbacks and adapter hooks for provider restrictions. It passes through native Messages when only provider adaptations are needed.

Claude Code's local ToolSearch works with deferred tools: the proxy expands `tool_reference` results using schemas present in that request. It sends ordinary tools plus discovered or previously called deferred tools. It maintains no cross-session tool cache. Native server-side tool-search protocols are not emulated.

Images in tool results use the library's conversion to user image parts. Long tool names are restored on replies. Responses reasoning replay, token usage, error envelopes and SSE conversion also use the library. Unsupported hosted tools fail explicitly rather than being silently dropped. Responses hosted web search retains the library's limitations; provider search integration is separate. Token-count endpoints are not implemented. Model-specific token limits and effort mapping belong to provider configuration.

Client disconnects abort upstream work. Broken translated streams fail rather than claiming completion. Request bodies are limited to 32 MiB. The proxy never logs request bodies or credentials.

## Validation (2026-09-23)

- Container unit suite: 1,275 passing, 10 existing skips before the final additional image/truncation cases. Includes connection switches, direct-path restoration and lifecycle races.
- HTTP integration tests use the real Anthropic SDK against controlled upstreams for Messages, Chat Completions and Responses, streamed and JSON replies, tool names, images, auth retry/refresh, concurrent account isolation, quota errors, truncation and cancellation.
- Built the full `superagent-container:sup908-proxy` image. The compiled CommonJS application loads the ESM translator with a native dynamic import; TypeScript uses NodeNext resolution while retaining CommonJS output for existing `.ts` files.
- Ran the actual `ClaudeCodeProcess`, bundled Claude SDK and Gamut prompts in that image against a controlled Chat Completions upstream. ToolSearch revealed `mcp__agents__list_agents`; the subsequent request contained its schema and no raw tool references. The MCP call, Bash file write, Read and final response completed. Initial request had 9 tools; after discovery it had 10. The system prompt was 54,357 characters.
- A cold container Node process with `node:http` and Zod already loaded measured 3,981,312 bytes additional RSS, 1,817,408 bytes heap, and 22.6 ms to import/start one proxy (GC before/after). This is one cold-start observation, not a load benchmark or a budget guarantee. The shared library's [bench report](https://github.com/SkillfulAgents/llm-endpoint-translation/blob/main/bench/README.md) contains its separate concurrency measurements.

The controlled upstream confirms runtime wiring, not provider compatibility. Each provider follow-up must run real inference, tool calls, images, continuation, search and auth lifecycle tests with that provider's credentials before it is considered complete.
