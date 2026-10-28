/**
 * Minimal Vite adapter for Gamut's prefix-stripping dashboard proxy.
 *
 * The dashboard manager supplies DASHBOARD_BASE_PATH at process startup. Vite
 * then emits dev modules and its HMR client beneath the public mount. Production
 * stays relative so the same build can be relocated; the static server/runtime
 * supplies the document base and routers use the injected runtime basename.
 */
function scriptString(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** Runtime used only when a dashboard is opened directly, outside the host proxy. */
export function getGamutDashboardRuntimeFallbackJs(
  slug = process.env.DASHBOARD_ARTIFACT_SLUG || '',
) {
  return `
(function () {
  if (window.__GAMUT_DASHBOARD__) return;

  var marker = "/api/agents/";
  var pathname = window.location.pathname || "/";
  var markerAt = pathname.indexOf(marker);
  var basePath = "/";

  if (markerAt >= 0) {
    var segments = pathname.slice(markerAt + marker.length).split("/");
    if (segments.length >= 3 && segments[0] && segments[1] === "artifacts" && segments[2]) {
      basePath = pathname.slice(0, markerAt) + marker + segments[0] + "/artifacts/" + segments[2] + "/";
    }
  }

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

  window.__GAMUT_DASHBOARD__ = Object.freeze({
    basePath: basePath,
    routerBasePath: basePath === "/" ? "/" : basePath.slice(0, -1),
    slug: ${scriptString(slug)},
    url: dashboardUrl
  });
})();
`;
}

export function gamutDashboard() {
  const basePath = process.env.DASHBOARD_BASE_PATH || './';

  return {
    name: 'gamut-dashboard',
    config(_config, env) {
      const port = Number(process.env.DASHBOARD_PORT);
      const viteBase = env.command === 'serve' ? basePath : './';

      return {
        base: viteBase,
        appType: 'spa',
        ...(env.command === 'serve' && Number.isInteger(port) && port > 0
          ? {
              server: {
                host: '0.0.0.0',
                port,
                strictPort: true,
              },
            }
          : {}),
      };
    },
    transformIndexHtml() {
      return [{
        tag: 'script',
        attrs: { 'data-gamut-dashboard-fallback': 'true' },
        children: getGamutDashboardRuntimeFallbackJs(),
        injectTo: 'head-prepend',
      }];
    },
    configureServer(server) {
      if (!basePath.startsWith('/') || basePath === '/') return;

      const mount = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;

      // Gamut removes the browser-visible artifact mount before dialing a
      // dashboard. Vite expects inbound dev-module URLs to contain the same
      // `base` it emitted into HTML, so restore it inside Vite only.
      server.middlewares.use((request, _response, next) => {
        const requestUrl = request.url || '/';
        if (requestUrl !== mount && !requestUrl.startsWith(`${mount}/`)) {
          request.url = `${mount}${requestUrl.startsWith('/') ? '' : '/'}${requestUrl}`;
        }
        next();
      });
    },
  };
}
