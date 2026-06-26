import { Hono } from 'hono'
import { setCookie, getCookie } from 'hono/cookie'
import { miniAppSessionRequestSchema } from './telegram-miniapp-schema'
import { getChatIntegration } from '@shared/lib/services/chat-integration-service'
import { parseChatIntegrationConfig, type TelegramConfig } from '@shared/lib/chat-integrations/config-schema'
import { verifyInitData } from '@shared/lib/telegram/init-data'
import {
  signDashboardCookie,
  verifyDashboardCookie,
  DASHBOARD_COOKIE_NAME,
  DASHBOARD_COOKIE_TTL_SECONDS,
} from '@shared/lib/telegram/dashboard-cookie'
import { getPlatformBaseUrl } from '@shared/lib/platform-auth/config'
import { getOrCreateAuthSecret } from '@shared/lib/auth/secret'
import { getChatIntegrationSession } from '@shared/lib/services/chat-integration-session-service'
import { listArtifactsFromFilesystem } from '@shared/lib/services/artifact-service'
import { buildDashboardArtifactPath } from '@shared/lib/dashboard-url'

const SHELL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard</title>
<style>
  body { margin: 0; background: #000; }
  #frame {
    position: fixed; inset: 0;
    width: 100vw; height: 100vh;
    border: 0;
    display: none;
  }
  #status {
    position: fixed; inset: 0;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 12px;
    color: #fff; font-family: sans-serif; font-size: 15px;
    text-align: center; padding: 24px;
  }
  #open-in-browser {
    margin-top: 8px; padding: 8px 20px;
    background: transparent; color: #aaa;
    border: 1px solid #555; border-radius: 6px;
    font-size: 13px; cursor: pointer;
  }
</style>
</head>
<body>
<iframe id="frame"></iframe>
<div id="status">
  <span id="status-msg">Loading&hellip;</span>
  <button id="open-in-browser">Open in external browser</button>
</div>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script>
(function () {
  var status = document.getElementById('status');
  var frame  = document.getElementById('frame');

  function showError(msg) {
    document.getElementById('status-msg').textContent = msg;
    status.style.display = 'flex';
    frame.style.display  = 'none';
  }

  var params       = new URLSearchParams(window.location.search);
  var integrationId  = params.get('i') || '';
  var agentSlug    = params.get('a') || '';
  var dashboardSlug = params.get('d') || '';

  var twa = window.Telegram && window.Telegram.WebApp;
  var initData = twa ? twa.initData : '';

  function postSession(onOk, onFail) {
    fetch('/api/telegram-miniapp/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: initData, integrationId: integrationId, agentSlug: agentSlug, dashboardSlug: dashboardSlug }),
    })
      .then(function (res) {
        if (res.ok) { res.json().then(function (body) { onOk(body); }).catch(function () { onFail(0); }); return; }
        // Read the server's reason on failures so we can give a more accurate message.
        res.json().then(function (body) { onFail(res.status, body && body.reason); }).catch(function () { onFail(res.status); });
      })
      .catch(function () { onFail(0); });
  }

  postSession(
    function (body) {
      frame.src = body.artifactPath;
      frame.style.display = 'block';
      status.style.display = 'none';
      if (twa) { twa.ready(); twa.expand(); }
      // Silent cookie refresh at ~70 % of the 15-minute TTL (630 000 ms)
      setInterval(function () {
        postSession(function () {}, function () {
          showError('Your access expired. Reopen from the chat.');
        });
      }, 630000);
    },
    function (code, reason) {
      if (reason === 'no_owner') { showError("This dashboard isn’t available to open. Ask whoever set up this bot."); }
      else if (code === 401) { showError("Couldn’t verify this dashboard link. Reopen it from your chat."); }
      else if (code === 403) { showError("You don’t have access to this dashboard."); }
      else { showError("Couldn’t load the dashboard."); }
    }
  );

  document.getElementById('open-in-browser').addEventListener('click', async function () {
    try {
      // The dashboard scope rides the signed tg_dash cookie; no body needed.
      var res = await fetch('/api/telegram-miniapp/browser-link', { method: 'POST' });
      if (!res.ok) return;
      var data = await res.json();
      if (data && data.url) {
        if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.openLink) window.Telegram.WebApp.openLink(data.url);
        else window.open(data.url, '_blank');
      }
    } catch (e) { /* ignore */ }
  });
})();
</script>
</body>
</html>`

const app = new Hono()

app.get('/', (c) => c.html(SHELL_HTML))

app.post('/session', async (c) => {
  // 1. Parse + validate JSON body
  let rawBody: unknown
  try {
    rawBody = await c.req.json()
  } catch {
    return c.json({ ok: false, reason: 'bad_request' }, 400)
  }
  const parsed = miniAppSessionRequestSchema.safeParse(rawBody)
  if (!parsed.success) {
    return c.json({ ok: false, reason: 'bad_request' }, 400)
  }
  const { initData, integrationId, agentSlug: bodyAgentSlug, dashboardSlug } = parsed.data

  // 2. Look up integration
  const integration = getChatIntegration(integrationId)
  if (!integration) {
    return c.json({ ok: false, reason: 'not_found' }, 404)
  }

  // 3. Confirm it's telegram
  if (integration.provider !== 'telegram') {
    return c.json({ ok: false, reason: 'not_telegram' }, 400)
  }

  // 4. Extract bot token from config (config is a JSON string in DB)
  const tgConfig = parseChatIntegrationConfig('telegram', integration.config) as TelegramConfig | null
  if (!tgConfig?.botToken) {
    return c.json({ ok: false, reason: 'bad_integration' }, 400)
  }
  const { botToken } = tgConfig

  // 5. Verify Telegram initData signature + freshness
  const verifyResult = verifyInitData(initData, botToken, 86400)
  if (!verifyResult.ok) {
    return c.json({ ok: false, reason: verifyResult.reason }, 401)
  }

  // 6. Extract Telegram user id
  const tgUserId = verifyResult.data.user?.id
  if (tgUserId === undefined) {
    return c.json({ ok: false, reason: 'not_bound' }, 403)
  }

  // 7. Confirm user is bound to this integration (DM: externalChatId === String(tgUserId))
  const session = getChatIntegrationSession(integrationId, String(tgUserId))
  if (!session) {
    return c.json({ ok: false, reason: 'not_bound' }, 403)
  }

  // 8. Defense-in-depth: body's agentSlug must match the integration's authoritative agentSlug
  if (bodyAgentSlug !== integration.agentSlug) {
    return c.json({ ok: false, reason: 'agent_mismatch' }, 400)
  }

  // 9. Confirm the dashboard belongs to the agent
  let artifacts: Awaited<ReturnType<typeof listArtifactsFromFilesystem>>
  try {
    artifacts = await listArtifactsFromFilesystem(integration.agentSlug)
  } catch (err) {
    console.error('[telegram-miniapp] failed to list artifacts for agent', integration.agentSlug, err)
    artifacts = []
  }
  if (!artifacts.some(a => a.slug === dashboardSlug)) {
    return c.json({ ok: false, reason: 'dashboard_not_found' }, 404)
  }

  // 10. Owner must be present to act on their behalf
  if (!integration.createdByUserId) {
    return c.json({ ok: false, reason: 'no_owner' }, 401)
  }

  // 11. Mint the scoped dashboard cookie
  const exp = Math.floor(Date.now() / 1000) + DASHBOARD_COOKIE_TTL_SECONDS
  const token = await signDashboardCookie(
    {
      userId: integration.createdByUserId,
      agentSlug: integration.agentSlug,
      dashboardSlug,
      integrationId: integration.id,
      exp,
    },
    getOrCreateAuthSecret(),
  )

  // 12. Set cookie — secure only on https so local http round-trips still work.
  // Honor x-forwarded-proto so the flag is set correctly behind a TLS-terminating proxy.
  const secure = c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https:')
  setCookie(c, DASHBOARD_COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/api',
    maxAge: DASHBOARD_COOKIE_TTL_SECONDS,
  })

  // 13. Respond with the artifact path the Mini App should load
  return c.json({ ok: true, artifactPath: buildDashboardArtifactPath(integration.agentSlug, dashboardSlug) })
})

app.post('/browser-link', async (c) => {
  // 1. Verify existing tg_dash cookie — the dashboard scope comes from the
  //    signed cookie, never from caller-supplied input.
  const raw = getCookie(c, DASHBOARD_COOKIE_NAME)
  const payload = raw ? await verifyDashboardCookie(raw, getOrCreateAuthSecret()) : null
  if (!payload) {
    return c.json({ ok: false, reason: 'unauthorized' }, 401)
  }

  // 2. Require a public base URL
  const base = getPlatformBaseUrl()
  if (!base) {
    return c.json({ ok: false, reason: 'no_public_url' }, 400)
  }

  // 3. Mint a short-TTL link token (120s) carrying the cookie's dashboard scope
  const exp = Math.floor(Date.now() / 1000) + 120
  const token = await signDashboardCookie(
    {
      userId: payload.userId,
      agentSlug: payload.agentSlug,
      dashboardSlug: payload.dashboardSlug,
      integrationId: payload.integrationId,
      exp,
    },
    getOrCreateAuthSecret(),
  )

  // 4. Build absolute browser URL — the dashboard is bound to the signed token
  const url = `${base.replace(/\/$/, '')}/api/telegram-miniapp/browser?token=${encodeURIComponent(token)}`
  return c.json({ ok: true, url })
})

app.get('/browser', async (c) => {
  const token = c.req.query('token')

  // 1. Token required — it carries the trusted dashboard scope
  if (!token) {
    return c.text('Missing token parameter', 400)
  }

  // 2. Verify link token
  const payload = await verifyDashboardCookie(token, getOrCreateAuthSecret())
  if (!payload) {
    return new Response(
      '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Link expired</title></head><body>This link has expired. Reopen the dashboard from your Telegram chat.</body></html>',
      { status: 401, headers: { 'Content-Type': 'text/html' } },
    )
  }

  // 3. Mint a fresh full-TTL tg_dash cookie from the trusted token payload
  const exp = Math.floor(Date.now() / 1000) + DASHBOARD_COOKIE_TTL_SECONDS
  const cookie = await signDashboardCookie(
    {
      userId: payload.userId,
      agentSlug: payload.agentSlug,
      dashboardSlug: payload.dashboardSlug,
      integrationId: payload.integrationId,
      exp,
    },
    getOrCreateAuthSecret(),
  )
  // Honor x-forwarded-proto so the flag is set correctly behind a TLS-terminating proxy.
  const secure = c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https:')
  setCookie(c, DASHBOARD_COOKIE_NAME, cookie, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/api',
    maxAge: DASHBOARD_COOKIE_TTL_SECONDS,
  })

  // 4. Build artifact path server-side from the trusted token payload
  const artifactPath = buildDashboardArtifactPath(payload.agentSlug, payload.dashboardSlug)

  // 5. Serve browser shell — full-viewport iframe, no Telegram SDK. The cookie
  // can't self-renew here (renewal needs Telegram initData), so instead of
  // silent refresh we surface a clear expiry prompt when the cookie lapses.
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard</title>
<style>
  body { margin: 0; }
  iframe { position: fixed; inset: 0; width: 100vw; height: 100vh; border: 0; }
  #expired {
    position: fixed; inset: 0; display: none;
    flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; background: #000; color: #fff;
    font-family: sans-serif; font-size: 15px; text-align: center; padding: 24px;
  }
</style>
</head>
<body>
<iframe src="${artifactPath}"></iframe>
<div id="expired"><span>Your access expired. Reopen the dashboard from your Telegram chat.</span></div>
<script>
(function () {
  // The browser session cookie is minted for a fixed TTL and cannot be renewed
  // outside Telegram. When it lapses, cover the (now-unauthenticated) iframe
  // with a clear prompt instead of letting its next request fail on a bare 401.
  setTimeout(function () {
    document.getElementById('expired').style.display = 'flex';
  }, ${DASHBOARD_COOKIE_TTL_SECONDS * 1000});
})();
</script>
</body>
</html>`
  return c.html(html)
})

export default app
