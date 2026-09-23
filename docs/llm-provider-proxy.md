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

## Generic OpenAI-compatible endpoints

A Generic connection can select Anthropic Messages (the unchanged default),
OpenAI Chat Completions, or OpenAI Responses. The latter two use the container
proxy and enable deferred ToolSearch adaptation. Host-side summaries and dashboard
LLM calls use the same shared translation package through the Anthropic client's
fetch hook. No extra host listener is needed.

For OpenAI formats, a bare origin receives `/v1`; an explicit path such as `/v1`
or `/gateway/api` is used as supplied. Model listing appends `/models` to that same
path. Native Messages keeps its existing URL convention. Catalogs remain custom
and connection-local. Chat Completions sends `max_completion_tokens`; Responses
sends `max_output_tokens`. Model and endpoint capabilities still determine which
reasoning settings, images and hosted tools are accepted.

Local tests cover both formats with the real Anthropic client against a controlled
upstream: tool responses, streaming, usage, quota errors, model discovery, URL
handling, runtime selection and backward compatibility.

Live validation against `https://api.openai.com/v1` passed using a newly built
Gamut container with the bundled Claude SDK, Gamut prompts and real browser service:

| Case | Chat Completions (`gpt-5.1`) | Responses (`gpt-5.4-mini`) |
| --- | --- | --- |
| Question and session continuation | 17 × 23 = 391; +9 = 400 | Same |
| Bash + Read | Wrote and read a file; correct content and SHA-256 | Same |
| Deferred ToolSearch | Loaded browser tools, opened example.com, read Example Domain | Same |
| Image in Read result | COPPER; two blue circles, red triangle, green square | Same |
| Hosted WebSearch | Not supported by this translation route | Python TaskGroup documentation and introduction in 3.11 |
| Host helper + forced tool call | 72; report_result(value=72) | Same |
| Model listing and key validation | Passed through GenericLlmProvider | Same |

Both routes returned nonzero input, output and cache usage. The test image was
`superagent-container:sup908-openai`; session IDs were
`cf8e3ca8-3c23-4120-bcf9-e1a61364a1b1` (Responses) and
`53628a81-8ce1-4437-8740-0905a1fbe113` (Chat Completions). Throwaway scripts and credentials are outside the repo.

An initial Chat Completions run with `gpt-5.4-mini` returned an upstream 400:
function tools with reasoning effort require Responses (or effort `none`) for
that model. Use Responses for that combination; the adapter preserves the error
and does not silently change the selected API or reasoning effort. Successful
Chat Completions coverage uses `gpt-5.1`. These tests establish the exercised
models and capabilities, not universal support across every compatible service.
