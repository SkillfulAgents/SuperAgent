// @vitest-environment jsdom
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  MarkdownComposerEditor,
  setMarkdownComposerSelection,
} from './markdown-composer-editor'
import { formatChipMarker } from './chip-marker'
import { rewriteChipsForSend } from './composer-chips'
import { findPotentialSecrets } from '@renderer/lib/secret-detection'

const EMPTY_KNOWN_SECRETS: ReadonlyMap<string, string> = new Map()

function ControlledEditor({
  initialValue = '',
  knownSecrets = EMPTY_KNOWN_SECRETS,
}: {
  initialValue?: string
  knownSecrets?: ReadonlyMap<string, string>
}) {
  const [value, setValue] = useState(initialValue)
  return (
    <>
      <MarkdownComposerEditor
        value={value}
        onChange={setValue}
        placeholder="Write a message"
        dataTestId="markdown-editor"
        knownSecrets={knownSecrets}
      />
      <output data-testid="markdown-value">{value}</output>
    </>
  )
}

describe('MarkdownComposerEditor', () => {
  it('preserves headings and links containing chips through editing', async () => {
    const user = userEvent.setup()
    const marker = formatChipMarker('secret', 'API_KEY', 'My Key')
    render(<ControlledEditor initialValue={`## Deploy ${marker}\n\n[see ${marker}](https://x.com)`} knownSecrets={new Map([['API_KEY', 'My Key']])} />)
    const editor = screen.getByTestId('markdown-editor')
    expect(editor.querySelector('h2 [data-testid="secured-secret"]')).toBeInTheDocument()
    expect(editor.querySelector('a [data-testid="secured-secret"]')).toBeInTheDocument()
    expect(editor.querySelector('a')).toHaveAttribute('href', 'https://x.com')
    await user.type(editor, 'x')
    expect(screen.getByTestId('markdown-value').textContent).toContain(`## Deploy ${marker}`)
    expect(editor.querySelector('a')).toHaveAttribute('href', 'https://x.com')
  })

  it('synchronizes a restored escaped chip before sending without another keystroke', () => {
    const known = new Map([['API_KEY', 'My Key']])
    const escaped = '\\[\\[secret:API_KEY|My%20Key\\]\\]'
    render(<ControlledEditor initialValue={`- _Use_ ${escaped}\n\n\`${escaped}\``} knownSecrets={known} />)
    expect(screen.getByTestId('secured-secret')).toBeInTheDocument()
    expect(rewriteChipsForSend(screen.getByTestId('markdown-value').textContent ?? '', known)).toBe(`- _Use_ [Key saved to .env - API_KEY]\n\n\`${escaped}\``)
  })

  it('preserves draft formatting when saved keys arrive or disappear', () => {
    const escaped = '\\[\\[secret:API_KEY|My%20Key\\]\\]'
    const initialValue = `- _Use_ ${escaped}`
    const { rerender } = render(<ControlledEditor initialValue={initialValue} />)
    rerender(<ControlledEditor initialValue={initialValue} knownSecrets={new Map([['API_KEY', 'My Key']])} />)
    expect(screen.getByTestId('secured-secret')).toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe('- _Use_ [[secret:API_KEY|My%20Key]]')
    rerender(<ControlledEditor initialValue={initialValue} knownSecrets={new Map()} />)
    expect(screen.queryByTestId('secured-secret')).not.toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe('- _Use_ [[secret:API_KEY|My%20Key]]')
  })

  it('keeps redo and undo atomic after a pasted chip loses its backing key', () => {
    const marker = formatChipMarker('secret', 'API_KEY', 'My Key')
    const { rerender } = render(<ControlledEditor knownSecrets={new Map([['API_KEY', 'My Key']])} />)
    const editor = screen.getByTestId('markdown-editor')
    fireEvent.paste(editor, { clipboardData: { getData: () => marker, items: [] } })
    fireEvent.keyDown(editor, { key: 'z', keyCode: 90, ctrlKey: true })
    expect(editor.textContent).toBe('')
    rerender(<ControlledEditor knownSecrets={new Map()} />)
    fireEvent.keyDown(editor, { key: 'z', keyCode: 90, ctrlKey: true, shiftKey: true })
    expect(editor.textContent).toBe(marker)
    expect(screen.queryByTestId('secured-secret')).not.toBeInTheDocument()
    fireEvent.keyDown(editor, { key: 'z', keyCode: 90, ctrlKey: true })
    expect(editor.textContent).toBe('')
  })

  it('closes a heading before inserting a soft break', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initialValue="## Deploy" />)
    const editor = screen.getByTestId('markdown-editor')
    await user.click(editor)
    await user.keyboard('{Shift>}{Enter}{/Shift}next')
    expect(editor.querySelector('h2')).toHaveTextContent(/^Deploy$/)
    expect(editor.querySelector('p')).toHaveTextContent('next')
  })

  it('demotes chips when keys disappear and keeps the reference for later recovery', async () => {
    const user = userEvent.setup()
    const marker = formatChipMarker('secret', 'API_KEY', 'My Key')
    const known = new Map([['API_KEY', 'My Key']])
    const { rerender } = render(<ControlledEditor initialValue={marker} knownSecrets={known} />)
    rerender(<ControlledEditor initialValue={marker} knownSecrets={new Map()} />)
    expect(screen.queryByTestId('secured-secret')).not.toBeInTheDocument()
    expect(screen.getByTestId('markdown-editor')).toHaveTextContent(marker)
    await user.type(screen.getByTestId('markdown-editor'), 'x')
    fireEvent.keyDown(screen.getByTestId('markdown-editor'), { key: 'z', keyCode: 90, ctrlKey: true })
    expect(screen.queryByTestId('secured-secret')).not.toBeInTheDocument()
    rerender(<ControlledEditor initialValue={marker} knownSecrets={known} />)
    expect(screen.getByTestId('secured-secret')).toBeInTheDocument()
    expect(rewriteChipsForSend(screen.getByTestId('markdown-value').textContent ?? '', known)).toContain('[Key saved to .env - API_KEY]')
  })

  it('retains raw references from an HTML chip belonging to another agent', () => {
    const marker = formatChipMarker('secret', 'API_KEY', 'My Key')
    const { rerender } = render(<ControlledEditor />)
    fireEvent.paste(screen.getByTestId('markdown-editor'), {
      clipboardData: {
        getData: (type: string) => type === 'text/html' ? `<span data-chip-kind="secret" data-raw="${marker}">[My Key | *********]</span>` : '',
        types: ['text/html'], items: [],
      },
    })
    expect(screen.queryByTestId('secured-secret')).not.toBeInTheDocument()
    expect(screen.getByTestId('markdown-editor')).toHaveTextContent(marker)
    rerender(<ControlledEditor knownSecrets={new Map([['API_KEY', 'My Key']])} />)
    expect(screen.getByTestId('secured-secret')).toBeInTheDocument()
  })

  it('demotes an unbacked chip re-read from native DOM changes', async () => {
    const marker = formatChipMarker('secret', 'API_KEY', 'My Key')
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')
    const span = document.createElement('span')
    span.dataset.chipKind = 'secret'
    span.dataset.raw = marker
    span.textContent = '[My Key | *********]'
    editor.querySelector('p')!.replaceChildren(span)
    await vi.waitFor(() => {
      expect(editor).toHaveTextContent(marker)
      expect(editor.querySelector('[data-chip-kind]')).toBeNull()
    })
    expect(screen.getByTestId('markdown-value').textContent).toContain('API_KEY')
  })

  it('renders Markdown blocks and inline marks from its controlled value', () => {
    render(<ControlledEditor initialValue={'# Heading\n\n> [docs](https://example.com) with *emphasis* and `code`\n\n**bold** and ~~gone~~\n\n- one\n- two'} />)

    const editor = screen.getByTestId('markdown-editor')
    expect(editor.querySelector('h1')).toHaveTextContent('Heading')
    expect(editor.querySelector('blockquote')).toHaveTextContent('docs with emphasis and code')
    expect(editor.querySelector('a')).toHaveAttribute('href', 'https://example.com')
    expect(editor.querySelector('em')).toHaveTextContent('emphasis')
    expect(editor.querySelector('code')).toHaveTextContent('code')
    expect(editor.querySelector('strong')).toHaveTextContent('bold')
    expect(editor.querySelector('s')).toHaveTextContent('gone')
    expect(editor.querySelectorAll('li')).toHaveLength(2)
  })

  it('lets an explicit minimum height override the row-based fallback', () => {
    render(
      <MarkdownComposerEditor
        value=""
        onChange={() => {}}
        placeholder="Write a message"
        dataTestId="markdown-editor"
        minRows={2}
        className="min-h-[50vh]"
      />
    )

    const editor = screen.getByTestId('markdown-editor')
    expect(editor.style.minHeight).toBe('')
    expect(editor.style.getPropertyValue('--composer-min-height')).toBe('40px')
    expect(editor.className).toContain('min-h-[50vh]')
    expect(editor.className).not.toContain('min-h-[var(--composer-min-height)]')
  })

  it('turns typed Markdown tokens into rich text while retaining Markdown output', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, '**important**')

    expect(editor.querySelector('strong')).toHaveTextContent('important')
    expect(editor.textContent).toBe('important')
    expect(screen.getByTestId('markdown-value').textContent).toBe('**important**')
  })

  it('keeps Cmd/Ctrl+B inside the editor while applying bold', async () => {
    const user = userEvent.setup()
    const onWindowKeyDown = vi.fn()
    window.addEventListener('keydown', onWindowKeyDown)

    try {
      render(<ControlledEditor />)
      const editor = screen.getByTestId('markdown-editor')

      fireEvent.keyDown(editor, { key: 'b', metaKey: true })
      fireEvent.keyDown(editor, { key: 'b', ctrlKey: true })

      expect(onWindowKeyDown).not.toHaveBeenCalled()
      await user.type(editor, 'bold')
      expect(editor.querySelector('strong')).toHaveTextContent('bold')
    } finally {
      window.removeEventListener('keydown', onWindowKeyDown)
    }
  })

  it('does not interpret intraword underscores inside a typed secret', async () => {
    const user = userEvent.setup()
    const token = 'github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, token)

    expect(editor.querySelector('em')).not.toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe(token)
    expect(findPotentialSecrets(token).map((candidate) => candidate.value)).toContain(token)
  })

  it('renders underscore emphasis after a CommonMark boundary', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, '_important_ ')

    expect(editor.querySelector('em')).toHaveTextContent('important')
    expect(screen.getByTestId('markdown-value').textContent).toBe('*important* ')
  })

  it('uses the first Backspace to undo an automatic Markdown transform', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, '**important**')
    await user.keyboard('{Backspace}')

    expect(editor.querySelector('strong')).not.toBeInTheDocument()
    expect(editor.textContent).toBe('**important**')
    expect(screen.getByTestId('markdown-value').textContent).toBe('\\*\\*important\\*\\*')
  })

  it('keeps Enter inside a Markdown list and creates another list item', async () => {
    const user = userEvent.setup()
    const onKeyDown = vi.fn()
    render(
      <MarkdownComposerEditor
        value=""
        onChange={() => {}}
        onKeyDown={onKeyDown}
        placeholder="Write a message"
        dataTestId="markdown-editor"
      />
    )
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, '- one')
    await user.keyboard('{Enter}')

    expect(editor.querySelectorAll('li')).toHaveLength(2)
    expect(onKeyDown).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: 'Enter' }),
      expect.anything()
    )
  })

  it('passes modified Enter to the owning composer from inside a list', async () => {
    const user = userEvent.setup()
    const onKeyDown = vi.fn((event: KeyboardEvent) => {
      if (event.key === 'Enter') event.preventDefault()
    })
    render(
      <MarkdownComposerEditor
        value="- item"
        onChange={() => {}}
        onKeyDown={onKeyDown}
        placeholder="Write a message"
        dataTestId="markdown-editor"
      />
    )
    const editor = screen.getByTestId('markdown-editor')

    await user.click(editor.querySelector('li')!)
    await user.keyboard('{Meta>}{Enter}{/Meta}')

    expect(onKeyDown).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'Enter', metaKey: true }),
      expect.anything()
    )
  })

  it('converts a code fence before an Enter-to-send owner can intercept it', async () => {
    const user = userEvent.setup()
    const onKeyDown = vi.fn((event: KeyboardEvent) => {
      if (event.key === 'Enter') event.preventDefault()
    })
    render(
      <MarkdownComposerEditor
        value=""
        onChange={() => {}}
        onKeyDown={onKeyDown}
        placeholder="Write a message"
        dataTestId="markdown-editor"
      />
    )
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, '```typescript')
    onKeyDown.mockClear()
    await user.keyboard('{Enter}')

    expect(editor.querySelector('pre')).toBeInTheDocument()
    expect(onKeyDown).not.toHaveBeenCalled()
  })

  it('inserts a literal newline with Shift+Enter inside a code block', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, '```typescript')
    await user.keyboard('{Enter}')
    await user.type(editor, 'const first = true')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(editor, 'const second = true')

    expect(editor.querySelector('pre')?.textContent).toBe('const first = true\nconst second = true')
    expect(screen.getByTestId('markdown-value').textContent).toBe(
      '```typescript\nconst first = true\nconst second = true\n```'
    )
  })

  it('starts and continues a list after soft line breaks', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, 'intro')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(editor, '- first')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(editor, '- second')

    const list = Array.from(editor.children).find((element) => element.tagName === 'UL')
    expect(list?.children).toHaveLength(2)
    expect(list).toHaveTextContent('firstsecond')
    expect(screen.getByTestId('markdown-value').textContent).toBe(
      'intro\n\n* first\n* second'
    )
  })

  it('recognizes a heading and following list entered with soft line breaks', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, 'intro')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(editor, '## Hello')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(editor, '- item')

    expect(editor.querySelector('h2')).toHaveTextContent('Hello')
    expect(editor.querySelector('li')).toHaveTextContent('item')
  })

  it('parses pasted block Markdown into rich document blocks', () => {
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) => type === 'text/plain'
          ? '## Hello\n\n- list item\n- another list item\n\n1. OOL\n2. No listd'
          : '',
        items: [],
      },
    })

    expect(editor.querySelector('h2')).toHaveTextContent('Hello')
    expect(editor.querySelectorAll('ul li')).toHaveLength(2)
    expect(editor.querySelectorAll('ol li')).toHaveLength(2)
    expect(screen.getByTestId('markdown-value').textContent).toBe(
      '## Hello\n\n* list item\n* another list item\n\n1. OOL\n2. No listd'
    )
  })

  it('leaves mixed file and text clipboard data to the attachment owner', () => {
    const onPaste = vi.fn()
    render(
      <div onPaste={onPaste}>
        <ControlledEditor />
      </div>
    )
    const editor = screen.getByTestId('markdown-editor')

    fireEvent.paste(editor, {
      clipboardData: {
        getData: () => '/tmp/copied-file.txt',
        items: [{ kind: 'file', getAsFile: () => new File(['x'], 'copied-file.txt') }],
      },
    })

    expect(onPaste).toHaveBeenCalled()
    expect(screen.getByTestId('markdown-value').textContent).toBe('')
  })

  it('does not discard an image when a block marker follows that leaf', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, 'intro')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(editor, '![[alt](https://example.com/image.png)')
    await user.type(editor, ' - item')

    expect(editor.querySelector('img')).toHaveAttribute('src', 'https://example.com/image.png')
    expect(editor.querySelector('ul')).not.toBeInTheDocument()
    expect(editor).toHaveTextContent('- item')
  })

  it('does not create a DOM link for a disallowed URL scheme', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, '[[unsafe](javascript:alert(1))')

    expect(editor.querySelector('a')).not.toBeInTheDocument()
    expect(editor).toHaveTextContent('[unsafe](javascript:alert(1))')
  })

  it('lifts a secret marker to a pill and serializes the same marker', async () => {
    const user = userEvent.setup()
    const marker = formatChipMarker('secret', 'GITHUB_TOKEN', 'GitHub Token')
    render(<ControlledEditor initialValue={`Use ${marker}`} knownSecrets={new Map([['GITHUB_TOKEN', 'GitHub Token']])} />)
    const editor = screen.getByTestId('markdown-editor')

    expect(screen.getByTestId('secured-secret')).toHaveTextContent('[GitHub Token | *********]')
    expect(setMarkdownComposerSelection(editor, 1)).toBe(true)
    await user.keyboard('x')
    expect(screen.getByTestId('markdown-value').textContent).toBe(`xUse ${marker}`)
  })

  it('lifts a secret marker inside inline code to a pill', async () => {
    const user = userEvent.setup()
    const marker = formatChipMarker('secret', 'API_KEY', 'My Key')
    const { unmount } = render(
      <ControlledEditor initialValue={`\`${marker}\``} knownSecrets={new Map([['API_KEY', 'My Key']])} />
    )
    const editor = screen.getByTestId('markdown-editor')

    expect(editor.querySelector('code [data-testid="secured-secret"]')).toBeInTheDocument()
    expect(setMarkdownComposerSelection(editor, 2)).toBe(true)
    await user.keyboard('x')
    expect(editor.querySelector('code [data-testid="secured-secret"]')).toBeInTheDocument()
    const draft = screen.getByTestId('markdown-value').textContent
    expect(draft).toBe(`\`${marker}x\``)

    unmount()
    render(<ControlledEditor initialValue={draft ?? ''} knownSecrets={new Map([['API_KEY', 'My Key']])} />)
    expect(screen.getByTestId('markdown-editor').querySelector('code [data-testid="secured-secret"]')).toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe(`\`${marker}x\``)
  })

  it('lifts a secret marker inside a fenced block to a pill', async () => {
    const user = userEvent.setup()
    const marker = formatChipMarker('secret', 'API_KEY', 'My Key')
    render(<ControlledEditor initialValue={`\`\`\`\n${marker}\n\`\`\``} knownSecrets={new Map([['API_KEY', 'My Key']])} />)

    expect(screen.getByTestId('secured-secret')).toHaveTextContent('[My Key | *********]')
    expect(setMarkdownComposerSelection(screen.getByTestId('markdown-editor'), 2)).toBe(true)
    await user.keyboard('x')
    expect(screen.getByTestId('markdown-value').textContent).toBe(`\`\`\`\n${marker}x\n\`\`\``)
  })

  it('leaves unknown and incomplete markers as text', async () => {
    const user = userEvent.setup()
    const unknown = formatChipMarker('foo', 'bar', 'baz')
    const incomplete = '[[secret:GITHUB_TOKEN'
    render(<ControlledEditor initialValue={`See ${unknown} ${incomplete}`} />)
    const editor = screen.getByTestId('markdown-editor')

    expect(screen.queryByTestId('secured-secret')).not.toBeInTheDocument()
    await user.click(editor)
    await user.type(editor, ' ')
    expect(screen.getByTestId('markdown-value').textContent).toBe(
      'See \\[\\[foo:bar|baz\\]\\] \\[\\[secret:GITHUB_TOKEN '
    )
  })

  it('unescapes a marker in the draft once the agent keys arrive', async () => {
    const user = userEvent.setup()
    const marker = formatChipMarker('secret', 'API_KEY', 'My Key')
    function LateKeys() {
      const [value, setValue] = useState(`Use ${marker}`)
      const [keys, setKeys] = useState<ReadonlyMap<string, string>>(new Map())
      return (
        <>
          <button type="button" onClick={() => setKeys(new Map([['API_KEY', 'My Key']]))}>ready</button>
          <MarkdownComposerEditor
            value={value}
            onChange={setValue}
            placeholder="Write a message"
            dataTestId="markdown-editor"
            knownSecrets={keys}
          />
          <output data-testid="markdown-value">{value}</output>
        </>
      )
    }
    render(<LateKeys />)
    const editor = screen.getByTestId('markdown-editor')
    expect(setMarkdownComposerSelection(editor, 1)).toBe(true)
    await user.keyboard('x')
    expect(screen.getByTestId('markdown-value').textContent).toBe('xUse \\[\\[secret:API_KEY|My%20Key\\]\\]')
    fireEvent.click(screen.getByRole('button', { name: 'ready' }))
    expect(screen.getByTestId('secured-secret')).toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe(`xUse ${marker}`)
    editor.focus()
    await user.keyboard('y')
    expect(screen.getByTestId('markdown-value').textContent).toBe(`xyUse ${marker}`)
    expect(screen.getByTestId('secured-secret')).toBeInTheDocument()
  })

  it('leaves a well-formed secret marker as text when the agent does not have that key', () => {
    const marker = formatChipMarker('secret', 'MISSING', 'Nope')
    render(<ControlledEditor initialValue={`Use ${marker}`} />)

    expect(screen.queryByTestId('secured-secret')).not.toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe(`Use ${marker}`)
  })

  it('pastes a secret marker as a live chip', () => {
    const marker = formatChipMarker('secret', 'GITHUB_TOKEN', 'GitHub Token')
    render(<ControlledEditor knownSecrets={new Map([['GITHUB_TOKEN', 'GitHub Token']])} />)
    const editor = screen.getByTestId('markdown-editor')

    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) => type === 'text/plain' ? marker : '',
        items: [],
      },
    })

    expect(screen.getByTestId('secured-secret')).toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe(marker)
  })

  it('rejects an HTML-only paste whose chip payload is not a marker', () => {
    render(<ControlledEditor knownSecrets={new Map([['GITHUB_TOKEN', 'GitHub Token']])} />)
    const editor = screen.getByTestId('markdown-editor')

    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) => (
          type === 'text/html'
            ? '<span data-chip-kind="secret" data-raw="nope">x</span>'
            : ''
        ),
        types: ['text/html'],
        items: [],
      },
    })

    expect(screen.queryByTestId('secured-secret')).not.toBeInTheDocument()
    expect(editor.textContent).not.toContain('[undefined')
  })

  it('pastes an HTML chip when the marker parses and the agent has that key', () => {
    const marker = formatChipMarker('secret', 'GITHUB_TOKEN', 'GitHub Token')
    render(<ControlledEditor knownSecrets={new Map([['GITHUB_TOKEN', 'GitHub Token']])} />)
    const editor = screen.getByTestId('markdown-editor')

    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) => (
          type === 'text/html'
            ? `<span data-chip-kind="secret" data-raw="${marker}">x</span>`
            : ''
        ),
        types: ['text/html'],
        items: [],
      },
    })

    expect(screen.getByTestId('secured-secret')).toHaveTextContent('[GitHub Token | *********]')
  })

  it('removes a secret pill atomically with Backspace', () => {
    const marker = formatChipMarker('secret', 'TOKEN_ONE', 'Token')
    const before = 'Before '
    render(<ControlledEditor initialValue={`${before}${marker} after`} knownSecrets={new Map([['TOKEN_ONE', 'Token']])} />)
    const editor = screen.getByTestId('markdown-editor')
    // paragraph starts at 1; the atom occupies one position after `before`
    expect(setMarkdownComposerSelection(editor, 1 + before.length + 1)).toBe(true)
    fireEvent.keyDown(editor, { keyCode: 8 })

    expect(screen.queryByTestId('secured-secret')).not.toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe('Before  after')
  })

  it('removes a secret pill atomically with Delete', () => {
    const marker = formatChipMarker('secret', 'TOKEN_ONE', 'Token')
    const before = 'Before '
    render(<ControlledEditor initialValue={`${before}${marker} after`} knownSecrets={new Map([['TOKEN_ONE', 'Token']])} />)
    const editor = screen.getByTestId('markdown-editor')
    expect(setMarkdownComposerSelection(editor, 1 + before.length)).toBe(true)
    fireEvent.keyDown(editor, { keyCode: 46 })

    expect(screen.queryByTestId('secured-secret')).not.toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe('Before  after')
  })

  it('keeps a Shift+Enter line break in the Markdown source', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, 'line one')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(editor, 'line two')

    expect(editor.querySelector('br[data-soft-break="true"]')).toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe('line one\nline two')
  })

  it('removes a trailing soft break with one Backspace', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, 'line one')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(editor.querySelector('br[data-soft-break="true"]')).toBeInTheDocument()

    await user.keyboard('{Backspace}')
    expect(editor.querySelector('br')).not.toBeInTheDocument()
    expect(screen.getByTestId('markdown-value').textContent).toBe('line one')
  })

  it('preserves trailing editing spaces when an external value is inserted', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <MarkdownComposerEditor
        value="/deploy "
        onChange={onChange}
        placeholder="Write a message"
        dataTestId="markdown-editor"
      />
    )
    const editor = screen.getByTestId('markdown-editor')
    expect(editor.textContent).toBe('/deploy ')

    await user.type(editor, 'production')
    expect(onChange).toHaveBeenLastCalledWith('/deploy production')
  })
})
