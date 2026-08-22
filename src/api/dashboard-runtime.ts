import {
  DASHBOARD_DISPATCH_ACK_TYPE,
  DASHBOARD_DISPATCH_REQUEST_TYPE,
  DASHBOARD_DISPATCH_RESULT_TYPE,
} from '@shared/lib/dashboard-dispatch-schema'

export interface DashboardRuntimeInjectionOptions {
  basePath: string
  slug: string
  polyfillJs?: string
}

function withTrailingSlash(pathname: string): string {
  return pathname.endsWith('/') ? pathname : `${pathname}/`
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function scriptString(value: string): string {
  // Prevent user-controlled route segments from ending the inline script.
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

export function dashboardMountPath(routeSlug: string, artifactSlug: string): string {
  return withTrailingSlash(`/api/agents/${routeSlug}/artifacts/${artifactSlug}`)
}

/**
 * Runtime contract injected before a dashboard's own scripts execute.
 *
 * The server-provided base is authoritative for ordinary deployments. The
 * browser derives the same mount from location.pathname when another trusted
 * proxy adds a prefix (for example `/cloud/<key>` in the desktop app), because
 * that outer prefix is intentionally not disclosed to the remote deployment.
 */
// The runtime string is rebuilt only once per (basePath, slug) — it is
// injected into every proxied dashboard HTML response. Keyed cache stays
// small: one entry per dashboard actually served this process lifetime.
const runtimeJsCache = new Map<string, string>()

export function getDashboardRuntimeJs(basePath: string, slug: string): string {
  const fallbackBasePath = withTrailingSlash(basePath)
  const cacheKey = `${fallbackBasePath}\u0000${slug}`
  const cachedJs = runtimeJsCache.get(cacheKey)
  if (cachedJs) return cachedJs

  const source = /* js */ `
(function () {
  var fallbackBasePath = ${scriptString(fallbackBasePath)};
  var marker = "/api/agents/";
  var pathname = window.location.pathname;
  var markerAt = pathname.indexOf(marker);
  var basePath = fallbackBasePath;

  if (markerAt >= 0) {
    var segments = pathname.slice(markerAt + marker.length).split("/");
    if (segments.length >= 3 && segments[0] && segments[1] === "artifacts" && segments[2]) {
      basePath = pathname.slice(0, markerAt) + marker + segments[0] + "/artifacts/" + segments[2] + "/";
    }
  }

  var injectedBase = document.querySelector("base[data-gamut-dashboard-base]");
  if (injectedBase) injectedBase.setAttribute("href", basePath);

  function dashboardUrl(path) {
    var value = path == null ? "" : String(path);
    if (!value || value === ".") return basePath;
    if (value.charAt(0) === "?" || value.charAt(0) === "#") return basePath + value;
    value = value.replace(/^\\.\\//, "").replace(/^\\/+/, "");

    var origin = "http://gamut.invalid";
    var resolved = new URL(value, origin + basePath);
    if (resolved.origin !== origin || resolved.pathname.indexOf(basePath) !== 0) {
      throw new TypeError("Dashboard URLs cannot escape the dashboard mount");
    }
    return resolved.pathname + resolved.search + resolved.hash;
  }

  var dispatchSeq = 0;
  var pendingDispatches = {};

  window.addEventListener("message", function (event) {
    // Only the hosting parent frame may settle dispatches — a nested child
    // frame or popup with a handle to this window must not spoof results.
    if (!event || event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object" || typeof data.id !== "string") return;
    var pending = pendingDispatches[data.id];
    if (!pending) return;
    if (data.type === ${scriptString(DASHBOARD_DISPATCH_ACK_TYPE)}) {
      if (pending.ackTimer !== null) {
        clearTimeout(pending.ackTimer);
        pending.ackTimer = null;
      }
      return;
    }
    if (data.type !== ${scriptString(DASHBOARD_DISPATCH_RESULT_TYPE)}) return;
    delete pendingDispatches[data.id];
    if (pending.ackTimer !== null) clearTimeout(pending.ackTimer);
    var result = data.result;
    if (result && typeof result.error === "string") {
      pending.reject(new Error(result.error));
    } else {
      pending.resolve(result || {});
    }
  });

  function dispatchSession(request) {
    return new Promise(function (resolve, reject) {
      var prompt = request && typeof request.prompt === "string" ? request.prompt : "";
      if (!prompt.trim()) {
        reject(new TypeError("dispatchSession requires a non-empty prompt"));
        return;
      }
      if (window.parent === window) {
        reject(new Error("Session dispatch is not available in this window"));
        return;
      }
      var id = "gamut-dispatch-" + (++dispatchSeq) + "-" + Math.random().toString(36).slice(2);
      var pending = { resolve: resolve, reject: reject, ackTimer: null };
      // The parent may not speak the protocol (popped-out window, older app);
      // reject unless the host acks quickly. The user decision itself has no
      // deadline — the ack only proves someone is listening.
      pending.ackTimer = setTimeout(function () {
        delete pendingDispatches[id];
        reject(new Error("Session dispatch is not available in this window"));
      }, 2000);
      pendingDispatches[id] = pending;
      window.parent.postMessage({
        type: ${scriptString(DASHBOARD_DISPATCH_REQUEST_TYPE)},
        id: id,
        payload: {
          prompt: prompt,
          title: request.title == null ? undefined : String(request.title)
        }
      }, "*");
    });
  }

  var runtime = {
    basePath: basePath,
    routerBasePath: basePath === "/" ? "/" : basePath.slice(0, -1),
    slug: ${scriptString(slug)},
    url: dashboardUrl,
    dispatchSession: dispatchSession
  };
  window.__GAMUT_DASHBOARD__ = Object.freeze(runtime);
})();
`
  runtimeJsCache.set(cacheKey, source)
  return source
}

/** Inject the dashboard runtime and a stable document base before app assets. */
export function injectDashboardRuntime(
  html: string,
  options: DashboardRuntimeInjectionOptions,
): string {
  const basePath = withTrailingSlash(options.basePath)
  const existingManagedBase = html.match(
    /<base\b(?=[^>]*\bdata-gamut-dashboard-base\b)[^>]*>/i,
  )
  const baseTag = /<base\b[^>]*>/i.test(html)
    ? ''
    : `<base data-gamut-dashboard-base href="${escapeHtmlAttribute(basePath)}">`
  const scriptTag = `<script>${getDashboardRuntimeJs(basePath, options.slug)}${options.polyfillJs ?? ''}</script>`

  // The browser must parse the managed base before the runtime can update it
  // with an outer proxy prefix, but the runtime must still precede app assets.
  if (existingManagedBase) {
    const pos = existingManagedBase.index! + existingManagedBase[0].length
    return html.slice(0, pos) + scriptTag + html.slice(pos)
  }

  const tag = baseTag + scriptTag
  const headMatch = html.match(/<head(\s[^>]*)?>/i)

  if (!headMatch) return tag + html
  const pos = headMatch.index! + headMatch[0].length
  return html.slice(0, pos) + tag + html.slice(pos)
}

export function rewriteDashboardLocation(location: string, basePath: string): string {
  const mount = withTrailingSlash(basePath)
  const mountWithoutSlash = mount.slice(0, -1)
  if (
    !location.startsWith('/')
    || location.startsWith('//')
    || location === mountWithoutSlash
    || location.startsWith(mount)
  ) {
    return location
  }
  return mount + location.replace(/^\/+/, '')
}

export function rewriteDashboardCookiePath(cookie: string, basePath: string): string {
  const mount = withTrailingSlash(basePath)
  const pathAttribute = /(^|;)\s*Path=([^;]*)/i
  const match = cookie.match(pathAttribute)

  if (!match) return `${cookie}; Path=${mount}`

  const existingPath = match[2].trim()
  if (existingPath === mount.slice(0, -1) || existingPath.startsWith(mount)) return cookie

  const scopedPath = mount + existingPath.replace(/^\/+/, '')
  return cookie.replace(pathAttribute, `${match[1]} Path=${scopedPath}`)
}

function getSetCookieValues(headers: Headers): string[] {
  const values = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.()
  if (values && values.length > 0) return values
  const combined = headers.get('set-cookie')
  return combined ? [combined] : []
}

/** Copy upstream headers while applying browser-visible dashboard scoping. */
export function dashboardResponseHeaders(
  upstream: Headers,
  basePath: string,
  options?: { transformedHtml?: boolean },
): Headers {
  const headers = new Headers()
  const cookies = getSetCookieValues(upstream)

  upstream.forEach((value, name) => {
    if (name.toLowerCase() !== 'set-cookie') headers.append(name, value)
  })

  headers.delete('location')
  const location = upstream.get('location')
  if (location) headers.set('location', rewriteDashboardLocation(location, basePath))

  for (const cookie of cookies) {
    headers.append('set-cookie', rewriteDashboardCookiePath(cookie, basePath))
  }

  if (options?.transformedHtml) {
    // fetch transparently decodes upstream bodies; all representation metadata
    // must describe the injected bytes rather than the dashboard's old body.
    headers.delete('content-encoding')
    headers.delete('content-length')
    headers.delete('etag')
    headers.set('cache-control', 'no-cache')
  }

  return headers
}
