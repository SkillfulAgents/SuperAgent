import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { OrbAvatar } from '../src/renderer/components/agents/agent-avatar/orb-avatar'
import { DEFAULT_ORBS } from '../src/renderer/components/agents/agent-avatar/avatar-orbs'
import { ORB_SHAPES } from '../src/renderer/components/agents/agent-avatar/orb-shapes'
import type { OrbState } from '../src/renderer/components/agents/agent-avatar/orb-states'

export interface AvatarFixture {
  name: string
  count: number
  state: OrbState
  pointer: 'none' | 'stationary' | 'moving'
  layout: 'sidebar' | 'picker'
  offscreen?: boolean
}

const root = createRoot(document.getElementById('root')!)
const nativeFrame = window.requestAnimationFrame.bind(window)
const getRect = Element.prototype.getBoundingClientRect
const counters = { frames: 0, rectReads: 0 }
let pointerFrame = 0

window.requestAnimationFrame = callback => nativeFrame(time => {
  counters.frames++
  callback(time)
})
Element.prototype.getBoundingClientRect = function () {
  if (this.hasAttribute('data-avatar-orb')) counters.rectReads++
  return getRect.call(this)
}

function mount(fixture: AvatarFixture) {
  const picker = fixture.layout === 'picker'
  flushSync(() => root.render(
    <div id="avatar-region" style={{
      width: picker ? 240 : 260, height: 480, overflow: 'auto',
      transform: fixture.offscreen ? 'translateX(-400px)' : undefined,
      display: picker ? 'grid' : 'block', gridTemplateColumns: 'repeat(4, 1fr)', alignContent: 'start',
    }}>
      {Array.from({ length: fixture.count }, (_, i) => (
        <div key={i} style={{ height: picker ? 54 : 48, paddingLeft: 4, display: 'flex', alignItems: 'center' }}>
          <OrbAvatar
            orb={DEFAULT_ORBS[i % DEFAULT_ORBS.length]}
            shape={ORB_SHAPES[i % ORB_SHAPES.length]}
            diameter={picker ? 37 : 27}
            restingPhi={(i * 37) % 300 - 240}
            state={picker && i === 0 ? 'working' : fixture.state}
            followPointer="#avatar-region"
          />
        </div>
      ))}
    </div>,
  ))
}

function pointer(mode: AvatarFixture['pointer']) {
  cancelAnimationFrame(pointerFrame)
  if (mode === 'none') return
  const move = (time: number) => {
    document.getElementById('avatar-region')!.dispatchEvent(new MouseEvent('pointermove', {
      bubbles: true,
      clientX: mode === 'moving' ? 130 + Math.sin(time / 800) * 100 : 220,
      clientY: mode === 'moving' ? 240 + Math.cos(time / 600) * 200 : 120,
    }))
    // Keep the fixture's input driver out of the component's frame counters.
    if (mode === 'moving') pointerFrame = nativeFrame(move)
  }
  move(performance.now())
}

window.agentAvatarBenchmark = {
  mount,
  pointer,
  reset: () => { counters.frames = 0; counters.rectReads = 0 },
  counters: () => ({ ...counters }),
}

declare global {
  interface Window {
    agentAvatarBenchmark: {
      mount: typeof mount
      pointer: typeof pointer
      reset: () => void
      counters: () => typeof counters
    }
  }
}
