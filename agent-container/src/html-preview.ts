// The policy and shell an html fence renders in: the app's preview and the
// container's chat render share them. Import-free: the app imports it too.

// Scripts and styles are inline; nothing is fetched, posted, or framed. The app's web font
// would need a network exception a script could leak data through, so text uses the font stack's fallbacks.
// CSP doesn't cover WebRTC, so a script can still reach a STUN host by peer connection.
export const HTML_PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"

/** The document an html fence renders as: the policy and `head` come before authored markup. */
export function htmlPreviewDocument(source: string, scheme: 'light' | 'dark', head: string): string {
  return (
    `<!DOCTYPE html><html data-theme="${scheme}"><head>` +
    `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">` +
    `<meta name="color-scheme" content="${scheme}">` +
    `${head}${source}`
  )
}

/** Base rules that size an html fence's body to its content and set its text like chat prose. */
export function htmlPreviewBodyStyle(fontFamily: string): string {
  return (
    // flow-root keeps child margins inside body, so its height is the content height.
    // Positioned, so absolute content hanging below it (tooltips, legends) counts toward its height.
    'body{display:flow-root;position:relative}' +
    // The frame's height follows its content, so viewport-sized html/body (100vh, 100%) would grow it to the cap.
    'html,body{height:auto!important;min-height:0!important}' +
    "html,body{margin:0;background:transparent;color:hsl(var(--foreground));" +
    // Same size and line height as chat prose (prose-sm).
    `font:14px/1.7142857 ${fontFamily}}`
  )
}
