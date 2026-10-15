import { describe, it, expect } from 'vitest'
import { identifyDirectSite, identifyServiceCall } from './service-call'

const AUTH = '-H "Authorization: Bearer $PROXY_TOKEN"'

describe('identifyServiceCall', () => {
  it('names the connected account behind a proxied call', () => {
    expect(identifyServiceCall(`curl -sS "$PROXY_BASE_URL/abc/api.github.com/repos/o/r/pulls/1" ${AUTH} | jq .title`))
      .toEqual({ kind: 'connected-account', toolkit: 'github', name: 'GitHub' })
  })

  it('reads the host through a variable prefix and a loop', () => {
    const command = `G="$PROXY_BASE_URL/abc/gmail.googleapis.com/gmail/v1/users/me"
for id in 1 2; do curl -sS "$G/messages/$id" ${AUTH}; done`
    expect(identifyServiceCall(command)?.name).toBe('Gmail')
  })

  it('splits a shared host by path only where the path decides', () => {
    expect(identifyServiceCall('curl "$PROXY_BASE_URL/abc/www.googleapis.com/drive/v3/files"')?.name).toBe('Google Drive')
    expect(identifyServiceCall('curl "$PROXY_BASE_URL/abc/graph.microsoft.com/v1.0/me"')).toBeNull()
  })

  it('capitalizes a toolkit the service catalog does not name', () => {
    expect(identifyServiceCall('curl "$PROXY_BASE_URL/abc/api.datadoghq.com/api/v1/monitor"')?.name).toBe('Datadog')
  })

  it('treats the alias hosts a toolkit allows as that toolkit', () => {
    expect(identifyServiceCall('curl -L "$PROXY_BASE_URL/abc/raw.githubusercontent.com/o/r/main/README.md"')?.name).toBe('GitHub')
  })

  it('skips bash substitution on the base URL and reads the real call', () => {
    expect(identifyServiceCall(`PB=\${PROXY_BASE_URL/host.docker.internal/localhost}; curl "$PB/x/api.github.com/user" && curl "$PROXY_BASE_URL/x/api.github.com/user"`)?.name).toBe('GitHub')
  })

  it.each(['; echo done', ' | jq .', '&& echo ok'])('reads an unquoted URL up to a shell terminator (%s)', (rest) => {
    expect(identifyServiceCall(`curl $PROXY_BASE_URL/a/api.github.com${rest}`)?.name).toBe('GitHub')
  })

  it('reads the braced variable forms, and rejects a host with a terminator inside quotes', () => {
    expect(identifyServiceCall('(curl $' + '{PROXY_BASE_URL}/a/api.github.com)')?.name).toBe('GitHub')
    expect(identifyServiceCall('curl "$' + '{ANTHROPIC_BASE_URL}/v1/replicate/predictions/abc"')?.name).toBe('Media generation')
    expect(identifyServiceCall('curl "$PROXY_BASE_URL/a/api.github.com;invalid/user"')).toBeNull()
  })

  it('names built-in calls made through the older $ANTHROPIC_BASE_URL', () => {
    expect(identifyServiceCall('curl "$ANTHROPIC_BASE_URL/v1/x/2/tweets/search/recent?query=gamut"')?.name).toBe('X')
    expect(identifyServiceCall('curl "$ANTHROPIC_BASE_URL/v1/messages" -d @req.json')).toBeNull()
  })

  it('names built-in services by capability, and X by brand', () => {
    expect(identifyServiceCall('curl -sS -X POST "$PLATFORM_BASE_URL/v1/replicate/models/o/n/predictions"'))
      .toEqual({ kind: 'built-in', service: 'replicate', name: 'Media generation' })
    expect(identifyServiceCall(`curl "\${PLATFORM_BASE_URL}/v1/x/2/users/by/username/a"`)?.name).toBe('X')
  })

  it('stays plain Bash for no service, two services, or an unknown one', () => {
    expect(identifyServiceCall('ls -la')).toBeNull()
    expect(identifyServiceCall('grep -rn PROXY_BASE_URL docs/')).toBeNull()
    expect(identifyServiceCall('curl "$PROXY_BASE_URL/a/api.github.com/user"; curl "$PROXY_BASE_URL/b/slack.com/api/auth.test"')).toBeNull()
    expect(identifyServiceCall('curl "$PROXY_BASE_URL/a/api.github.com/user" && curl "$PLATFORM_BASE_URL/v1/apollo/people"')).toBeNull()
    expect(identifyServiceCall('curl "$PROXY_BASE_URL/a/example.com/x"')).toBeNull()
    expect(identifyServiceCall('curl "$PLATFORM_BASE_URL/v1/exa/search"')).toBeNull()
    expect(identifyServiceCall('curl "$PROXY_BASE_URL/a/api.github.com2/user"')).toBeNull()
    expect(identifyServiceCall('curl "$PLATFORM_BASE_URL/v1/x-extra/search"')).toBeNull()
    expect(identifyServiceCall('curl "$PROXY_BASE_URL/a/api.github.com_extra/user"')).toBeNull()
    expect(identifyServiceCall('curl "$PLATFORM_BASE_URL/v1/x.json"')).toBeNull()
  })
})

describe('identifyDirectSite', () => {
  it('names the one site a direct curl fetches, with the toolkit icon Gamut ships for it', () => {
    expect(identifyDirectSite('curl -sS https://api.linear.app/graphql -H "Authorization: $LINEAR_API_KEY" | jq .'))
      .toEqual({ origin: 'https://api.linear.app', toolkit: 'linear' })
    expect(identifyDirectSite('wget -q "https://arxiv.org/pdf/2401.1"; curl -sI https://ARXIV.org/'))
      .toEqual({ origin: 'https://arxiv.org', toolkit: null })
  })

  it('reads the host the way a URL parser does, keeping its scheme', () => {
    expect(identifyDirectSite('curl https://api.github.com:pw@attacker.example/')?.origin).toBe('https://attacker.example')
    expect(identifyDirectSite('curl -s http://example.com:8080/x')?.origin).toBe('http://example.com:8080')
  })

  it('brands a shared host only when every URL names the same toolkit', () => {
    const drive = 'https://www.googleapis.com/drive/v3/files'
    expect(identifyDirectSite(`curl ${drive}`)?.toolkit).toBe('googledrive')
    expect(identifyDirectSite(`curl ${drive} https://www.googleapis.com/calendar/v3/calendars`)?.toolkit).toBeNull()
  })

  it('stays plain Bash without a fetch, a literal site, one site, or with any platform URL', () => {
    expect(identifyDirectSite('git clone https://github.com/o/r')).toBeNull()
    expect(identifyDirectSite('curl -sS "$URL"')).toBeNull()
    expect(identifyDirectSite(`curl "https://\${HOST}/health"`)).toBeNull()
    expect(identifyDirectSite('curl -sI https://warmapp.ai/ && curl -sI https://www.warmapp.ai/')).toBeNull()
    expect(identifyDirectSite('curl "$PROXY_BASE_URL/a/graph.microsoft.com/v1.0/me" -d \'{"url":"https://example.com"}\'')).toBeNull()
  })
})
