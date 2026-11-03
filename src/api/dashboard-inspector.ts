import {
  DASHBOARD_CONTEXT_MENU_TYPE,
  DASHBOARD_HOST_FEATURES_TYPE,
  DASHBOARD_INSPECT_REQUEST_TYPE,
  DASHBOARD_INSPECT_RESULT_TYPE,
  DASHBOARD_LOG_CAPACITY,
  DASHBOARD_LOG_ENTRY_MAX,
} from '@shared/lib/dashboard-inspect-schema'

let cached: string | null = null

/**
 * The frame half of the dashboard inspection protocol (see
 * `@shared/lib/dashboard-inspect-schema`), injected into every proxied
 * dashboard document with the runtime, before the dashboard's own scripts.
 *
 * It keeps the page's last console lines, uncaught errors, failed requests and
 * failed assets, and answers the app's snapshot request when the person leaves
 * a comment. It answers only its own parent, and only when the parent is the
 * app: the same origin (web), or, inside the desktop app only, its `file://`
 * page or a localhost dev server. Anyone can frame a dashboard URL, and the
 * snapshot carries page text.
 *
 * Its cost to a page that logs a lot is one capped string per call: an object
 * argument is serialized only up to a few hundred keys.
 */
export function getDashboardInspectorJs(): string {
  if (cached) return cached
  cached = /* js */ `
(function () {
  "use strict";
  if (window.__GAMUT_INSPECTOR__) return;
  window.__GAMUT_INSPECTOR__ = true;
  var CAP = ${DASHBOARD_LOG_CAPACITY}, MAX = ${DASHBOARD_LOG_ENTRY_MAX};
  var logs = [], dropped = 0, counts = {}, hostOrigin = null;
  var TOO_BIG = {};

  function cap(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + "\\u2026" : s; }
  function squash(s) { return String(s || "").replace(/\\s+/g, " ").trim(); }
  function classes(el) {
    var c = el.getAttribute && el.getAttribute("class");
    return c ? "." + squash(c).split(" ").slice(0, 3).join(".") : "";
  }
  function tagOf(el) { return cap(el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + classes(el), 120); }
  function json(v) {
    var n = 0;
    try {
      var s = JSON.stringify(v, function (_k, x) { if (++n > 300) throw TOO_BIG; return x; });
      return s === undefined ? String(v) : s;
    } catch (e) {
      if (e !== TOO_BIG) return Object.prototype.toString.call(v);
      if (Array.isArray(v)) return "Array(" + v.length + ") (too large to show)";
      var keys = Object.keys(v);
      return "{" + keys.slice(0, 10).join(", ") + (keys.length > 10 ? ", \\u2026" : "") + "} (too large to show)";
    }
  }
  function fmt(v) {
    if (typeof v === "string") return v;
    if (v === undefined) return "undefined";
    if (v instanceof Error) {
      var stack = v.stack ? String(v.stack).split("\\n").slice(1, 6).join("\\n") : "";
      return (v.name || "Error") + ": " + v.message + (stack ? "\\n" + stack : "");
    }
    if (typeof v === "function") return "[function " + (v.name || "anonymous") + "]";
    if (v === null || typeof v !== "object") return String(v);
    if (typeof Element !== "undefined" && v instanceof Element) return "<" + tagOf(v) + ">";
    return json(v);
  }
  function push(level, args) {
    try {
      var parts = [];
      for (var i = 0; i < args.length; i++) parts.push(fmt(args[i]));
      logs.push({ level: level, at: Date.now(), text: cap(parts.join(" "), MAX) });
      counts[level] = (counts[level] || 0) + 1;
      if (logs.length > CAP) { logs.shift(); dropped++; }
    } catch (_e) {}
  }

  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var original = console[level];
    if (typeof original !== "function") return;
    console[level] = function () { push(level, arguments); return original.apply(this, arguments); };
  });

  window.addEventListener("error", function (e) {
    var t = e.target;
    if (t && t !== window && t.tagName) {
      push("resource", ["Failed to load <" + t.tagName.toLowerCase() + "> " + (t.currentSrc || t.src || t.href || "")]);
      return;
    }
    var where = e.filename ? " (" + e.filename + ":" + e.lineno + ":" + e.colno + ")" : "";
    var message = e.error ? fmt(e.error) : String(e.message || "Error");
    push("error", [(/^Uncaught\\b/.test(message) ? "" : "Uncaught ") + message + where]);
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    push("error", ["Unhandled promise rejection:", e.reason]);
  });

  var nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (input, init) {
      var method = (init && init.method) || (input && input.method) || "GET";
      var url = typeof input === "string" ? input : (input && input.url) || String(input);
      return nativeFetch.apply(window, arguments).then(function (res) {
        if (res.status >= 400) push("network", [method + " " + url + " -> " + res.status + " " + res.statusText]);
        return res;
      }, function (err) {
        if (!err || err.name !== "AbortError") push("network", [method + " " + url + " failed: " + (err && err.message ? err.message : String(err))]);
        throw err;
      });
    };
  }
  if (window.XMLHttpRequest) {
    var open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__gamutRequest = String(method) + " " + String(url);
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this, aborted = false;
      // A request the page cancelled itself (a superseded search) did not fail, as with fetch's AbortError.
      xhr.addEventListener("abort", function () { aborted = true; });
      xhr.addEventListener("loadend", function () {
        if (xhr.status >= 400) push("network", [xhr.__gamutRequest + " -> " + xhr.status + " " + xhr.statusText]);
        else if (xhr.status === 0 && !aborted) push("network", [xhr.__gamutRequest + " failed"]);
      });
      return send.apply(this, arguments);
    };
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    var path = [], at = el;
    for (var i = 0; at && at.nodeType === 1 && i < 5; i++) {
      if (at === document.body || at === document.documentElement) break;
      path.unshift(tagOf(at));
      at = at.parentElement;
    }
    var text = cap(squash(el.innerText || el.textContent), 300);
    // A bare value or icon reads better beside its label: the nearest ancestor that adds text (the card).
    var context;
    if (text.length < 40) {
      at = el.parentElement;
      for (var j = 0; at && at !== document.body && j < 8; j++) {
        var around = squash(at.innerText || at.textContent);
        if (around && around !== text) { context = cap(around, 500); break; }
        at = at.parentElement;
      }
    }
    var r = el.getBoundingClientRect();
    var label = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt");
    return {
      tag: tagOf(el),
      path: cap(path.join(" > "), 900),
      text: text,
      context: context,
      role: el.getAttribute("role") ? cap(el.getAttribute("role"), 90) : undefined,
      label: label ? cap(label, 280) : undefined,
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
    };
  }

  function snapshot(point) {
    var root = document.scrollingElement || document.documentElement;
    var runtime = window.__GAMUT_DASHBOARD__;
    var element = null;
    if (point && typeof point.x === "number" && typeof point.y === "number") {
      try { element = describe(document.elementFromPoint(point.x, point.y)); } catch (_e) {}
    }
    return {
      url: cap(location.href, 3900),
      basePath: runtime && typeof runtime.basePath === "string" ? runtime.basePath : undefined,
      title: cap(document.title, 400),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY), width: root.scrollWidth, height: root.scrollHeight },
      devicePixelRatio: window.devicePixelRatio || 1,
      selection: cap(String(window.getSelection ? window.getSelection() : "").trim(), 1900),
      element: element,
      logs: logs.slice(),
      droppedLogs: dropped,
      counts: counts
    };
  }

  // The web app shares the dashboard's origin. The desktop app's page is file:// (or a
  // localhost dev server), which any downloaded file or local server could also claim,
  // so those count only inside the desktop app itself.
  var inDesktopApp = typeof navigator !== "undefined" && /\\bElectron\\//.test(navigator.userAgent || "");
  function trusted(origin) {
    if (origin === location.origin) return true;
    return inDesktopApp && (origin === "file://" || /^https?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?$/.test(origin));
  }
  function target(origin) { return origin === "file://" ? "*" : origin; }

  function onContextMenu(e) {
    if (hostOrigin === null || e.defaultPrevented || e.shiftKey || window.parent === window) return;
    var t = e.target;
    if (t && t.closest && t.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return;
    var selected = window.getSelection ? window.getSelection() : null;
    if (selected && !selected.isCollapsed && String(selected).trim()) return;
    e.preventDefault();
    window.parent.postMessage({ type: ${JSON.stringify(DASHBOARD_CONTEXT_MENU_TYPE)}, x: e.clientX, y: e.clientY }, target(hostOrigin));
  }

  window.addEventListener("message", function (event) {
    if (!event || event.source !== window.parent || window.parent === window || !trusted(event.origin)) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === ${JSON.stringify(DASHBOARD_HOST_FEATURES_TYPE)}) {
      hostOrigin = data.comments === true ? event.origin : null;
      // Listeners on one target run in the order they were added. Joining the end of the
      // window's list when the app announces itself (after the page loaded) lets the page's
      // own window-level contextmenu handlers run first and keep their menu.
      window.removeEventListener("contextmenu", onContextMenu);
      if (hostOrigin !== null) window.addEventListener("contextmenu", onContextMenu);
      return;
    }
    if (data.type !== ${JSON.stringify(DASHBOARD_INSPECT_REQUEST_TYPE)} || typeof data.id !== "string") return;
    var reply = { type: ${JSON.stringify(DASHBOARD_INSPECT_RESULT_TYPE)}, id: data.id, snapshot: snapshot(data.point) };
    window.parent.postMessage(reply, target(event.origin));
  });
})();
`
  return cached
}
