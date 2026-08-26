// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { mockUseSortable, mockUseDroppable, mockDefaultKeyframes } = vi.hoisted(() => ({
  mockUseSortable: vi.fn(),
  mockUseDroppable: vi.fn(),
  mockDefaultKeyframes: vi.fn(() => [] as Keyframe[]),
}))

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: (args: unknown) => mockUseSortable(args),
}))
vi.mock('@dnd-kit/core', () => ({
  useDroppable: (args: unknown) => mockUseDroppable(args),
  defaultDropAnimation: { duration: 250, easing: 'ease', keyframes: mockDefaultKeyframes },
}))
vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: (t: { x: number; y: number; scaleX: number; scaleY: number } | null) =>
        t ? `translate3d(${t.x}px, ${t.y}px, 0) scaleX(${t.scaleX}) scaleY(${t.scaleY})` : '',
    },
  },
}))

// Radix context menus never open in jsdom without a real pointer; render the
// items inline so the folder actions are reachable.
vi.mock('@renderer/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...props}>{children}</button>
  ),
}))

vi.mock('@renderer/components/ui/sidebar', () => ({
  SidebarMenuButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

import { AgentDragOverlayRow, AgentFolderBlock, overlayDropKeyframes } from './agent-folder-block'
import type { DropAnimationKeyframeResolver } from '@dnd-kit/core'

const FOLDER = { id: 'f1', name: 'Work' }

/**
 * Stand in for dnd-kit's useSortable, reproducing the one behaviour this block
 * has to work around: the real hook puts `aria-disabled` into `attributes`
 * whenever the sortable is disabled.
 */
const nodes: { sortable: Element | null; activator: Element | null } = {
  sortable: null,
  activator: null,
}

function sortableState(args: { disabled?: boolean } | undefined, isOver = false) {
  return {
    attributes: { role: 'button', 'aria-disabled': !!args?.disabled },
    listeners: {},
    setNodeRef: (el: Element | null) => { nodes.sortable = el ?? nodes.sortable },
    setActivatorNodeRef: (el: Element | null) => { nodes.activator = el ?? nodes.activator },
    transform: null,
    transition: null,
    isDragging: false,
    isOver,
  }
}

function renderBlock(overrides: Partial<React.ComponentProps<typeof AgentFolderBlock>> = {}) {
  const props = {
    folder: FOLDER,
    agentCount: 2,
    isCollapsed: false,
    activeDragType: null,
    onToggle: vi.fn(),
    onRename: vi.fn(),
    onRenameEnd: vi.fn(),
    onDelete: vi.fn(),
    children: <li data-testid="member-row">member</li>,
    ...overrides,
  }
  render(<ul><AgentFolderBlock {...props} /></ul>)
  return props
}

beforeEach(() => {
  vi.clearAllMocks()
  nodes.sortable = null
  nodes.activator = null
  mockUseSortable.mockImplementation((args) => sortableState(args))
  mockUseDroppable.mockReturnValue({ setNodeRef: vi.fn(), isOver: false })
})

afterEach(cleanup)

describe('AgentFolderBlock', () => {
  it('shows the folder name and how many agents it holds', () => {
    renderBlock()
    const row = screen.getByTestId('agent-folder-f1')
    expect(row).toHaveTextContent('Work')
    expect(row).toHaveTextContent('2')
  })

  it('reveals the chevron only on hover, in the count’s slot', () => {
    // The header reads as a section label at rest (name + count, no icon);
    // hovering swaps the count for the expand/collapse affordance.
    renderBlock()
    expect(screen.getByTestId('agent-folder-count-f1').className).toContain(
      'group-hover/folder-header:hidden'
    )
    const chevron = screen.getByTestId('agent-folder-chevron-f1')
    expect(chevron.getAttribute('class')).toContain('hidden')
    expect(chevron.getAttribute('class')).toContain('group-hover/folder-header:block')
  })

  it('points the chevron down while expanded and right while collapsed', () => {
    renderBlock({ isCollapsed: false })
    expect(screen.getByTestId('agent-folder-chevron-f1').getAttribute('class')).toContain('rotate-90')
    cleanup()
    renderBlock({ isCollapsed: true })
    expect(screen.getByTestId('agent-folder-chevron-f1').getAttribute('class')).not.toContain('rotate-90')
  })

  it('renders its agents nested inside the block', () => {
    renderBlock()
    expect(screen.getByTestId('member-row')).toBeInTheDocument()
  })

  it('keeps the whole block one list item so the top level stays contiguous', () => {
    // The top-level sorting strategy measures a list of siblings. If a folder's
    // header and body were separate items, the rows in between would throw its
    // measurements off and a folder could not be dropped between two agents.
    renderBlock()
    const top = document.querySelector('ul')!
    expect(top.children).toHaveLength(1)
    expect(top.children[0].tagName).toBe('LI')
    expect(document.querySelector('ul > li > div > ul > li')).not.toBeNull()
  })

  it('identifies itself to the drag layer as a folder', () => {
    renderBlock()
    expect(mockUseSortable).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'agent-folder::f1', data: { type: 'folder', folderId: 'f1' } })
    )
  })

  it('puts the drag handle on the header, not the whole block', () => {
    // The block is the measured node so the top level sorts correctly, but only
    // the header listens — otherwise starting a drag on a member row would
    // start the folder's drag too.
    renderBlock()

    expect(nodes.sortable?.tagName).toBe('LI')
    expect(nodes.activator?.tagName).toBe('DIV')
    expect(nodes.sortable?.contains(nodes.activator!)).toBe(true)
    expect(nodes.activator?.contains(screen.getByTestId('member-row'))).toBe(false)
  })

  it('registers its body as a drop target of its own', () => {
    renderBlock()
    expect(mockUseDroppable).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'agent-section::f1' })
    )
  })

  it('reports its expanded state to assistive tech', () => {
    renderBlock({ isCollapsed: true })
    expect(screen.getByTestId('agent-folder-f1')).toHaveAttribute('aria-expanded', 'false')
  })

  it('hides its agents when collapsed but keeps them mounted', () => {
    // Unmounting made expanding a large folder a visible hitch; the rows stay
    // alive and the body hides via the `hidden` attribute.
    renderBlock({ isCollapsed: true })
    expect(screen.getByTestId('member-row')).not.toBeVisible()
  })

  it('disables the body drop target while collapsed', () => {
    // A display:none body measures as a phantom rect at the viewport origin.
    renderBlock({ isCollapsed: true })
    expect(mockUseDroppable).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'agent-section::f1', disabled: true })
    )
  })

  it('toggles on click', async () => {
    const props = renderBlock()
    await userEvent.click(screen.getByTestId('agent-folder-f1'))
    expect(props.onToggle).toHaveBeenCalledTimes(1)
  })

  it('invites a drop when it holds nothing', () => {
    renderBlock({ agentCount: 0, children: null })
    expect(screen.getByTestId('agent-folder-empty-f1')).toBeInTheDocument()
  })

  it('shows no placeholder once it holds something', () => {
    renderBlock()
    expect(screen.queryByTestId('agent-folder-empty-f1')).not.toBeInTheDocument()
  })

  it('renames on Enter', async () => {
    const props = renderBlock()
    await userEvent.click(screen.getByTestId('rename-folder-item'))
    const input = screen.getByTestId('folder-name-input')
    await userEvent.clear(input)
    await userEvent.type(input, 'Clients{Enter}')

    expect(props.onRename).toHaveBeenCalledWith('Clients')
    expect(props.onRenameEnd).toHaveBeenCalled()
  })

  it('abandons a rename on Escape', async () => {
    const props = renderBlock()
    await userEvent.click(screen.getByTestId('rename-folder-item'))
    const input = screen.getByTestId('folder-name-input')
    await userEvent.clear(input)
    await userEvent.type(input, 'Clients{Escape}')

    expect(props.onRename).not.toHaveBeenCalled()
    expect(screen.queryByTestId('folder-name-input')).not.toBeInTheDocument()
  })

  it('commits a rename on blur, the way the dashboard rename does', async () => {
    const props = renderBlock()
    await userEvent.click(screen.getByTestId('rename-folder-item'))
    const input = screen.getByTestId('folder-name-input')
    await userEvent.clear(input)
    await userEvent.type(input, 'Clients')
    await userEvent.tab()

    expect(props.onRename).toHaveBeenCalledWith('Clients')
  })

  it('does not write a rename that only adds whitespace', async () => {
    const props = renderBlock()
    await userEvent.click(screen.getByTestId('rename-folder-item'))
    await userEvent.type(screen.getByTestId('folder-name-input'), '   {Enter}')

    expect(props.onRename).not.toHaveBeenCalled()
    expect(props.onRenameEnd).toHaveBeenCalled()
  })

  it('does not write a rename that changes nothing', async () => {
    const props = renderBlock()
    await userEvent.click(screen.getByTestId('rename-folder-item'))
    await userEvent.type(screen.getByTestId('folder-name-input'), '{Enter}')

    expect(props.onRename).not.toHaveBeenCalled()
  })

  it('commits a rename exactly once when Enter is followed by the blur it causes', async () => {
    const props = renderBlock()
    await userEvent.click(screen.getByTestId('rename-folder-item'))
    const input = screen.getByTestId('folder-name-input')
    await userEvent.clear(input)
    await userEvent.type(input, 'Clients{Enter}')
    await userEvent.tab()

    expect(props.onRename).toHaveBeenCalledTimes(1)
  })

  it('swaps the header out for the input rather than nesting one inside a button', async () => {
    // A form control inside a <button> is invalid markup, and the click that
    // should place the caret lands on the button instead.
    renderBlock()
    await userEvent.click(screen.getByTestId('rename-folder-item'))

    expect(screen.queryByTestId('agent-folder-f1')).not.toBeInTheDocument()
    expect(screen.getByTestId('folder-name-input').closest('button')).toBeNull()
  })

  it('strips the aria-disabled flag dnd-kit stamps into its attributes', () => {
    // dnd-kit ALWAYS includes `aria-disabled` in `attributes` — `false` at
    // rest — and React renders boolean aria-* values as literal strings, so
    // spreading it unstripped would put aria-disabled="false" on every header
    // (and "true" on any future layout that renders the carrier while the
    // sortable is disabled). Asserting at rest keeps this falsifiable: while
    // renaming, the carrier is not rendered at all, so nothing could match.
    renderBlock()

    expect(document.querySelector('[aria-disabled]')).toBeNull()
  })

  it('suspends the drag while a rename is open', async () => {
    renderBlock()
    await userEvent.click(screen.getByTestId('rename-folder-item'))

    expect(mockUseSortable).toHaveBeenLastCalledWith(expect.objectContaining({ disabled: true }))
  })

  it('opens straight into rename mode for a freshly created folder', () => {
    renderBlock({ initialRenaming: true })
    expect(screen.getByTestId('folder-name-input')).toBeInTheDocument()
  })

  it('deletes on request', async () => {
    const props = renderBlock()
    await userEvent.click(screen.getByTestId('delete-folder-item'))
    expect(props.onDelete).toHaveBeenCalledTimes(1)
  })

  it('highlights as a drop target when an agent is dragged over it', () => {
    mockUseSortable.mockImplementation((args) => sortableState(args, true))
    renderBlock({ activeDragType: 'agent' })
    expect(screen.getByTestId('agent-folder-f1').className).toContain('ring-1')
  })

  it('draws the insert line on the edge the drop will use', () => {
    // Folders do not nest — a folder over a folder is a reorder. The line and
    // the drop read the same cue, so above means above and below means below.
    renderBlock({ activeDragType: 'folder', insertEdge: 'above' })
    const above = screen.getByTestId('folder-insert-indicator-f1')
    expect(above).toHaveAttribute('data-edge', 'above')
    expect(above.className).toContain('-top-0.5')
    cleanup()

    renderBlock({ activeDragType: 'folder', insertEdge: 'below' })
    const below = screen.getByTestId('folder-insert-indicator-f1')
    expect(below).toHaveAttribute('data-edge', 'below')
    expect(below.className).toContain('-bottom-0.5')
  })

  it('shows no insert line without a cue, and no drop-target fill for folders', () => {
    mockUseSortable.mockImplementation((args) => sortableState(args, true))
    renderBlock({ activeDragType: 'folder' })
    expect(screen.queryByTestId('folder-insert-indicator-f1')).not.toBeInTheDocument()
    expect(screen.getByTestId('agent-folder-f1').className).not.toContain('ring-1')
  })
})

describe('AgentFolderBlock — the default folder', () => {
  function renderRoot(overrides: Partial<React.ComponentProps<typeof AgentFolderBlock>> = {}) {
    const props = {
      folder: { id: 'root', name: 'Your Agents' },
      isRoot: true,
      agentCount: 2,
      isCollapsed: false,
      activeDragType: null,
      onToggle: vi.fn(),
      onRename: vi.fn(),
      onRenameEnd: vi.fn(),
      onDelete: vi.fn(),
      onCreateFolder: vi.fn(),
      children: <li data-testid="member-row">member</li>,
      ...overrides,
    } satisfies React.ComponentProps<typeof AgentFolderBlock>
    render(<ul><AgentFolderBlock {...props} /></ul>)
    return props
  }

  it('renders like any folder header', () => {
    renderRoot()
    const row = screen.getByTestId('agent-folder-root')
    expect(row).toHaveTextContent('Your Agents')
    expect(row).toHaveTextContent('2')
  })

  it('offers no rename or delete — it is the fallback bucket', () => {
    renderRoot()
    expect(screen.queryByTestId('rename-folder-item')).not.toBeInTheDocument()
    expect(screen.queryByTestId('delete-folder-item')).not.toBeInTheDocument()
  })

  it('hosts the new-folder button', async () => {
    const props = renderRoot()
    await userEvent.click(screen.getByTestId('new-folder-button'))
    expect(props.onCreateFolder).toHaveBeenCalledTimes(1)
  })

  it('keeps the new-folder button outside the header button', () => {
    // A button cannot nest inside a button, and pressing + must not begin the
    // folder's drag — so it overlays as a sibling of the drag activator.
    renderRoot()
    const plus = screen.getByTestId('new-folder-button')
    expect(plus.closest('button')).toBe(plus)
    expect(screen.getByTestId('agent-folder-root').contains(plus)).toBe(false)
  })

  it('does not render the new-folder button on ordinary folders', () => {
    renderBlock()
    expect(screen.queryByTestId('new-folder-button')).not.toBeInTheDocument()
  })

  it('still collapses like any folder', async () => {
    const props = renderRoot()
    await userEvent.click(screen.getByTestId('agent-folder-root'))
    expect(props.onToggle).toHaveBeenCalledTimes(1)
  })

  it('identifies itself to the drag layer as a folder, so it can be reordered', () => {
    renderRoot()
    expect(mockUseSortable).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'agent-folder::root', data: { type: 'folder', folderId: 'root' } })
    )
  })
})

describe('AgentDragOverlayRow', () => {
  it('names what is being dragged', () => {
    render(<AgentDragOverlayRow label="Sales" isFolder={false} />)
    expect(screen.getByText('Sales')).toBeInTheDocument()
  })
})

describe('overlayDropKeyframes', () => {
  const RECT = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }

  function dropParams(activeRect: Partial<typeof RECT>) {
    return {
      active: { id: 'a1', data: { current: undefined }, node: document.createElement('div'), rect: { ...RECT, ...activeRect } },
      dragOverlay: { node: document.createElement('div'), rect: { ...RECT, top: 530, left: 17, width: 240, height: 36 } },
      draggableNodes: new Map(),
      droppableContainers: new Map(),
      measuringConfiguration: {},
      transform: {
        initial: { x: 4, y: 260, scaleX: 1, scaleY: 1 },
        final: { x: -13, y: -530, scaleX: 1, scaleY: 1 },
      },
    } as unknown as Parameters<DropAnimationKeyframeResolver>[0]
  }

  it('fades out where it was dropped when the landing spot is hidden', () => {
    // A row filed into a collapsed folder sits in the folder's hidden body,
    // which measures 0×0 at the viewport origin — the default keyframes
    // would fly the overlay to the window's top-left corner.
    const frames = overlayDropKeyframes(dropParams({ width: 0, height: 0 }))
    expect(frames).toHaveLength(2)
    expect(frames[1].transform).toBe(frames[0].transform)
    expect(frames[0].transform).toContain('translate3d(4px, 260px')
    expect(frames[0].opacity).toBe(1)
    expect(frames[1].opacity).toBe(0)
    expect(mockDefaultKeyframes).not.toHaveBeenCalled()
  })

  it('keeps the stock flight to a visible landing spot', () => {
    const stockFrames = [{ transform: 'from' }, { transform: 'to' }]
    mockDefaultKeyframes.mockReturnValueOnce(stockFrames)
    const params = dropParams({ width: 240, height: 32, top: 700, left: 17 })
    expect(overlayDropKeyframes(params)).toBe(stockFrames)
    expect(mockDefaultKeyframes).toHaveBeenCalledWith(params)
  })
})
