/**
 * Minimal Vite adapter for Gamut's prefix-stripping dashboard proxy.
 *
 * The dashboard manager supplies DASHBOARD_BASE_PATH at process startup. Vite
 * then emits dev modules and its HMR client beneath the public mount. Production
 * stays relative so the same build can be relocated; the static server/runtime
 * supplies the document base and routers use the injected runtime basename.
 */
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
