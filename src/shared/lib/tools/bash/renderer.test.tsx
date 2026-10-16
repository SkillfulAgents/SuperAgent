// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { getToolRenderer } from '../renderers'
import type { ProxyCallOutcome } from '@shared/lib/proxy/call-outcome'

function icon(command: string, result: string | null, isError = false) {
  const input = { command }
  const CollapsedContent = getToolRenderer('Bash', input)!.CollapsedContent!
  return render(<CollapsedContent input={input} result={result} isError={isError} />).container
}

describe('direct curl site icon', () => {
  it('shows the bundled icon for a known host, else the host favicon', () => {
    expect(icon('curl https://api.linear.app/graphql', '{}').querySelector('img')?.getAttribute('src')).toMatch(/\/linear\.svg$/)
    expect(icon('curl https://arxiv.org/abs/1', 'ok').querySelector('img')?.getAttribute('src')).toBe('https://arxiv.org/favicon.ico')
  })

  it('shows nothing for an http site or a failed call, and shows it on a call that printed nothing', () => {
    expect(icon('curl http://example.com/', 'ok').querySelector('img')).toBeNull()
    expect(icon('curl https://arxiv.org/abs/1', 'curl: (6) Could not resolve host', true).innerHTML).toBe('')
    expect(icon('curl -o paper.pdf https://arxiv.org/pdf/1', null).querySelector('img')).not.toBeNull()
  })
})

describe('connected-account call detail', () => {
  const input = { command: 'curl -sS "$PROXY_BASE_URL/acct/api.github.com/repos/o/r/pulls/9" | jq .title' }
  const detail = (proxyOutcome?: ProxyCallOutcome) => {
    const CollapsedContent = getToolRenderer('Bash', input)!.CollapsedContent!
    return render(<CollapsedContent input={input} result="null" proxyOutcome={proxyOutcome} />).container.textContent
  }

  it('says why the proxy failed the call, else how many requests failed', () => {
    expect(detail({ requests: 1, failed: 1, error: 'Not found' })).toBe('· Not found')
    expect(detail({ requests: 5, failed: 1 })).toBe('· 1 of 5 failed')
    expect(detail({ requests: 1, failed: 0 })).toBe('')
    expect(detail(undefined)).toBe('')
  })
})
