/**
 * The path prefix every dashboard shim resolves its API calls against, derived
 * in the browser from the document's own URL.
 *
 * Dashboard HTML is served from `/api/agents/{id}/artifacts/{slug}/...`, and the
 * shims injected into it call back into this API. They used to do that with
 * root-relative paths (`/api/llm/...`), which resolve against the document's
 * *origin* — correct exactly as long as the document and the API share one.
 *
 * They stop sharing one the moment a dashboard is reached through the cloud
 * proxy: the document is served from `http://127.0.0.1:{port}/cloud/{key}/api/…`,
 * so a root-relative `/api/llm/messages` inside it resolves to the laptop's own
 * API. The dashboard would keep rendering, and its LLM and speech calls would
 * quietly run on local credentials and local settings instead of the cloud
 * workspace's — the failure mode that looks like nothing at all.
 *
 * Deriving the prefix from `location` rather than hardcoding it fixes that
 * without the proxy having to rewrite HTML or the deployment having to know it
 * is behind one: whatever precedes `/api/agents/` in the document's own path is
 * the prefix its API calls belong under. Unproxied that is the empty string, so
 * every URL these shims build stays byte-for-byte what it was — worth keeping,
 * since this code runs inside third-party dashboard documents.
 *
 * Injected into each shim's IIFE (they are concatenated into one `<script>`, so
 * the `var` stays function-scoped and neither leaks into the dashboard's page).
 */
export const API_PREFIX_SNIPPET = /* js */ `
  var apiPrefix = (function () {
    var marker = "/api/agents/";
    var at = window.location.pathname.indexOf(marker);
    // at === 0 unproxied, at === -1 if this is ever injected somewhere
    // unexpected — both mean "no prefix", i.e. exactly the old behaviour.
    return at > 0 ? window.location.pathname.slice(0, at) : "";
  })();
`
