// Render tracking instrumentation — only loaded when __RENDER_TRACKING__ is true.
// Must be imported BEFORE any React component code runs.

import React from 'react'
import whyDidYouRender from '@welldone-software/why-did-you-render'
import { _setRenderTracker } from './perf'

// Initialize why-did-you-render
whyDidYouRender(React, {
  trackAllPureComponents: false,
  logOnDifferentValues: false,
  trackHooks: true,
})

// Quantitative render counter
interface RenderEntry {
  count: number
  timestamps: number[]
}

const renderData = new Map<string, RenderEntry>()

declare global {
  interface Window {
    __RENDER_DATA__: {
      get: (name: string) => RenderEntry | undefined
      getAll: () => Record<string, RenderEntry>
      reset: () => void
      snapshot: () => Record<string, RenderEntry>
    }
  }
}

window.__RENDER_DATA__ = {
  get: (name: string) => renderData.get(name),
  getAll: () => Object.fromEntries(renderData),
  reset: () => renderData.clear(),
  snapshot: () => {
    const snap = Object.fromEntries(renderData)
    renderData.clear()
    return snap
  },
}

function realUseRenderTracker(componentName: string): void {
  const entry = renderData.get(componentName)
  if (entry) {
    entry.count++
    entry.timestamps.push(Date.now())
  } else {
    renderData.set(componentName, { count: 1, timestamps: [Date.now()] })
  }
}

_setRenderTracker(realUseRenderTracker)
