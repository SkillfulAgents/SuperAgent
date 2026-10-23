// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { getToolRenderer } from '../renderers'

const POLL = 'curl -sS "$PLATFORM_BASE_URL/v1/replicate/predictions/p1" -H "Authorization: Bearer $PLATFORM_AUTH_TOKEN"'

function expanded(command: string, result: string | null, isError = false) {
  const input = { command }
  const renderer = getToolRenderer('Bash', input)!
  const ExpandedView = renderer.ExpandedView!
  render(<ExpandedView input={input} result={result} isError={isError} />)
  return renderer
}

describe('media generation result card', () => {
  it('keeps the Media generation row and shows model, status and the printed output', () => {
    const renderer = expanded(POLL, '{"model":"black-forest-labs/flux-1.1-pro","status":"succeeded","output":["https://replicate.delivery/a/out-0.png"]}')
    expect(renderer.displayName).toBe('Media generation')
    expect(screen.getByText('black-forest-labs/flux-1.1-pro')).toBeInTheDocument()
    expect(screen.getByTestId('media-call-status')).toHaveTextContent('Succeeded')
    expect(screen.getByRole('img', { name: 'out-0.png' })).toHaveAttribute('src', 'https://replicate.delivery/a/out-0.png')
    expect(screen.queryByTestId('bash-terminal')).toBeNull()
  })

  it('draws four outputs and links the rest', () => {
    const urls = [0, 1, 2, 3, 4].map((n) => `https://replicate.delivery/a/${n}.png`)
    expanded(POLL, JSON.stringify({ status: 'succeeded', output: urls }))
    expect(document.querySelectorAll('img')).toHaveLength(4)
    expect(screen.getByRole('link', { name: '4.png' })).toHaveAttribute('href', urls[4])
  })

  it('names the output that failed to load and says the link may have expired', () => {
    expanded(POLL, '{"status":"succeeded","output":"https://replicate.delivery/a/out.wav"}')
    fireEvent.error(document.querySelector('audio')!)
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't load out.wav. The link may have expired.")
  })

  it('loads outputs from the service file host only, and links the rest', () => {
    expanded(POLL, '{"status":"succeeded","output":["https://example.org/b.png"]}')
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByRole('link', { name: 'b.png' })).toHaveAttribute('href', 'https://example.org/b.png')
  })

  it('links an output it cannot draw', () => {
    expanded(POLL, '{"status":"succeeded","output":"https://replicate.delivery/a/mesh.glb"}')
    expect(screen.getByRole('link', { name: 'mesh.glb' })).toHaveAttribute('href', 'https://replicate.delivery/a/mesh.glb')
  })

  it('opens the raw command unchanged on request', () => {
    expanded(POLL, '{"status":"failed","error":"boom"}')
    expect(screen.getByTestId('media-call-status')).toHaveTextContent('Failed')
    fireEvent.click(screen.getByRole('button', { name: 'Show raw command' }))
    expect(screen.getByTestId('bash-terminal')).toHaveTextContent(POLL)
  })

  it('puts the first image output on the collapsed row, and nothing for other outputs', () => {
    const thumb = (result: string) => {
      const input = { command: POLL }
      const CollapsedContent = getToolRenderer('Bash', input)!.CollapsedContent!
      return render(<CollapsedContent input={input} result={result} isError={false} />).container
    }
    expect(thumb('{"status":"succeeded","output":["https://replicate.delivery/a/0.png"]}').querySelector('img')?.getAttribute('src')).toBe('https://replicate.delivery/a/0.png')
    expect(thumb('{"status":"succeeded","output":"https://replicate.delivery/a/out.mp4"}').innerHTML).toBe('')
    expect(thumb('{"status":"processing"}').innerHTML).toBe('')
  })

  it('shows a failed job from a command that exited with an error', () => {
    expanded(POLL, '{"id":"p1","status":"starting"}\n{"id":"p1","status":"failed","error":"NSFW"}', true)
    expect(screen.getByTestId('media-call-status')).toHaveTextContent('Failed')
  })

  it.each([
    ['errored', 'curl: (6) Could not resolve host', true],
    ['proved nothing', '"p1"', false],
  ])('keeps the terminal for a call that %s', (_case, result, isError) => {
    expanded(POLL, result, isError)
    expect(screen.getByTestId('bash-terminal')).toBeInTheDocument()
    expect(screen.queryByTestId('media-call')).toBeNull()
  })
})
