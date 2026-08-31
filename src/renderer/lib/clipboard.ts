/**
 * Browsers only honour a clipboard write while the user gesture that triggered
 * it is still "live", and awaiting a fetch first spends that gesture — Safari
 * then rejects the write with a NotAllowedError. Callers that already hold the
 * text use `copyTextToClipboard`; callers that must load it first use
 * `copyLazyTextToClipboard`, which hands the pending text to `ClipboardItem` as
 * a promise so the gesture survives the round trip.
 */

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  copyViaSelection(text)
}

export async function copyLazyTextToClipboard(loadText: () => Promise<string>): Promise<void> {
  const pending = loadText()

  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    const blob = pending.then(text => new Blob([text], { type: 'text/plain' }))
    // An engine that rejects the ClipboardItem never consumes this blob, so its
    // rejection would surface as an unhandled one. `pending` is re-awaited below,
    // which is where the failure actually gets reported.
    blob.catch(() => {})

    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })])
      return
    } catch {
      // Promise-valued ClipboardItem is a recent addition; older engines reject
      // it outright. Retrying below also re-surfaces a `loadText` failure with
      // its original message instead of the clipboard's generic one.
    }
  }

  await copyTextToClipboard(await pending)
}

/**
 * navigator.clipboard is undefined outside secure contexts, which is where a
 * self-hosted workspace served over plain HTTP lands.
 */
function copyViaSelection(text: string): void {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  try {
    textarea.select()
    if (!document.execCommand('copy')) {
      throw new Error('The browser blocked the clipboard write')
    }
  } finally {
    textarea.remove()
  }
}
