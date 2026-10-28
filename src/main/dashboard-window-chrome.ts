export const DASHBOARD_CHROME_HEIGHT = 30

/**
 * Electron cannot add arbitrary controls to the native title bar. Dashboard
 * popouts therefore extend their renderer into the title-bar area and install
 * this small, app-owned chrome in the standalone wrapper document. The
 * dashboard itself remains isolated in the wrapper's iframe.
 *
 * This is injected by the desktop app instead of being served by the `/view`
 * route so it also works when a cloud workspace is running an older release of
 * that route.
 */
export function dashboardChromeScript(platform: NodeJS.Platform, titlePrefix: string): string {
  const platformClass = platform === 'darwin'
    ? 'darwin'
    : platform === 'win32'
      ? 'win32'
      : 'linux'
  const css = `
    html, body {
      height: 100%;
    }
    body {
      min-height: 100vh !important;
      padding-top: ${DASHBOARD_CHROME_HEIGHT}px !important;
    }
    body > iframe {
      top: ${DASHBOARD_CHROME_HEIGHT}px !important;
      height: calc(100vh - ${DASHBOARD_CHROME_HEIGHT}px) !important;
    }
    #gamut-dashboard-window-chrome {
      -webkit-app-region: drag;
      align-items: center;
      background: rgba(17, 17, 17, 0.97);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      box-sizing: border-box;
      color: #d4d4d4;
      display: flex;
      height: ${DASHBOARD_CHROME_HEIGHT}px;
      left: 0;
      position: fixed;
      right: 0;
      top: 0;
      user-select: none;
      z-index: 2147483647;
    }
    #gamut-dashboard-window-chrome.gamut-dashboard-window-chrome--darwin {
      padding: 0 10px 0 78px;
    }
    #gamut-dashboard-window-chrome.gamut-dashboard-window-chrome--win32 {
      height: env(titlebar-area-height, ${DASHBOARD_CHROME_HEIGHT}px);
      left: env(titlebar-area-x, 0px);
      padding: 0 8px;
      right: auto;
      width: env(titlebar-area-width, calc(100% - 138px));
    }
    #gamut-dashboard-window-chrome.gamut-dashboard-window-chrome--linux {
      padding: 0 10px;
    }
    #gamut-dashboard-window-title {
      font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      left: 50%;
      max-width: calc(100% - 120px);
      overflow: hidden;
      pointer-events: none;
      position: absolute;
      text-overflow: ellipsis;
      transform: translateX(-50%);
      white-space: nowrap;
    }
    #gamut-dashboard-refresh {
      -webkit-app-region: no-drag;
      align-items: center;
      background: transparent;
      border: 0;
      border-radius: 5px;
      color: #a3a3a3;
      cursor: pointer;
      display: inline-flex;
      height: 24px;
      justify-content: center;
      margin-left: auto;
      padding: 0;
      width: 24px;
    }
    #gamut-dashboard-refresh:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #f5f5f5;
    }
    #gamut-dashboard-refresh:focus-visible {
      outline: 2px solid #60a5fa;
      outline-offset: -2px;
    }
    #gamut-dashboard-refresh:disabled {
      cursor: default;
    }
    #gamut-dashboard-refresh.is-refreshing svg {
      animation: gamut-dashboard-refresh-spin 0.7s linear infinite;
    }
    @keyframes gamut-dashboard-refresh-spin {
      to { transform: rotate(360deg); }
    }
  `

  return `(() => {
    if (document.getElementById('gamut-dashboard-window-chrome')) return;

    const style = document.createElement('style');
    style.id = 'gamut-dashboard-window-chrome-style';
    style.textContent = ${JSON.stringify(css)};
    document.head.appendChild(style);

    const chrome = document.createElement('header');
    chrome.id = 'gamut-dashboard-window-chrome';
    chrome.className = 'gamut-dashboard-window-chrome--${platformClass}';

    const title = document.createElement('div');
    title.id = 'gamut-dashboard-window-title';
    const updateTitle = () => {
      const pageTitle = document.title || 'Gamut Dashboard';
      const titlePrefix = ${JSON.stringify(titlePrefix)};
      title.textContent = titlePrefix && !pageTitle.startsWith(titlePrefix)
        ? titlePrefix + pageTitle
        : pageTitle;
    };
    updateTitle();
    const titleElement = document.querySelector('title');
    if (titleElement) {
      new MutationObserver(updateTitle).observe(titleElement, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    const refresh = document.createElement('button');
    refresh.id = 'gamut-dashboard-refresh';
    refresh.type = 'button';
    refresh.title = 'Refresh dashboard';
    refresh.setAttribute('aria-label', 'Refresh dashboard');
    refresh.innerHTML = '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"></path><path d="M21 3v5h-5"></path></svg>';
    refresh.addEventListener('click', () => {
      refresh.classList.add('is-refreshing');
      refresh.disabled = true;
      refresh.setAttribute('aria-busy', 'true');
      window.location.reload();
    });

    chrome.append(title, refresh);
    document.body.appendChild(chrome);
  })()`
}
