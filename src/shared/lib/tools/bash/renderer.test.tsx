// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { getToolRenderer } from '../renderers'

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
