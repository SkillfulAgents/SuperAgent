import {
  DASHBOARD_DISPATCH_ACK_TYPE,
  DASHBOARD_DISPATCH_CONSENT_PREFIX,
  DASHBOARD_DISPATCH_CONSENT_SUFFIX,
  DASHBOARD_DISPATCH_COOLDOWN_MS,
  DASHBOARD_DISPATCH_ID_MAX,
  DASHBOARD_DISPATCH_PROMPT_MAX,
  DASHBOARD_DISPATCH_REQUEST_TYPE,
  DASHBOARD_DISPATCH_RESULT_TYPE,
  DASHBOARD_DISPATCH_TITLE_MAX,
} from '@shared/lib/dashboard-dispatch-schema'

/**
 * Host side of the dashboard session-dispatch protocol for the standalone
 * `/view` wrapper page (browser tabs and the Electron dashboard popout, which
 * loads the same wrapper — see `src/main/dashboard-window.ts`).
 *
 * Mirrors the in-app host (`use-dashboard-dispatch.ts` + the dispatch dialog)
 * in plain DOM: validates requests from the wrapped iframe, shows a native
 * <dialog> with the editable prompt (sessions always run on the dashboard's
 * owning agent — no picker), and only creates the session after the user
 * clicks Dispatch. The same throttle applies — one open request, then a
 * cooldown — so a buggy dashboard can at worst re-open one dialog. Message
 * types, limits, and consent copy are interpolated from the shared schema
 * constants so the protocol cannot drift per surface.
 *
 * The wrapper calls `window.__gamutDispatchHost.attach(...)` once it creates
 * the dashboard iframe.
 */

let cached: string | null = null

export function getDashboardViewDispatchHostJs(): string {
  if (cached) return cached
  cached = buildSource()
  return cached
}

function buildSource(): string {
  return /* js */ `
(function () {
  "use strict";
  var REQUEST_TYPE = ${JSON.stringify(DASHBOARD_DISPATCH_REQUEST_TYPE)};
  var ACK_TYPE = ${JSON.stringify(DASHBOARD_DISPATCH_ACK_TYPE)};
  var RESULT_TYPE = ${JSON.stringify(DASHBOARD_DISPATCH_RESULT_TYPE)};
  var PROMPT_MAX = ${DASHBOARD_DISPATCH_PROMPT_MAX};
  var ID_MAX = ${DASHBOARD_DISPATCH_ID_MAX};
  var TITLE_MAX = ${DASHBOARD_DISPATCH_TITLE_MAX};
  var COOLDOWN_MS = ${DASHBOARD_DISPATCH_COOLDOWN_MS};
  var CONSENT_PREFIX = ${JSON.stringify(DASHBOARD_DISPATCH_CONSENT_PREFIX)};
  var CONSENT_SUFFIX = ${JSON.stringify(DASHBOARD_DISPATCH_CONSENT_SUFFIX)};

  var STYLE = ""
    + ".gamut-dispatch-dialog { margin: auto; background: #171717; color: #e5e5e5; border: 1px solid #333; border-radius: 10px; padding: 1.25rem; width: min(480px, calc(100vw - 2rem)); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }"
    + ".gamut-dispatch-dialog::backdrop { background: rgba(0, 0, 0, 0.6); }"
    + ".gamut-dispatch-dialog h2 { font-size: 15px; margin: 0 0 0.25rem; }"
    + ".gamut-dispatch-dialog .gamut-dispatch-desc { font-size: 12px; color: #999; margin: 0 0 1rem; }"
    + ".gamut-dispatch-dialog label { display: block; font-size: 12px; color: #bbb; margin: 0.75rem 0 0.25rem; }"
    + ".gamut-dispatch-dialog textarea { width: 100%; box-sizing: border-box; background: #0a0a0a; color: #e5e5e5; border: 1px solid #333; border-radius: 6px; padding: 0.4rem 0.5rem; font-size: 13px; font-family: inherit; }"
    + ".gamut-dispatch-dialog textarea { min-height: 7rem; resize: vertical; }"
    + ".gamut-dispatch-dialog .gamut-dispatch-error { font-size: 12px; color: #ef4444; margin: 0.5rem 0 0; min-height: 1em; }"
    + ".gamut-dispatch-dialog .gamut-dispatch-footer { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; }"
    + ".gamut-dispatch-dialog button { font-size: 13px; font-family: inherit; border-radius: 6px; padding: 0.4rem 0.9rem; cursor: pointer; border: 1px solid #333; background: transparent; color: #e5e5e5; }"
    + ".gamut-dispatch-dialog button.gamut-dispatch-confirm { background: #e5e5e5; color: #0a0a0a; border-color: #e5e5e5; }"
    + ".gamut-dispatch-dialog button:disabled { opacity: 0.5; cursor: default; }";

  function validRequest(data) {
    if (!data || typeof data !== "object") return null;
    if (data.type !== REQUEST_TYPE) return null;
    if (typeof data.id !== "string" || !data.id || data.id.length > ID_MAX) return null;
    var p = data.payload;
    if (!p || typeof p !== "object") return null;
    if (typeof p.prompt !== "string" || !p.prompt || p.prompt.length > PROMPT_MAX) return null;
    if (p.title != null && (typeof p.title !== "string" || !p.title || p.title.length > TITLE_MAX)) return null;
    return {
      id: data.id,
      prompt: p.prompt,
      title: p.title == null ? undefined : p.title
    };
  }

  function attach(options) {
    var iframe = options.iframe;
    var agentSlug = options.agentSlug;
    var agentName = options.agentName || agentSlug;
    var artifactSlug = options.artifactSlug;
    var basePath = options.basePath;
    var pendingId = null;
    var cooldownUntil = 0;

    var style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);

    function post(message) {
      if (!iframe.contentWindow) return;
      iframe.contentWindow.postMessage(message, window.location.origin);
    }

    function postResult(id, result) {
      post({ type: RESULT_TYPE, id: id, result: result });
    }

    function el(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    }

    function openDialog(request) {
      var finished = false;
      var dispatching = false;
      var dialog = el("dialog", "gamut-dispatch-dialog");
      var title = el("h2", null, request.title || "Dispatch agent session");
      var desc = el("p", "gamut-dispatch-desc", CONSENT_PREFIX);
      var agentStrong = document.createElement("strong");
      agentStrong.textContent = agentName;
      desc.appendChild(agentStrong);
      desc.appendChild(document.createTextNode(CONSENT_SUFFIX));

      var promptLabel = el("label", null, "Prompt");
      var textarea = document.createElement("textarea");
      textarea.value = request.prompt;
      var error = el("p", "gamut-dispatch-error", "");
      var footer = el("div", "gamut-dispatch-footer");
      var cancelButton = el("button", null, "Cancel");
      cancelButton.type = "button";
      var confirmButton = el("button", "gamut-dispatch-confirm", "Dispatch");
      confirmButton.type = "button";
      footer.appendChild(cancelButton);
      footer.appendChild(confirmButton);

      dialog.appendChild(title);
      dialog.appendChild(desc);
      dialog.appendChild(promptLabel);
      dialog.appendChild(textarea);
      dialog.appendChild(error);
      dialog.appendChild(footer);
      document.body.appendChild(dialog);

      function finish(result) {
        if (finished) return;
        finished = true;
        pendingId = null;
        cooldownUntil = Date.now() + COOLDOWN_MS;
        postResult(request.id, result);
        if (typeof dialog.close === "function" && dialog.open) dialog.close();
        dialog.remove();
      }

      cancelButton.addEventListener("click", function () { finish({ cancelled: true }); });
      // Escape fires 'cancel' before 'close' — swallow it while the create
      // request is in flight, or the dashboard would be told cancelled while
      // a real session gets created.
      dialog.addEventListener("cancel", function (event) {
        if (dispatching) event.preventDefault();
      });
      // Covers Escape and any other programmatic close.
      dialog.addEventListener("close", function () {
        if (!dispatching) finish({ cancelled: true });
      });
      confirmButton.addEventListener("click", function () {
        var message = textarea.value.trim();
        if (!message) return;
        dispatching = true;
        confirmButton.disabled = true;
        cancelButton.disabled = true;
        error.textContent = "";
        fetch(basePath + "/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: message,
            dashboardDispatch: { dashboardSlug: artifactSlug }
          })
        }).then(function (res) {
          if (!res.ok) throw new Error("Failed to create session");
          return res.json();
        }).then(function (session) {
          finish({ sessionId: session.id, agentSlug: agentSlug });
        }).catch(function (err) {
          dispatching = false;
          confirmButton.disabled = false;
          cancelButton.disabled = false;
          error.textContent = err && err.message ? err.message : "Failed to create session";
        });
      });

      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }

    window.addEventListener("message", function (event) {
      if (!iframe.contentWindow || event.source !== iframe.contentWindow) return;
      var data = event.data;
      if (!data || typeof data !== "object" || data.type !== REQUEST_TYPE) return;
      var request = validRequest(data);
      if (!request) {
        if (typeof data.id === "string" && data.id) {
          post({ type: ACK_TYPE, id: data.id });
          postResult(data.id, { error: "Invalid dispatch request", code: "invalid_request" });
        }
        return;
      }
      post({ type: ACK_TYPE, id: request.id });
      if (pendingId) {
        postResult(request.id, { error: "A dispatch request is already awaiting the user", code: "busy" });
        return;
      }
      if (Date.now() < cooldownUntil) {
        postResult(request.id, { error: "Dispatch requests are rate limited \\u2014 wait for the user", code: "rate_limited" });
        return;
      }
      pendingId = request.id;
      openDialog(request);
    });
  }

  window.__gamutDispatchHost = { attach: attach };
})();
`
}
