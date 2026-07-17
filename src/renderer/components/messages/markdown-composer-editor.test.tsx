// @vitest-environment jsdom
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  MarkdownComposerEditor,
  selectAllMarkdownComposer,
  setMarkdownComposerSelection,
} from './markdown-composer-editor'
import { findPotentialSecrets, type SecuredSecret } from '@renderer/lib/secret-detection'

function ControlledEditor({ initialValue = '' }: { initialValue?: string }) {
  const [value, setValue] = useState(initialValue)
  return (
    <>
      <MarkdownComposerEditor
        value={value}
        onChange={setValue}
        placeholder="Write a message"
        dataTestId="markdown-editor"
      />
      <output data-testid="markdown-value">{value}</output>
    </>
  )
}

function SecuredEditorHarness({
  initialValue,
  secrets,
  onRemove,
}: {
  initialValue: string
  secrets: SecuredSecret[]
  onRemove: (secrets: SecuredSecret[]) => void
}) {
  const [value, setValue] = useState(initialValue)
  return (
    <>
      <MarkdownComposerEditor
        value={value}
        onChange={setValue}
        placeholder="Write a message"
        dataTestId="markdown-editor"
        securedSecrets={secrets}
        onRemoveSecuredSecrets={onRemove}
      />
      <output data-testid="markdown-value">{value}</output>
    </>
  )
}

describe('MarkdownComposerEditor', () => {
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

  it('turns typed Markdown tokens into rich text while retaining Markdown output', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor />)
    const editor = screen.getByTestId('markdown-editor')

    await user.type(editor, '**important**')

    expect(editor.querySelector('strong')).toHaveTextContent('important')
    expect(editor.textContent).toBe('important')
    expect(screen.getByTestId('markdown-value').textContent).toBe('**important**')
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

  it('deletes the complete selection when it contains a secured pill', async () => {
    const user = userEvent.setup()
    const secret: SecuredSecret = {
      id: 'first',
      key: 'Token',
      envVar: 'TOKEN_ONE',
      displayText: '[Token | *********]',
    }
    const onRemove = vi.fn()
    render(
      <SecuredEditorHarness
        initialValue={`Before ${secret.displayText} after`}
        secrets={[secret]}
        onRemove={onRemove}
      />
    )
    const editor = screen.getByTestId('markdown-editor')

    expect(selectAllMarkdownComposer(editor)).toBe(true)
    await user.keyboard('{Backspace}')

    expect(screen.getByTestId('markdown-value').textContent).toBe('')
    expect(onRemove).toHaveBeenCalledWith([secret])
  })

  it('deletes the selected occurrence when secured pills have identical labels', async () => {
    const user = userEvent.setup()
    const displayText = '[Token | *********]'
    const first: SecuredSecret = { id: 'first', key: 'Token', envVar: 'TOKEN_ONE', displayText }
    const second: SecuredSecret = { id: 'second', key: 'Token', envVar: 'TOKEN_TWO', displayText }
    const value = `A ${displayText} B ${displayText} C`
    const onRemove = vi.fn()
    render(
      <SecuredEditorHarness
        initialValue={value}
        secrets={[first, second]}
        onRemove={onRemove}
      />
    )
    const editor = screen.getByTestId('markdown-editor')
    const secondPillEnd = 1 + value.lastIndexOf(displayText) + displayText.length

    expect(setMarkdownComposerSelection(editor, secondPillEnd)).toBe(true)
    await user.keyboard('{Backspace}')

    expect(screen.getByTestId('markdown-value').textContent).toBe(`A ${displayText} B  C`)
    expect(onRemove).toHaveBeenCalledWith([second])
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
