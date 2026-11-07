// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReactFlow, ReactFlowProvider, type Node, type ReactFlowInstance } from '@xyflow/react'

// These exercise the installed library, including its actual store and effects.
// Only DOM measurements/observation are supplied because jsdom has no layout.
const observed = new Set<Set<Element>>()

beforeEach(() => {
  observed.clear()
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>()
    constructor() { observed.add(this.targets) }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fixtureNodes(): Node[] {
  return [
    { id: 'agent:a', position: { x: 0, y: 0 }, width: 150, height: 80, selected: false, data: { label: 'Agent A' } },
    { id: 'agent:b', position: { x: 300, y: 0 }, width: 150, height: 80, selected: false, data: { label: 'Agent B' } },
  ]
}

describe('XYFlow contracts used by the home graph', () => {
  it('releases every observed graph element after repeated StrictMode mounts', () => {
    for (let mount = 0; mount < 3; mount++) {
      const view = render(<StrictMode><ReactFlow nodes={fixtureNodes()} /></StrictMode>)
      expect([...observed].some((targets) => targets.size > 0)).toBe(true)
      view.unmount()
      expect([...observed].flatMap((targets) => [...targets])).toEqual([])
    }
  })

  it('keeps controlled selection unchanged until the caller applies the emitted change', async () => {
    let instance: ReactFlowInstance | undefined
    const changes = vi.fn()
    const nodes = fixtureNodes()
    const onInit = (value: ReactFlowInstance) => { instance = value }
    const view = render(<ReactFlow nodes={nodes} onNodesChange={changes} onInit={onInit} />)
    await waitFor(() => expect(instance).toBeDefined())
    const node = view.container.querySelector('[data-id="agent:a"]')!

    fireEvent.click(node)
    expect(changes).toHaveBeenCalledWith([{ id: 'agent:a', type: 'select', selected: true }])
    expect(instance!.getInternalNode('agent:a')?.selected).toBe(false)
    expect(nodes[0].selected).toBe(false)
    expect(node).not.toHaveClass('selected')

    // An async/controlled consumer can accept the change on a later render.
    const selectedNodes = nodes.map((value) => value.id === 'agent:a' ? { ...value, selected: true } : value)
    view.rerender(<ReactFlow nodes={selectedNodes} onNodesChange={changes} onInit={onInit} />)
    expect(node).toHaveClass('selected')
    changes.mockClear()
    fireEvent.click(view.container.querySelector('.react-flow__pane')!)
    expect(changes).toHaveBeenCalledWith([{ id: 'agent:a', type: 'select', selected: false }])
    expect(instance!.getInternalNode('agent:a')?.selected).toBe(true)
    expect(selectedNodes[0].selected).toBe(true)
    expect(node).toHaveClass('selected')
  })

  it('does not retain callbacks from a flow that unmounted inside a retained provider', async () => {
    let instance: ReactFlowInstance | undefined
    const oldDelete = vi.fn()
    const onInit = (value: ReactFlowInstance) => { instance = value }
    const view = render(
      <ReactFlowProvider><ReactFlow defaultNodes={fixtureNodes()} onNodesDelete={oldDelete} onInit={onInit} /></ReactFlowProvider>,
    )
    await waitFor(() => expect(instance).toBeDefined())
    view.rerender(<ReactFlowProvider>{null}</ReactFlowProvider>)
    instance = undefined
    view.rerender(<ReactFlowProvider><ReactFlow defaultNodes={fixtureNodes()} onInit={onInit} /></ReactFlowProvider>)
    await waitFor(() => expect(instance).toBeDefined())
    await act(async () => { await instance!.deleteElements({ nodes: [{ id: 'agent:a' }] }) })
    expect(instance!.getNodes().map((node) => node.id)).toEqual(['agent:b'])
    expect(oldDelete).not.toHaveBeenCalled()
  })
})
