import type { KeyboardEvent, MouseEvent } from 'react'

export interface OpenableOptions {
  /**
   * Keep the activation off a clickable ancestor. The download pill sits inside
   * a collapsed tool row that expands on click, so opening a file from it must
   * not also expand the call.
   */
  stopPropagation?: boolean
}

export interface OpenableProps {
  role: 'button'
  tabIndex: 0
  onClick: (event: MouseEvent) => void
  onKeyDown: (event: KeyboardEvent) => void
}

/**
 * Button semantics for an element that cannot be a `<button>`.
 *
 * The file surfaces that open the preview drawer — the delivery row, the
 * download pill, a sent message's chip — all wrap content a `<button>` may not
 * contain: a nested Download link, a picture. So each one hand-rolled `role`,
 * `tabIndex` and an Enter/Space handler, and the three copies disagreed about
 * the details that matter.
 *
 * The detail that matters most is the target guard on the key handler. Key
 * events bubble, so without it an Enter pressed on a nested link is
 * `preventDefault()`ed by the row and the link never navigates — which is
 * exactly how Enter on a delivery row's Download button opened the drawer
 * instead of downloading (#945).
 *
 * Clicks are deliberately *not* guarded: a click anywhere inside the row should
 * open it, which is what makes the icon and the name clickable. A nested
 * control opts out by calling `stopPropagation()` on its own click, and that
 * covers the keyboard too, since Enter on a link dispatches one.
 */
export function openableProps(open: () => void, { stopPropagation }: OpenableOptions = {}): OpenableProps {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: (event: MouseEvent) => {
      if (stopPropagation) {
        event.preventDefault()
        event.stopPropagation()
      }
      open()
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.target !== event.currentTarget) return
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      if (stopPropagation) event.stopPropagation()
      open()
    },
  }
}
